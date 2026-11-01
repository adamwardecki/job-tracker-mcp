import { ToolError } from './errors.ts';

// An exact posting on a known ATS. Deliberately separate from fuzzy.ts::atsFromUrl, whose tenant slug is for
// company matching and says nothing about which posting a URL points at.
export interface PostingKey {
  provider: string;
  employer_key: string;
  posting_id: string;
}

// Query parameters that only record where a click came from. Anything else may select the posting, so it stays.
// Names match exactly as listed (case-sensitive): a differently-cased name is an unknown parameter and may matter.
const TRACKING_PARAMS = new Set(['gh_src', 'lever-source', 'lever-origin', 'trk', 'trackingId']);

// Path words that can follow a posting ID (/application, /apply) or sit where a board page has none (/embed, /jobs).
// Read as an ID they would give every board the same bogus posting.
const RESERVED_IDS = new Set(['application', 'apply', 'embed', 'jobs']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function paramName(piece: string): string {
  const raw = piece.split('=', 1)[0] ?? '';
  return safeDecode(raw.replace(/\+/g, ' ')) ?? raw;
}

function isTracking(piece: string): boolean {
  // A ';' may be a legacy parameter separator, so the piece can hide a second, significant parameter.
  if (piece.includes(';')) return false;
  const name = paramName(piece);
  return name.startsWith('utm_') || TRACKING_PARAMS.has(name);
}

// Posting IDs keep their case: only UUIDs are documented as case-insensitive.
const postingId = (id: string): string => (UUID.test(id) ? id.toLowerCase() : id);

function key(provider: string, employer: string | null | undefined, id: string | null | undefined): PostingKey | null {
  if (!employer || !id) return null;
  if (!employer.trim() || !id.trim() || RESERVED_IDS.has(id.toLowerCase())) return null;
  return { provider, employer_key: employer.toLowerCase(), posting_id: postingId(id) };
}

// The value of a query parameter that appears exactly once and decodes cleanly, else null. Read from the raw query
// because URLSearchParams silently turns bad escapes into U+FFFD and returns only the first of a repeated name.
// Stricter than a path slug: whitespace (including a decoded '+') or a ';' means the value is ambiguous.
function single(u: URL, name: string): string | null {
  // ';' may separate a parameter inside a piece, so look inside each piece for the name.
  const named = u.search.slice(1).split('&').filter((piece) => piece.split(';').some((sub) => paramName(sub) === name));
  const [piece, ...rest] = named;
  if (piece === undefined || rest.length > 0 || piece.includes(';') || !piece.includes('=')) return null;
  const value = safeDecode(piece.slice(piece.indexOf('=') + 1).replace(/\+/g, ' '));
  return value === null || /\s/.test(value) ? null : value;
}

// Greenhouse job IDs are numeric; anything else (a slug, a board page) is not a posting we can name.
const greenhouse = (employer: string | null | undefined, id: string | null | undefined) => (id && /^\d+$/.test(id) ? key('greenhouse', employer, id) : null);

// Each provider is strict about its path shape: a URL that merely looks similar yields null (URL-only) rather than a guess.
function identify(u: URL): PostingKey | null {
  const host = u.hostname.replace(/\.$/, '');
  const decoded = u.pathname.split('/').filter(Boolean).map(safeDecode);
  if (!decoded.every((seg) => seg !== null)) return null;
  const s = decoded;
  // The path is exactly n segments, optionally followed by one known suffix word.
  const pathIs = (n: number, suffix: string) => s.length === n || (s.length === n + 1 && s[n] === suffix);
  if (host === 'jobs.ashbyhq.com') return pathIs(2, 'application') ? key('ashby', s[0], s[1]) : null;
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return pathIs(2, 'apply') ? key('lever', s[0], s[1]) : null;
  if (host === 'apply.workable.com') return s[1] === 'j' && pathIs(3, 'apply') ? key('workable', s[0], s[2]) : null;
  if (host === 'boards-api.greenhouse.io') return s.length === 5 && s[0] === 'v1' && s[1] === 'boards' && s[3] === 'jobs' ? greenhouse(s[2], s[4]) : null;
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (s[0] === 'embed') return s.length === 2 && s[1] === 'job_app' ? greenhouse(single(u, 'for'), single(u, 'token')) : null;
    return s.length === 3 && s[1] === 'jobs' ? greenhouse(s[0], s[2]) : null;
  }
  return null;
}

export function parsePostingUrl(raw: string): { normalized_url: string; posting: PostingKey | null } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ToolError(`Not a valid URL: ${JSON.stringify(raw)}. Pass the full http(s) link to the posting.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('Only http(s) URLs are accepted.');
  if (u.username || u.password) throw new ToolError('URL must not contain credentials (user:password@). Remove them and pass the plain link.');
  // Filter the raw query pieces instead of round-tripping URLSearchParams, which would re-encode values we must not touch.
  const pieces = u.search.slice(1).split('&').filter((p) => p && !isTracking(p));
  u.search = pieces.join('&');
  const posting = identify(u);
  // A hash route (#/jobs/1, #!/jobs/1) can select the posting on a single-page careers site; other fragments are page anchors.
  if (posting || !/^#[/!]/.test(u.hash)) u.hash = '';
  return { normalized_url: u.href, posting };
}
