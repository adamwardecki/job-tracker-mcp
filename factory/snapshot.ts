// Reads issues from GitHub into the snapshots decide.ts works on.

import { MAINTAINER, ROUTER_LOGIN, RUNNER_FOR, STAGES, stageLabel } from './config.ts';
import type { IssueSnapshot } from './decide.ts';
import {
  type Comment,
  findPull,
  type Gh,
  issueLabels,
  latestCiRun,
  latestStageRun,
  listComments,
  listReviews,
  openIssuesWithLabel,
  pullSnapshot,
} from './github.ts';
import { BRIEF_MARKER, type FactoryState, parseBriefTouches, parseCommand, parseReview, parseState } from './markers.ts';

export type Loaded = { snap: IssueSnapshot; stateCommentId: number | null; prNodeId: string | null };

// The router's latest state comment. Only comments by the router account count, so nobody can forge a stage.
export function stateFrom(comments: readonly Comment[]): { id: number; state: FactoryState } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (!c || c.author !== ROUTER_LOGIN) continue;
    const state = parseState(c.body);
    if (state) return { id: c.id, state };
  }
  return null;
}

export async function load(gh: Gh, issue: number, bot: string): Promise<Loaded> {
  const [comments, labels] = await Promise.all([listComments(gh, issue), issueLabels(gh, issue)]);
  const found = stateFrom(comments);
  const state = found?.state ?? null;

  // Briefs and reviews count only from the factory bot: anyone can comment on a public repo.
  const briefComment = comments.findLast((c) => c.author === bot && c.body.includes(BRIEF_MARKER));
  const touches = briefComment ? parseBriefTouches(briefComment.body) : null;
  const brief = briefComment && touches ? { id: briefComment.id, touches, at: briefComment.at } : null;

  const prNumber = state?.pr ?? (await findPull(gh, issue));
  const pr = prNumber ? await pullSnapshot(gh, prNumber) : null;
  const reviews = pr ? await listReviews(gh, pr.number) : [];
  const reviewRow = reviews.findLast((r) => r.author === bot && parseReview(r.body) !== null);
  const verdict = reviewRow ? parseReview(reviewRow.body) : null;

  const prComments = pr ? await listComments(gh, pr.number) : [];
  const commands = [...comments, ...prComments]
    .filter((c) => c.author === MAINTAINER)
    .flatMap((c) => {
      const command = parseCommand(c.body);
      return command ? [{ command, at: c.at }] : [];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const stage = state?.stage;
  const workflow = stage ? RUNNER_FOR[stage] : undefined;
  const lastRun = stage === 'ci' && pr ? await latestCiRun(gh, pr.headSha) : workflow ? await latestStageRun(gh, workflow, issue) : null;

  return {
    stateCommentId: found?.id ?? null,
    prNodeId: pr?.nodeId ?? null,
    snap: {
      number: issue,
      state,
      labels,
      brief,
      pr,
      review: reviewRow && verdict ? { blocking: verdict.blocking, at: reviewRow.at } : null,
      lastCommand: commands.at(-1) ?? null,
      lastRun,
    },
  };
}

// Every open issue carrying a stage label (done carries none).
export async function loadAll(gh: Gh, bot: string): Promise<Map<number, Loaded>> {
  const numbers = new Set<number>();
  for (const stage of STAGES) {
    if (stage === 'done') continue;
    for (const n of await openIssuesWithLabel(gh, stageLabel(stage))) numbers.add(n);
  }
  const out = new Map<number, Loaded>();
  for (const n of numbers) out.set(n, await load(gh, n, bot));
  return out;
}
