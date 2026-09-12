import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';

const servers = new Map();
const execFileAsync = promisify(execFile);

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatDate(value) {
    return value ? new Date(value).toLocaleDateString() : 'Unknown date';
}

function scoreIssue(issue) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    let score = 0;

    if (labels.some((label) => ['bug', 'security', 'critical', 'blocker'].includes(label))) score += 50;
    if (labels.some((label) => ['high priority', 'priority: high', 'urgent'].includes(label))) score += 35;
    if (!issue.assignees.length) score += 20;
    if (issue.updatedAt) {
        const ageInDays = (Date.now() - new Date(issue.updatedAt).getTime()) / 86400000;
        score += Math.max(0, 20 - ageInDays);
    }

    return score;
}

async function getIssues() {
    const { stdout } = await execFileAsync('gh', [
        'issue', 'list', '--state', 'open', '--limit', '50',
        '--json', 'number,title,body,url,labels,updatedAt,createdAt,assignees',
    ]);
    const issues = JSON.parse(stdout);

    return issues
        .map((issue) => ({
            ...issue,
            labels: issue.labels ?? [],
            assignees: issue.assignees ?? [],
            score: scoreIssue({ ...issue, labels: issue.labels ?? [], assignees: issue.assignees ?? [] }),
        }))
        .sort((left, right) => right.score - left.score || new Date(right.updatedAt) - new Date(left.updatedAt));
}

function renderIssueCard(issue, isPriority) {
    const labels = issue.labels.map((label) => `<span class="label">${escapeHtml(label.name)}</span>`).join('');
    const description = issue.body?.trim() || 'No description provided.';
    const reason = isPriority
        ? 'High attention score based on labels, recency, and whether it has an assignee.'
        : 'Queued below the priority triage set based on its current attention score.';

    return `<article class="card">
      <div class="card-heading"><span class="issue-number">#${issue.number}</span><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a></div>
      <div class="labels">${labels || '<span class="muted">No labels</span>'}</div>
      <p>${escapeHtml(description.slice(0, 360))}${description.length > 360 ? '…' : ''}</p>
      <div class="meta">Updated ${escapeHtml(formatDate(issue.updatedAt))} · ${issue.assignees.length ? 'Assigned' : 'Unassigned'}</div>
      ${isPriority ? `<div class="reason"><strong>Why it is here:</strong> ${escapeHtml(reason)}</div>` : ''}
      <button data-testid="add-issue-${issue.number}" data-issue-number="${issue.number}" data-issue-title="${escapeHtml(issue.title)}">Add to current context</button>
    </article>`;
}

function renderHtml(instanceId, issues, errorMessage = '') {
    const priorityIssues = issues.slice(0, 3);
    const remainingIssues = issues.slice(3);
    const error = errorMessage ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>` : '';

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue triage board</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 24px; background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); font: 14px/1.5 var(--font-sans, system-ui, sans-serif); }
      h1, h2 { margin: 0; } h1 { font-size: 24px; } h2 { margin-top: 28px; font-size: 16px; }
      .intro, .muted, .meta { color: var(--text-color-muted, #656d76); }
      .board { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
      .card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--border-color-default, #d0d7de); border-radius: 10px; background: var(--background-color-muted, #f6f8fa); }
      .card-heading { display: flex; gap: 8px; align-items: baseline; } .card-heading a { color: inherit; font-weight: 600; text-decoration: none; } .card-heading a:hover { text-decoration: underline; }
      .issue-number { color: var(--text-color-muted, #656d76); font-family: var(--font-mono, monospace); }
      .labels { display: flex; flex-wrap: wrap; gap: 6px; } .label { padding: 2px 7px; border-radius: 999px; background: var(--background-color-neutral-muted, #ddf4ff); font-size: 12px; }
      p { margin: 0; white-space: pre-wrap; } .reason { padding: 8px; border-left: 3px solid var(--true-color-blue, #0969da); background: var(--background-color-default, #fff); }
      button { align-self: flex-start; border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; padding: 6px 10px; background: var(--background-color-default, #fff); color: inherit; cursor: pointer; }
      button:hover, button:focus-visible { border-color: var(--true-color-blue, #0969da); outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 1px; }
      button:disabled { cursor: wait; opacity: .65; } .success { color: var(--true-color-green, #1a7f37); } .error { padding: 10px; border: 1px solid var(--true-color-red, #cf222e); color: var(--true-color-red, #cf222e); border-radius: 6px; }
    </style>
  </head>
  <body data-instance-id="${escapeHtml(instanceId)}">
    <h1>Issue triage board</h1>
    <p class="intro">Open issues ranked by signals that suggest they need attention now. Select an issue to add it to this session's context.</p>
    ${error}
    <h2>Top three to review now</h2>
    <section class="board" aria-label="Top priority issues">${priorityIssues.length ? priorityIssues.map((issue) => renderIssueCard(issue, true)).join('') : '<p class="muted">No open issues found.</p>'}</section>
    <h2>More open issues</h2>
    <section class="board" aria-label="Remaining open issues">${remainingIssues.length ? remainingIssues.map((issue) => renderIssueCard(issue, false)).join('') : '<p class="muted">No additional open issues.</p>'}</section>
    <script>
      document.querySelectorAll('button[data-issue-number]').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          const originalText = button.textContent;
          button.textContent = 'Adding…';
          try {
            const response = await fetch('/api/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: button.dataset.issueNumber, title: button.dataset.issueTitle }) });
            if (!response.ok) throw new Error(await response.text());
            button.textContent = 'Added to context';
            button.classList.add('success');
          } catch (error) {
            button.disabled = false;
            button.textContent = originalText;
            window.alert('Could not add issue: ' + error.message);
          }
        });
      });
    </script>
  </body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/add') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const issue = JSON.parse(body);
                    if (!/^\d+$/.test(String(issue.number)) || !issue.title) {
                        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Issue number and title are required.');
                        return;
                    }
                    await session.send({ prompt: `Please work on GitHub issue #${issue.number}: ${issue.title}. Start by reviewing the issue and the relevant code, then propose or implement the next steps.` });
                    res.writeHead(204);
                    res.end();
                } catch (error) {
                    session.log(`Failed to add an issue to context: ${error.message}`, { level: 'error' });
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('The issue could not be added to the current context.');
                }
            });
            return;
        }

        getIssues()
            .then((issues) => {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(renderHtml(instanceId, issues));
            })
            .catch((error) => {
                session.log(`Failed to load open issues: ${error.message}`, { level: 'error' });
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderHtml(instanceId, [], 'Open issues could not be loaded. Check that GitHub CLI is authenticated.'));
            });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: 'issue-triage-board',
            displayName: 'Issue triage board',
            description: 'Kanban board that ranks open GitHub issues and adds a selected issue to the current session context.',
            actions: [
                {
                    name: 'add_issue_to_context',
                    description: 'Adds a GitHub issue to the current session context so work can begin immediately.',
                    inputSchema: {
                        type: 'object',
                        properties: { number: { type: 'integer', minimum: 1 }, title: { type: 'string', minLength: 1 } },
                        required: ['number', 'title'],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        await session.send({ prompt: `Please work on GitHub issue #${ctx.input.number}: ${ctx.input.title}. Start by reviewing the issue and the relevant code, then propose or implement the next steps.` });
                        return { added: true, number: ctx.input.number };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: 'Issue triage board', url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
