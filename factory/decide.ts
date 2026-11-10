// The factory's state machine. Pure: given an event and a snapshot of one issue (or all of them, for the sweep),
// return the actions to take. snapshot.ts reads GitHub into snapshots and main.ts applies the actions, so every
// rule here is tested without the network.

import { oneOf } from '../plugin/servers/tracker/src/util.ts';
import {
  ACTIVE_STAGES,
  branchFor,
  MAINTAINER,
  MAX_ATTEMPTS,
  MAX_REBASES,
  MAX_ROUNDS,
  RETRY_AFTER_MS,
  RUNNER_FOR,
  STUCK_AFTER_MS,
  type Stage,
  type StageWorkflow,
  stageLabel,
  TRIAGE_READY,
  TRIAGE_STOP,
} from './config.ts';
import { riskyFiles, riskyTouches } from './globs.ts';
import type { BlockReason, Command, FactoryState, FixReason } from './markers.ts';

export type PullSnapshot = { number: number; headSha: string; open: boolean; conflicting: boolean; files: string[] };
export type RunSnapshot = {
  workflow: StageWorkflow | 'ci';
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string | null;
  completedAt: string | null; // null while the run is still going
};
export type IssueSnapshot = {
  number: number;
  state: FactoryState | null;
  labels: string[];
  queuedBy: { login: string; at: string } | null; // who last added agent:queued, while it is on the issue
  brief: { id: number; touches: string[]; at: string } | null; // latest brief by the factory bot
  pr: PullSnapshot | null;
  review: { blocking: number; at: string } | null; // latest factory review by the factory bot
  lastCommand: { command: Command; at: string; actor: string } | null; // the maintainer's latest slash command
  lastRun: RunSnapshot | null; // latest run of the workflow the current stage waits on
};
export type Ctx = { now: Date; risky: readonly string[] };

export type FactoryEvent =
  | { kind: 'queued'; issue: number; actor: string }
  | { kind: 'command'; issue: number; command: Command; actor: string }
  | { kind: 'run-finished'; issue: number; run: RunSnapshot }
  | { kind: 'changes-requested'; issue: number; actor: string }
  | { kind: 'pr-closed'; issue: number; pr: number };

export type Action =
  | { kind: 'save'; issue: number; state: FactoryState }
  | { kind: 'dispatch'; issue: number; workflow: StageWorkflow }
  | { kind: 'comment'; issue: number; body: string }
  | { kind: 'unlabel'; issue: number; labels: string[] }
  | { kind: 'pr-ready'; pr: number };

// GitHub's timestamps are whole seconds and since has milliseconds, so a run or comment from the same second the
// stage began would otherwise read as older than it.
const notBefore = (at: string, since: string) => Date.parse(at) >= Math.floor(Date.parse(since) / 1000) * 1000;

export function initialState(stage: Stage, now: Date): FactoryState {
  return { stage, since: now.toISOString(), round: 0, attempts: 0, runs: [] };
}

// Move to a stage and dispatch its workflow, if it has one. Per-stage counters reset unless the patch keeps them.
function enter(issue: number, prev: FactoryState, stage: Stage, ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] {
  const state: FactoryState = { ...prev, attempts: 0, failedAt: undefined, ...patch, stage, since: ctx.now.toISOString() };
  const actions: Action[] = [{ kind: 'save', issue, state }];
  // A fresh plan must not inherit the last plan's triage outcome.
  if (stage === 'planning') actions.push({ kind: 'unlabel', issue, labels: [TRIAGE_READY, ...TRIAGE_STOP] });
  const workflow = RUNNER_FOR[stage];
  if (workflow) actions.push({ kind: 'dispatch', issue, workflow });
  return actions;
}

export function decideEvent(ev: FactoryEvent, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const st = snap.state;
  switch (ev.kind) {
    case 'queued':
      if (ev.actor !== MAINTAINER) return [];
      if (st && st.stage !== 'done' && st.stage !== 'blocked') return [];
      return [{ kind: 'save', issue: ev.issue, state: initialState('queued', ctx.now) }];
    case 'command':
      return ev.actor === MAINTAINER && st ? command(ev.issue, st, snap, ev.command, ctx) : [];
    case 'run-finished':
      return st ? runFinished(ev.issue, st, snap, ev.run, ctx) : [];
    case 'changes-requested':
      return ev.actor === MAINTAINER && st?.stage === 'ready' ? toFix(ev.issue, st, snap, 'maintainer', ctx) : [];
    case 'pr-closed':
      // Only the issue's own PR finishes it; an older PR from the same branch closing must not.
      if (!st || st.stage === 'done' || (st.pr !== undefined && st.pr !== ev.pr)) return [];
      return enter(ev.issue, st, 'done', ctx);
  }
}

function block(issue: number, prev: FactoryState, reason: string, blockedFor: BlockReason, ctx: Ctx): Action[] {
  const blockedFrom = prev.stage === 'blocked' ? prev.blockedFrom : prev.stage;
  return [
    ...enter(issue, prev, 'blocked', ctx, { blockedFrom, blockedFor }),
    { kind: 'comment', issue, body: `Factory stopped at **${blockedFrom}**: ${reason}\n\nFix the cause, then comment \`/retry\`.` },
  ];
}

// A stage run failed or broke its contract. The sweep retries it after RETRY_AFTER_MS (a subscription usage window
// may need to reset); the last allowed attempt blocks instead.
function fail(issue: number, prev: FactoryState, reason: string, ctx: Ctx): Action[] {
  const attempts = prev.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return block(issue, prev, `${reason} (attempt ${attempts} of ${MAX_ATTEMPTS}).`, 'attempts', ctx);
  return [{ kind: 'save', issue, state: { ...prev, attempts, failedAt: ctx.now.toISOString() } }];
}

function toFix(issue: number, prev: FactoryState, snap: IssueSnapshot, reason: FixReason, ctx: Ctx): Action[] {
  const headSha = snap.pr?.headSha;
  // Rebases have their own cap: a rebase that never clears the conflict would loop through CI and review forever.
  if (reason === 'rebase') {
    const rebases = (prev.rebases ?? 0) + 1;
    if (rebases > MAX_REBASES) return block(issue, prev, `the PR conflicts with main again after ${MAX_REBASES} rebases.`, 'rebases', ctx);
    return enter(issue, prev, 'fixing', ctx, { rebases, fixReason: reason, headSha });
  }
  // Only CI's and the reviewer's rounds count toward the cap; the maintainer's requests do not.
  const round = prev.round + (reason === 'ci' || reason === 'review' ? 1 : 0);
  if (round > MAX_ROUNDS) return block(issue, prev, `still not passing after ${MAX_ROUNDS} fix rounds.`, 'rounds', ctx);
  return enter(issue, prev, 'fixing', ctx, { round, fixReason: reason, headSha });
}

// A PR that reached ready through a rebase keeps its rebase count, so the conflict → rebase → ready loop stays
// capped; reaching ready any other way means real work landed in between, and the count starts over.
function toReady(issue: number, prev: FactoryState, pr: number | undefined, ctx: Ctx): Action[] {
  const rebases = prev.fixReason === 'rebase' ? prev.rebases : undefined;
  const actions = enter(issue, prev, 'ready', ctx, { approvalFor: undefined, rebases });
  if (pr) actions.push({ kind: 'pr-ready', pr });
  return actions;
}

function askApproval(issue: number, prev: FactoryState, approvalFor: 'plan' | 'diff', hits: string[], ctx: Ctx, patch: Partial<FactoryState> = {}): Action[] {
  const what = approvalFor === 'plan' ? 'The brief touches' : 'The PR changes';
  const list = hits.map((h) => `- \`${h}\``).join('\n');
  return [
    ...enter(issue, prev, 'awaiting-approval', ctx, { ...patch, approvalFor }),
    { kind: 'comment', issue, body: `${what} risky paths (\`factory/risky-paths.txt\`):\n\n${list}\n\nComment \`/approve\` to continue or \`/stop\` to stop.` },
  ];
}

function runFinished(issue: number, st: FactoryState, snap: IssueSnapshot, run: RunSnapshot, ctx: Ctx): Action[] {
  const expected = st.stage === 'ci' ? 'ci' : RUNNER_FOR[st.stage];
  if (!expected || run.workflow !== expected || !run.completedAt || st.runs.includes(run.url)) return [];
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') return [];
  const seen: FactoryState = { ...st, runs: [...st.runs, run.url] };
  if (expected === 'ci') {
    // CI runs per push; only the run for the PR's current head decides.
    if (!snap.pr || run.headSha !== snap.pr.headSha) return [];
    return run.conclusion === 'success' ? enter(issue, seen, 'in-review', ctx) : toFix(issue, seen, snap, 'ci', ctx);
  }
  // A run started before this stage began belongs to an earlier attempt, even if it finished after.
  if (!run.createdAt || !notBefore(run.createdAt, st.since)) return [];
  if (run.conclusion !== 'success') return fail(issue, seen, `the ${expected} run ended with "${run.conclusion}"`, ctx);
  switch (expected) {
    case 'plan':
      return planned(issue, seen, snap, ctx);
    case 'build':
      return built(issue, seen, snap, ctx);
    case 'review':
      return reviewed(issue, seen, snap, ctx);
    case 'fix':
      return fixed(issue, seen, snap, ctx);
  }
}

function planned(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  if (snap.labels.some((l) => oneOf(TRIAGE_STOP, l))) return block(issue, st, 'the planner needs a human; see its comment.', 'human', ctx);
  const brief = snap.brief && notBefore(snap.brief.at, st.since) ? snap.brief : null;
  if (!brief || !snap.labels.includes(TRIAGE_READY)) return fail(issue, st, 'the planner finished without a brief and the ready-for-agent label', ctx);
  const hits = riskyTouches(brief.touches, ctx.risky);
  if (hits.length > 0) return askApproval(issue, st, 'plan', hits, ctx, { brief: brief.id });
  return enter(issue, st, 'building', ctx, { brief: brief.id });
}

function built(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  if (!snap.pr?.open) return fail(issue, st, `the builder finished without an open PR from \`${branchFor(issue)}\``, ctx);
  return enter(issue, st, 'ci', ctx, { pr: snap.pr.number });
}

function reviewed(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const review = snap.review && notBefore(snap.review.at, st.since) ? snap.review : null;
  if (!review || !snap.pr) return fail(issue, st, 'the reviewer finished without posting a factory review', ctx);
  if (review.blocking > 0) return toFix(issue, st, snap, 'review', ctx);
  // The diff is checked again here: a plan can drift, or have been steered, after its paths were approved.
  const hits = riskyFiles(snap.pr.files, ctx.risky);
  if (hits.length > 0) return askApproval(issue, st, 'diff', hits, ctx);
  return toReady(issue, st, snap.pr.number, ctx);
}

function fixed(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  // Without the head the fixer started from, nothing shows that it pushed.
  if (!snap.pr || st.headSha === undefined || snap.pr.headSha === st.headSha) return fail(issue, st, 'the fixer finished without pushing a commit', ctx);
  return enter(issue, st, 'ci', ctx);
}

function command(issue: number, st: FactoryState, snap: IssueSnapshot, cmd: Command, ctx: Ctx): Action[] {
  switch (cmd) {
    case 'approve':
      if (st.stage !== 'awaiting-approval') return [];
      // A state without approvalFor was not written by askApproval; guessing could skip the diff check.
      if (st.approvalFor === 'plan') return enter(issue, st, 'building', ctx, { approvalFor: undefined });
      if (st.approvalFor === 'diff') return toReady(issue, st, st.pr, ctx);
      return [];
    case 'stop':
      return st.stage === 'blocked' || st.stage === 'done' ? [] : block(issue, st, 'stopped by the maintainer.', 'stop', ctx);
    case 'retry':
      return st.stage === 'blocked' ? retry(issue, st, snap, ctx) : [];
  }
}

// /retry picks its way back in from why the issue stopped, not just where.
function retry(issue: number, st: FactoryState, snap: IssueSnapshot, ctx: Ctx): Action[] {
  const from = st.blockedFrom;
  if (!from) return [];
  const clear = { blockedFrom: undefined, blockedFor: undefined };
  // Out of rounds: the last CI log or review still has the problem, so the fixer gets a fresh set of rounds for it.
  // Re-running the reviewer would only repeat the findings.
  if (st.blockedFor === 'rounds' && (from === 'ci' || from === 'in-review')) {
    if (!snap.pr) return [];
    return enter(issue, st, 'fixing', ctx, { ...clear, round: 0, fixReason: from === 'ci' ? 'ci' : 'review', headSha: snap.pr.headSha });
  }
  // Back to ready with the count cleared; the next idle sweep rebases again if the PR still conflicts.
  if (st.blockedFor === 'rebases') return enter(issue, st, from, ctx, { ...clear, rebases: undefined });
  // Stuck or stopped at CI: no CI failure is known, so wait on CI again and let its latest run decide.
  if (from === 'ci') return enter(issue, st, 'ci', ctx, clear);
  if (from === 'fixing') {
    // The fixer compares the PR head after its run with this one; without a PR there is nothing to fix.
    if (!snap.pr) return [];
    return enter(issue, st, 'fixing', ctx, { ...clear, headSha: snap.pr.headSha });
  }
  return enter(issue, st, from, ctx, clear);
}

// Starts at most one issue: first a ready PR that now conflicts with main (back to the fixer to rebase), otherwise
// the oldest queued issue. Only when no issue is active after the given actions.
function startNext(snaps: readonly IssueSnapshot[], actions: readonly Action[], ctx: Ctx): Action[] {
  const after = new Map<number, FactoryState | null>(snaps.map((s) => [s.number, s.state]));
  for (const a of actions) if (a.kind === 'save') after.set(a.issue, a.state);
  if ([...after.values()].some((s) => s && ACTIVE_STAGES.includes(s.stage))) return [];
  for (const s of snaps) {
    const state = after.get(s.number);
    if (state?.stage === 'ready' && s.pr?.conflicting) return toFix(s.number, state, s, 'rebase', ctx);
  }
  const queued = [...after.entries()]
    .filter((e): e is [number, FactoryState] => e[1]?.stage === 'queued')
    .sort((a, b) => Date.parse(a[1].since) - Date.parse(b[1].since));
  const first = queued[0];
  return first ? enter(first[0], first[1], 'planning', ctx) : [];
}

export function next(snaps: readonly IssueSnapshot[], ctx: Ctx): Action[] {
  return startNext(snaps, [], ctx);
}

// The 30-minute sweep. Recovers what the event path can miss (the router's concurrency group drops pending runs),
// retries failed stages, blocks stuck ones, then starts the next issue if the factory is idle.
export function sweep(snaps: readonly IssueSnapshot[], ctx: Ctx): Action[] {
  const actions = snaps.flatMap((s) => sweepOne(s, ctx));
  return [...actions, ...startNext(snaps, actions, ctx)];
}

// The label alone is not enough to queue: the factory's App can write labels too, and only the maintainer starts work.
// A blocked or done issue is queued again only by a labelling after it stopped.
function queuedByMaintainer(snap: IssueSnapshot): boolean {
  const by = snap.queuedBy;
  if (!snap.labels.includes(stageLabel('queued')) || by?.login !== MAINTAINER) return false;
  const st = snap.state;
  return !st || ((st.stage === 'blocked' || st.stage === 'done') && notBefore(by.at, st.since));
}

function sweepOne(snap: IssueSnapshot, ctx: Ctx): Action[] {
  const st = snap.state;
  if (queuedByMaintainer(snap)) return [{ kind: 'save', issue: snap.number, state: initialState('queued', ctx.now) }];
  if (!st) return [];
  // snapshot.ts already keeps only the maintainer's commands; checked again so a loader change cannot open this up.
  if (snap.lastCommand?.actor === MAINTAINER && notBefore(snap.lastCommand.at, st.since)) {
    const acted = command(snap.number, st, snap, snap.lastCommand.command, ctx);
    if (acted.length > 0) return acted;
  }
  if (!ACTIVE_STAGES.includes(st.stage)) return [];
  if (st.failedAt) {
    const due = ctx.now.getTime() - Date.parse(st.failedAt) >= RETRY_AFTER_MS;
    return due ? enter(snap.number, st, st.stage, ctx, { attempts: st.attempts }) : [];
  }
  if (snap.lastRun) {
    const acted = runFinished(snap.number, st, snap, snap.lastRun, ctx);
    if (acted.length > 0) return acted;
  }
  if (ctx.now.getTime() - Date.parse(st.since) > STUCK_AFTER_MS) {
    return block(snap.number, st, `no progress for ${STUCK_AFTER_MS / 60000} minutes.`, 'stuck', ctx);
  }
  return [];
}
