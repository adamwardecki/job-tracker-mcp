// A thin GitHub REST and GraphQL client for the factory. No retries: the sweep runs every 30 minutes and picks up
// whatever a failed run left behind.

import { branchFor, CI_WORKFLOW_FILE, runTitle, type StageWorkflow, stageWorkflowFile } from './config.ts';
import type { PullSnapshot, RunSnapshot } from './decide.ts';
import { dig, num, rows, runFrom, str } from './json.ts';

export type Gh = { repo: string; call: (method: string, path: string, body?: unknown) => Promise<unknown> };
export type Comment = { id: number; author: string; body: string; at: string };
export type Review = { author: string; body: string; at: string; state: string };

export function client(token: string, repo: string): Gh {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  }
  return { repo, call };
}

async function paged(gh: Gh, path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; ; page++) {
    const batch = rows(await gh.call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const toComment = (r: unknown): Comment => ({
  id: num(dig(r, 'id')) ?? 0,
  author: str(dig(r, 'user', 'login')),
  body: str(dig(r, 'body')),
  at: str(dig(r, 'created_at')),
});

export async function listComments(gh: Gh, issue: number): Promise<Comment[]> {
  return (await paged(gh, `/repos/${gh.repo}/issues/${issue}/comments`)).map(toComment);
}

export async function listReviewComments(gh: Gh, pr: number): Promise<Comment[]> {
  return (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/comments`)).map((r) => {
    const c = toComment(r);
    return { ...c, body: `\`${str(dig(r, 'path'))}\`: ${c.body}` };
  });
}

export async function listReviews(gh: Gh, pr: number): Promise<Review[]> {
  return (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/reviews`)).map((r) => ({
    author: str(dig(r, 'user', 'login')),
    body: str(dig(r, 'body')),
    at: str(dig(r, 'submitted_at')),
    state: str(dig(r, 'state')),
  }));
}

export async function issueLabels(gh: Gh, issue: number): Promise<string[]> {
  return rows(dig(await gh.call('GET', `/repos/${gh.repo}/issues/${issue}`), 'labels')).map((l) => str(dig(l, 'name')));
}

export async function openIssuesWithLabel(gh: Gh, label: string): Promise<number[]> {
  return (await paged(gh, `/repos/${gh.repo}/issues?state=open&labels=${encodeURIComponent(label)}`))
    .filter((r) => dig(r, 'pull_request') === undefined)
    .map((r) => num(dig(r, 'number')))
    .filter((n): n is number => n !== null);
}

// The newest PR from the issue's factory branch, open or closed.
export async function findPull(gh: Gh, issue: number): Promise<number | null> {
  const owner = gh.repo.split('/')[0] ?? '';
  const list = rows(await gh.call('GET', `/repos/${gh.repo}/pulls?state=all&head=${owner}:${encodeURIComponent(branchFor(issue))}&per_page=1`));
  return num(dig(list[0], 'number'));
}

export async function pullBranch(gh: Gh, pr: number): Promise<string> {
  return str(dig(await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`), 'head', 'ref'));
}

export async function pullSnapshot(gh: Gh, pr: number): Promise<PullSnapshot & { nodeId: string }> {
  const p = await gh.call('GET', `/repos/${gh.repo}/pulls/${pr}`);
  const files = (await paged(gh, `/repos/${gh.repo}/pulls/${pr}/files`)).map((f) => str(dig(f, 'filename')));
  return {
    number: pr,
    headSha: str(dig(p, 'head', 'sha')),
    open: dig(p, 'state') === 'open',
    conflicting: dig(p, 'mergeable_state') === 'dirty',
    files,
    nodeId: str(dig(p, 'node_id')),
  };
}

export async function latestStageRun(gh: Gh, workflow: StageWorkflow, issue: number): Promise<RunSnapshot | null> {
  const runs = rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/workflows/${stageWorkflowFile(workflow)}/runs?per_page=30`), 'workflow_runs'));
  const r = runs.find((x) => dig(x, 'display_title') === runTitle(workflow, issue));
  return r ? runFrom(r, workflow) : null;
}

export async function latestCiRun(gh: Gh, headSha: string): Promise<RunSnapshot | null> {
  const runs = rows(dig(await gh.call('GET', `/repos/${gh.repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs?head_sha=${headSha}&per_page=1`), 'workflow_runs'));
  return runs[0] ? runFrom(runs[0], 'ci') : null;
}

export async function createComment(gh: Gh, issue: number, body: string): Promise<number | null> {
  return num(dig(await gh.call('POST', `/repos/${gh.repo}/issues/${issue}/comments`, { body }), 'id'));
}

export async function updateComment(gh: Gh, id: number, body: string): Promise<void> {
  await gh.call('PATCH', `/repos/${gh.repo}/issues/comments/${id}`, { body });
}

export async function addLabel(gh: Gh, issue: number, label: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/issues/${issue}/labels`, { labels: [label] });
}

export async function removeLabel(gh: Gh, issue: number, label: string): Promise<void> {
  await gh.call('DELETE', `/repos/${gh.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
}

export async function dispatch(gh: Gh, workflow: StageWorkflow, issue: number): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/actions/workflows/${stageWorkflowFile(workflow)}/dispatches`, { ref: 'main', inputs: { issue: String(issue) } });
}

export async function markReady(gh: Gh, nodeId: string): Promise<void> {
  const res = await gh.call('POST', '/graphql', {
    query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
    variables: { id: nodeId },
  });
  if (dig(res, 'errors') !== undefined) throw new Error(`markPullRequestReadyForReview failed: ${JSON.stringify(dig(res, 'errors'))}`);
}

export async function requestReview(gh: Gh, pr: number, login: string): Promise<void> {
  await gh.call('POST', `/repos/${gh.repo}/pulls/${pr}/requested_reviewers`, { reviewers: [login] });
}
