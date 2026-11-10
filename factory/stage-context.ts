// CLI for the stage workflow: writes the stage's context to stdout. Runs from main's checkout, before the job
// switches to the PR branch, so a branch cannot change what its own agents are told.
// Usage: node --no-warnings factory/stage-context.ts <build|review|fix> <issue>

import { errorText, oneOf } from '../plugin/servers/tracker/src/util.ts';
import { factoryBotLogin } from './config.ts';
import { buildContext } from './context.ts';
import { client, listComments, listReviewComments, listReviews } from './github.ts';
import { stateFrom } from './snapshot.ts';

async function main(): Promise<void> {
  const [stage, issueArg] = process.argv.slice(2);
  if (!oneOf(['build', 'review', 'fix'] as const, stage)) throw new Error('usage: stage-context.ts <build|review|fix> <issue>');
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`not an issue number: ${issueArg}`);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY must be set');
  const gh = client(token, repo);
  const comments = await listComments(gh, issue);
  const found = stateFrom(comments);
  if (!found) throw new Error(`Issue #${issue} has no factory state`);
  const pr = found.state.pr;
  const [reviews, prComments] = pr ? await Promise.all([listReviews(gh, pr), listReviewComments(gh, pr)]) : [[], []];
  process.stdout.write(buildContext({ stage, issue, bot: factoryBotLogin(), state: found.state, comments, reviews, prComments }));
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});
