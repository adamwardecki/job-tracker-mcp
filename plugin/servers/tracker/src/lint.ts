// Outbound prose lint (spec §10, §11). Shared by the tracker (add_artifact, audit, lint_prose) and
// the hooks (Gmail draft bodies). Errors fail; warnings are surfaced only.

export interface LintIssue {
  severity: 'error' | 'warn';
  kind: string;
  match: string;
  hint: string;
}

export interface LintResult {
  ok: boolean;
  words: number;
  issues: LintIssue[];
}

interface Pattern {
  kind: string;
  re: RegExp;
  hint: string;
}

const ERROR_PATTERNS: Pattern[] = [
  { kind: 'em_dash', re: /—/g, hint: 'Replace the em dash with a comma, colon, full stop or parentheses.' },
  { kind: 'en_dash', re: /–/g, hint: 'Replace the en dash. For ranges write "to" or a plain hyphen without spaces.' },
  { kind: 'spaced_hyphen_dash', re: /[A-Za-z,)] - [A-Za-z(]/g, hint: 'A spaced hyphen reads as a dash. Rewrite the sentence.' },
  {
    kind: 'not_x_but_y',
    re: /\b(?:not (?:just|only|merely|simply) [^.!?\n]{1,80}?,? but\b|(?:isn't|is not|wasn't|was not|aren't|are not) (?:just|only|merely|simply|about) [^.!?\n]{1,80}?[,;] (?:it's|it is|they're|they are|this is|that's)\b|it's not (?:about )?[^.!?\n]{1,60}?[,;] it's\b)/gi,
    hint: 'Drop the "not X but Y" construction. Say the positive thing directly.',
  },
  {
    kind: 'fake_candid_opener',
    re: /(?:^|[.!?]\s+|\n)(?:honestly|frankly|candidly|truth be told|to be (?:honest|frank)|full disclosure|i(?:'ll| will) be (?:honest|candid|upfront)|let me be (?:honest|candid|upfront)|here's the thing|i'll level with you)\b/gi,
    hint: 'Remove the fake-candid opener.',
  },
  ...[
    // Negated experience: "I don't have (direct) experience", "I haven't worked with", "I've never used".
    /\bi(?:'ve| have| do| did)?\s*(?:not|n't|never|don't|do not|haven't|have not|didn't|did not)\s+(?:yet\s+)?(?:have\s+|had\s+|got\s+|gotten\s+)?(?:(?:any|much|direct|professional|hands-on|commercial|production|formal|real|prior|deep)\s+)*(?:experience|exposure|background|worked (?:with|on|in)|used|touched|shipped|built)\b/gi,
    // Limited experience: "my experience with X is limited", "I have limited exposure".
    /\b(?:my|i have|i've got)\s+(?:(?:limited|little|less|no|minimal)\s+)(?:(?:direct|professional|hands-on|commercial)\s+)?(?:experience|exposure|background)\b/gi,
    /\bmy\s+(?:experience|exposure|background)\s+(?:with|in)\s+[^.!?\n]{1,40}?\s+is\s+(?:limited|light|minimal|thin)\b/gi,
    // Concessive openers: "While I have not...", "Although I lack...".
    /\b(?:although|while|though|even though)\s+i(?:'ve| have| am|'m)?\s*(?:not|n't|don't|do not|haven't|have not|lack|never)\b/gi,
    /\bi(?:'m| am)\s+(?:new to|not (?:yet )?(?:familiar|experienced|an expert|fluent))\b/gi,
    /\b(?:a|my|the)\s+gap\s+(?:in|is|would be)\b/gi,
    /\bi(?:'d| would| will)\s+(?:need|have)\s+to\s+(?:learn|ramp up|get up to speed)\b/gi,
    /\b(?:i\s+)?lack(?:ing)?\s+(?:(?:direct|professional|hands-on|commercial)\s+)?(?:experience|exposure)\b/gi,
  ].map((re) => ({ kind: 'volunteered_gap', re, hint: 'Volunteered gap. Never volunteer gaps in outbound prose; put it in the role notes instead.' })),
];

const WARN_PATTERNS: Pattern[] = [
  { kind: 'stock_phrase', re: /\b(?:delve|tapestry|testament to|thrilled|passionate about|in today's fast-paced|leverag(?:e|ing) my|synerg\w*|i am excited to apply|i'm excited to apply|dynamic team|perfect fit|resonates? (?:deeply )?with me|look no further)\b/gi, hint: 'Stock phrase. Use a plain, specific verb.' },
  { kind: 'bare_url_signature', re: /\n\s*https?:\/\/\S+(?:\s+https?:\/\/\S+)*\s*$/gi, hint: 'Signature should be the name only, no bare URLs.' },
];

export function wordCount(text: string | null | undefined): number {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

export function lintProse(text: string | null | undefined, { max_words }: { max_words?: number | null } = {}): LintResult {
  const s = String(text || '').replace(/[\u2018\u2019]/g, "'");
  const issues: LintIssue[] = [];
  // Several gap patterns can match the same words; report each stretch of text once per kind.
  const seen: { kind: string; from: number; to: number }[] = [];
  for (const { kind, re, hint } of ERROR_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const to = m.index + m[0].length;
      if (seen.some((x) => x.kind === kind && m.index < x.to && to > x.from)) continue;
      seen.push({ kind, from: m.index, to });
      const start = Math.max(0, m.index - 30);
      issues.push({ severity: 'error', kind, match: s.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim(), hint });
    }
  }
  for (const { kind, re, hint } of WARN_PATTERNS) {
    for (const m of s.matchAll(re)) issues.push({ severity: 'warn', kind, match: m[0].trim(), hint });
  }
  const words = wordCount(s);
  if (max_words && words > max_words) {
    issues.push({ severity: 'error', kind: 'too_long', match: `${words} words`, hint: `Cut to ${max_words} words or fewer.` });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), words, issues };
}
