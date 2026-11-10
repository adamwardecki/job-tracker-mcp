// Router entry, run by .github/workflows/factory-router.yml. Reads the event, snapshots the issue, asks decide.ts
// what to do and applies it; then starts the next queued issue if the factory is idle. FACTORY_DRY_RUN=1 logs the
// actions without writing anything.

import { readFileSync } from 'node:fs';
import { errorText } from '../plugin/servers/tracker/src/util.ts';
import { factoryBotLogin, issueForBranch, LABEL_PREFIX, MAINTAINER, stageLabel } from './config.ts';
import { type Action, type Ctx, decideEvent, next, sweep } from './decide.ts';
import { parseEvent } from './events.ts';
import { addLabel, client, createComment, dispatch, type Gh, markReady, pullBranch, removeLabel, requestReview, updateComment } from './github.ts';
import { parseGlobList } from './globs.ts';
import { renderState } from './markers.ts';
import { type Loaded, load, loadAll } from './snapshot.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function apply(gh: Gh, dispatcher: Gh, loaded: Map<number, Loaded>, actions: readonly Action[], dry: boolean): Promise<void> {
  for (const a of actions) {
    console.log(`${dry ? '[dry run] ' : ''}${JSON.stringify(a)}`);
    if (dry) continue;
    const l = a.kind === 'pr-ready' ? undefined : loaded.get(a.issue);
    switch (a.kind) {
      case 'save': {
        const body = renderState(a.state);
        if (l?.stateCommentId) await updateComment(gh, l.stateCommentId, body);
        else {
          const id = await createComment(gh, a.issue, body);
          if (l) l.stateCommentId = id;
        }
        const want = a.state.stage === 'done' ? null : stageLabel(a.state.stage);
        const have = l?.snap.labels ?? [];
        for (const label of have) if (label.startsWith(LABEL_PREFIX) && label !== want) await removeLabel(gh, a.issue, label);
        if (want && !have.includes(want)) await addLabel(gh, a.issue, want);
        if (l) l.snap.labels = [...have.filter((x) => !x.startsWith(LABEL_PREFIX)), ...(want ? [want] : [])];
        break;
      }
      case 'unlabel': {
        const have = l?.snap.labels ?? [];
        for (const label of a.labels) if (have.includes(label)) await removeLabel(gh, a.issue, label);
        if (l) l.snap.labels = have.filter((x) => !a.labels.includes(x));
        break;
      }
      case 'comment':
        await createComment(gh, a.issue, a.body);
        break;
      case 'dispatch':
        await dispatch(dispatcher, a.workflow, a.issue);
        break;
      case 'pr-ready': {
        const nodeId = [...loaded.values()].find((x) => x.snap.pr?.number === a.pr)?.prNodeId;
        if (!nodeId) throw new Error(`PR #${a.pr} is not in the loaded snapshots`);
        await markReady(gh, nodeId);
        await requestReview(gh, a.pr, MAINTAINER);
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  const repo = env('GITHUB_REPOSITORY');
  const gh = client(env('GITHUB_TOKEN'), repo);
  const dispatcher = client(env('FACTORY_DISPATCH_TOKEN'), repo);
  const bot = factoryBotLogin();
  const dry = process.env.FACTORY_DRY_RUN === '1';

  const parsed = parseEvent(env('GITHUB_EVENT_NAME'), JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')));
  if (parsed === null) {
    console.log('Event ignored.');
    return;
  }
  const risky = parseGlobList(readFileSync(new URL('./risky-paths.txt', import.meta.url), 'utf8'));
  const ctx: Ctx = { now: new Date(), risky };
  if (parsed !== 'sweep') {
    const issue = 'issue' in parsed.target ? parsed.target.issue : issueForBranch(await pullBranch(gh, parsed.target.pr));
    if (issue === null) {
      console.log('Not a factory PR.');
      return;
    }
    const one = new Map([[issue, await load(gh, issue, bot)]]);
    const loaded = one.get(issue);
    if (loaded) await apply(gh, dispatcher, one, decideEvent(parsed.build(issue), loaded.snap, ctx), dry);
  }
  const all = await loadAll(gh, bot);
  const snaps = [...all.values()].map((l) => l.snap);
  await apply(gh, dispatcher, all, parsed === 'sweep' ? sweep(snaps, ctx) : next(snaps, ctx), dry);
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
