// The factory's state machine. Pure: given an event and a snapshot of one issue (or all of them, for the sweep),
// return the actions to take. snapshot.ts reads GitHub into snapshots and main.ts applies the actions, so every
// rule here is tested without the network.

import { oneOf } from '../plugin/servers/tracker/src/util.ts';
import {
  ACTIVE_STAGES,
  branchFor,
  MAINTAINER,
  MAX_ATTEMPTS,
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
import type { Command, FactoryState, FixReason } from './markers.ts';

export type PullSnapshot = { number: number; headSha: string; open: boolean; conflicting: boolean; files: string[] };
export type RunSnapshot = {
  workflow: StageWorkflow | 'ci';
  conclusion: string | null;
  headSha: string;
  url: string;
  completedAt: string | null; // null while the run is still going
};
export type IssueSnapshot = {
  number: number;
  state: FactoryState | null;
  labels: string[];
  brief: { id: number; touches: string[]; at: string } | null; // latest brief by the factory bot
  pr: PullSnapshot | null;
  review: { blocking: number; at: string } | null; // latest factory review by the factory bot
  lastCommand: { command: Command; at: string } | null; // the maintainer's latest slash command
  lastRun: RunSnapshot | null; // latest run of the workflow the current stage waits on
};
export type Ctx = { now: Date; risky: readonly string[] };

export type FactoryEvent =
  | { kind: 'queued'; issue: number; actor: string }
  | { kind: 'command'; issue: number; command: Command; actor: string }
  | { kind: 'run-finished'; issue: number; run: RunSnapshot }
  | { kind: 'changes-requested'; issue: number; actor: string }
  | { kind: 'pr-closed'; issue: number };

export type Action =
  | { kind: 'save'; issue: number; state: FactoryState }
  | { kind: 'dispatch'; issue: number; workflow: StageWorkflow }
  | { kind: 'comment'; issue: number; body: string }
  | { kind: 'unlabel'; issue: number; labels: string[] }
  | { kind: 'pr-ready'; pr: number };

const notBefore = (at: string, since: string) => Date.parse(at) >= Date.parse(since);

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
      return [];
    case 'pr-closed':
      return st && st.stage !== 'done' ? enter(ev.issue, st, 'done', ctx) : [];
  }
}

function runFinished(_issue: number, _st: FactoryState, _snap: IssueSnapshot, _run: RunSnapshot, _ctx: Ctx): Action[] {
  return [];
}

function command(_issue: number, _st: FactoryState, _snap: IssueSnapshot, _cmd: Command, _ctx: Ctx): Action[] {
  return [];
}

// Starts at most one issue: first a ready PR that now conflicts with main (back to the fixer to rebase), otherwise
// the oldest queued issue. Only when no issue is active after the given actions.
function startNext(snaps: readonly IssueSnapshot[], actions: readonly Action[], ctx: Ctx): Action[] {
  const after = new Map<number, FactoryState | null>(snaps.map((s) => [s.number, s.state]));
  for (const a of actions) if (a.kind === 'save') after.set(a.issue, a.state);
  if ([...after.values()].some((s) => s && ACTIVE_STAGES.includes(s.stage))) return [];
  const queued = [...after.entries()]
    .filter((e): e is [number, FactoryState] => e[1]?.stage === 'queued')
    .sort((a, b) => Date.parse(a[1].since) - Date.parse(b[1].since));
  const first = queued[0];
  return first ? enter(first[0], first[1], 'planning', ctx) : [];
}

export function next(snaps: readonly IssueSnapshot[], ctx: Ctx): Action[] {
  return startNext(snaps, [], ctx);
}

export function sweep(snaps: readonly IssueSnapshot[], ctx: Ctx): Action[] {
  return startNext(snaps, [], ctx);
}
