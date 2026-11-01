import { ToolError } from './errors.ts';

// An exact posting on a known ATS. Deliberately separate from fuzzy.ts::atsFromUrl, whose tenant slug is for
// company matching and says nothing about which posting a URL points at.
export type PostingKey = { provider: string; employer_key: string; posting_id: string };

// Query parameters that only record where a click came from. Anything else may select the posting, so it stays.
const TRACKING_PARAMS = new Set(['gh_src', 'lever-source', 'lever-origin', 'trk', 'trackingid']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function isTracking(piece: string): boolean {
  const rawKey = piece.split('=', 1)[0] ?? '';
  const key = (safeDecode(rawKey) ?? rawKey).toLowerCase();
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

// Posting IDs keep their case: only UUIDs are documented as case-insensitive.
const postingId = (id: string): string => (UUID.test(id) ? id.toLowerCase() : id);

function key(provider: string, employer: string | null | undefined, id: string | null | undefined): PostingKey | null {
  if (!employer || !id) return null;
  return { provider, employer_key: employer.toLowerCase(), posting_id: postingId(id) };
}

// Every parser is strict about path shape: a URL that merely looks similar yields null (URL-only) rather than a guess.
function identify(u: URL): PostingKey | null {
  const host = u.hostname.replace(/\.$/, '');
  const decoded = u.pathname.split('/').filter(Boolean).map(safeDecode);
  if (decoded.includes(null)) return null;
  const s = decoded as string[]; // no nulls: checked above
  const only = (n: number, suffix?: string) => s.length === n || (suffix !== undefined && s.length === n + 1 && s[n] === suffix);
  if (host === 'jobs.ashbyhq.com') return only(2, 'application') ? key('ashby', s[0], s[1]) : null;
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return only(2, 'apply') ? key('lever', s[0], s[1]) : null;
  if (host === 'apply.workable.com') return s[1] === 'j' && only(3, 'apply') ? key('workable', s[0], s[2]) : null;
  if (host === 'boards-api.greenhouse.io') return s.length === 5 && s[0] === 'v1' && s[1] === 'boards' && s[3] === 'jobs' ? greenhouse(s[2], s[4]) : null;
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (s[0] === 'embed') return s.length === 2 && s[1] === 'job_app' ? greenhouse(u.searchParams.get('for'), u.searchParams.get('token')) : null;
    return s.length === 3 && s[1] === 'jobs' ? greenhouse(s[0], s[2]) : null;
  }
  return null;
}

// Greenhouse job IDs are numeric; anything else (a slug, a board page) is not a posting we can name.
const greenhouse = (employer: string | null | undefined, id: string | null | undefined) => (id && /^\d+$/.test(id) ? key('greenhouse', employer, id) : null);

export function parsePostingUrl(raw: string): { normalized_url: string; posting: PostingKey | null } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ToolError(`Not a valid URL: ${JSON.stringify(raw)}. Pass the full http(s) link to the posting.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('Only http(s) URLs are accepted.');
  if (u.username || u.password) throw new ToolError('URL must not contain credentials (user:password@). Remove them and pass the plain link.');
  u.hash = '';
  // Filter the raw query pieces instead of round-tripping URLSearchParams, which would re-encode values we must not touch.
  const pieces = u.search.slice(1).split('&').filter((p) => p && !isTracking(p));
  u.search = pieces.join('&');
  return { normalized_url: u.href, posting: identify(u) };
}
