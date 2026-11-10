// Builds .factory/context.md: the only inputs the build, review and fix agents work from. It includes the brief
// (by id, and only from the factory bot), the factory review, and the maintainer's comments. Nothing else from the
// issue or PR threads goes in: those are untrusted text on a public repo.

import { branchFor, MAINTAINER } from './config.ts';
import type { Comment, Review } from './github.ts';
import { type FactoryState, parseReview } from './markers.ts';

export type ContextInput = {
  stage: 'build' | 'review' | 'fix';
  issue: number;
  bot: string;
  state: FactoryState;
  comments: readonly Comment[];
  reviews: readonly Review[];
  prComments: readonly Comment[];
};

export function buildContext(i: ContextInput): string {
  const brief = i.comments.find((c) => c.id === i.state.brief && c.author === i.bot);
  if (!brief) throw new Error(`Issue #${i.issue}: no brief from ${i.bot} with comment id ${i.state.brief}`);
  const parts = [`# Factory context: issue #${i.issue}`, `Branch: \`${branchFor(i.issue)}\``];
  if (i.state.pr) parts.push(`PR: #${i.state.pr}`);
  parts.push('## Brief', brief.body);
  if (i.stage === 'fix') {
    parts.push(`## Why this fix round: ${i.state.fixReason ?? 'unknown'}`);
    const review = i.reviews.findLast((r) => r.author === i.bot && parseReview(r.body) !== null);
    if (review) parts.push('## Factory review', review.body);
    const notes = [
      ...i.reviews.filter((r) => r.author === MAINTAINER && r.body.trim() !== '').map((r) => r.body),
      ...i.prComments.filter((c) => c.author === MAINTAINER).map((c) => c.body),
    ];
    if (notes.length > 0) parts.push('## Maintainer comments', notes.map((n) => `- ${n}`).join('\n'));
    // The workflow appends the failed CI log under this heading.
    if (i.state.fixReason === 'ci') parts.push('## CI failure');
  }
  return `${parts.join('\n\n')}\n`;
}
