// Rule types: which consumers a rule applies to.

import { ToolError } from './errors.ts';
import { oneOf } from './util.ts';

export const RULE_TYPES = ['global', 'sourcing', 'scoring', 'forms', 'writing', 'inbox', 'reporting'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

// checkArgs only checks that `types` is an array, so the list and every item are checked here. Returns the
// distinct types in RULE_TYPES order, so the same set always stores and reads back the same way.
export function normalizeRuleTypes(types: unknown): RuleType[] {
  if (!Array.isArray(types)) throw new ToolError(`types must be a list of rule types: ${RULE_TYPES.join(', ')}`);
  if (!types.length) throw new ToolError(`types needs at least one of: ${RULE_TYPES.join(', ')}. Use ["global"] for a rule every consumer must read.`);
  for (const [i, v] of types.entries()) {
    if (!oneOf(RULE_TYPES, v)) throw new ToolError(`types[${i}]: ${JSON.stringify(v)} is not a rule type. Use: ${RULE_TYPES.join(', ')}`);
  }
  return RULE_TYPES.filter((t) => types.includes(t));
}
