// Anonymous usage analytics and crash reports, sent to PostHog only after the user opts in
// (set_usage_analytics, the first setup question). The tracker reads the opt-in from its database before every
// event, so a revoke in the MCP server also stops the board process at once. An event carries a random install
// id (deleted on revoke), short enum-like values (statuses, kinds, counts) and the plugin, Node and OS versions,
// and no person profile. A crash report adds the error type, a scrubbed message and the stack (scrubError).
//
// Env: DO_NOT_TRACK=1 or JOB_TRACKER_ANALYTICS=off stops sending regardless of the opt-in.
// JOB_TRACKER_POSTHOG_TOKEN and JOB_TRACKER_POSTHOG_HOST point a dev build at another project.

import { homedir, platform } from 'node:os';
import { basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// A PostHog project token can only send events, so it is public by design, like the one on a web page.
const TOKEN = 'phc_zdkRbCmonEsZgmBKmbCqHSfkeuud5Mw2Z7KxpkyZ9Vg8';
const HOST = 'https://us.i.posthog.com';

export type Prop = string | number | boolean | null | undefined;
export type Send = (url: string, body: string) => Promise<unknown>;

// Only short lowercase tokens pass (statuses, kinds, actors). Anything that could be free text becomes 'other'.
const SAFE = /^[a-z][a-z0-9_-]{0,31}$/;

const fetchSend: Send = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });

// The plugin folder: stack frames inside it are sent relative to it, frames anywhere else by file name only.
export const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Frame = { platform: 'node:javascript'; filename: string; function?: string; lineno?: number; colno?: number; in_app: boolean };
export type ExceptionReport = { type: string; value: string; mechanism: { type: 'generic'; handled: boolean; synthetic: false }; stacktrace?: { type: 'raw'; frames: Frame[] } };

const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

function scrubFile(file: string): { filename: string; in_app: boolean } {
  const path = file.startsWith('file://') ? fileURLToPath(file) : file;
  if (path.startsWith(PLUGIN_ROOT)) return { filename: path.slice(PLUGIN_ROOT.length).split(sep).join('/'), in_app: true };
  if (path.startsWith('node:')) return { filename: path, in_app: false };
  return { filename: basename(path), in_app: false };
}

// Error messages can quote whatever the tracker was handling (a company, a CV path, a posting URL, a JSON
// snippet). Only what describes the failure is kept: the first word of an Error's message, lowercase and
// all-caps words, and quoted code identifiers such as 'location_line'.
function scrubMessage(message: string, keepFirst: boolean): string {
  let m = message.slice(0, 500).split(homedir()).join('~');
  m = m.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
  m = m.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
  m = m.replace(/(?:~|[A-Za-z]:)?[\\/][^\s'"`,;)]+/g, '<path>');
  m = m.replace(/(["'`])(.*?)\1/g, (whole, q: string, inner: string) => (/^[a-z_$][\w$.]{0,40}$/.test(inner) ? whole : `${q}<redacted>${q}`));
  m = m.replace(/\+?\d[\d\s-]{4,}\d/g, '<number>');
  // Capitalised words are treated as names (a company, a person, a city), except an Error's first word.
  m = m.replace(keepFirst ? /(?<=\S\s+)\p{Lu}\p{Ll}[\p{L}'-]*/gu : /\p{Lu}\p{Ll}[\p{L}'-]*/gu, '<name>');
  return m.replace(/(?:<name>\s*)+<name>/g, '<name>');
}

// Turns anything thrown into PostHog's $exception_list with personal data stripped. Frames go oldest first.
export function scrubError(err: unknown, { handled }: { handled: boolean }): { $exception_list: ExceptionReport[] } {
  const e = err instanceof Error ? err : null;
  const name = e?.name ?? (err && typeof err === 'object' && 'name' in err ? String(err.name) : '');
  const type = /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
  const raw = e ? e.message : err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  const report: ExceptionReport = { type, value: scrubMessage(raw, !!e), mechanism: { type: 'generic', handled, synthetic: false } };
  const frames: Frame[] = [];
  for (const line of (e?.stack ?? '').split('\n').slice(1)) {
    const f = FRAME.exec(line);
    if (!f) continue;
    // A FRAME match always has the file, line and column groups.
    const fn = f[1] && /^[\w$.<>[\] ]{1,80}$/.test(f[1]) ? f[1] : undefined;
    frames.push({ platform: 'node:javascript', ...scrubFile(f[2]!), function: fn, lineno: Number(f[3]), colno: Number(f[4]) });
  }
  if (frames.length) report.stacktrace = { type: 'raw', frames: frames.slice(0, 50).reverse() };
  return { $exception_list: [report] };
}

export class Analytics {
  readonly #send: Send;
  readonly #url: string;
  readonly #token: string;
  readonly #off: boolean;
  readonly #base: Record<string, Prop>;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor({ version, send = fetchSend, env = process.env }: { version: string; send?: Send; env?: Record<string, string | undefined> }) {
    this.#send = send;
    this.#token = env.JOB_TRACKER_POSTHOG_TOKEN || TOKEN;
    this.#url = `${(env.JOB_TRACKER_POSTHOG_HOST || HOST).replace(/\/+$/, '')}/i/v0/e/`;
    this.#off = (!!env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0') || env.JOB_TRACKER_ANALYTICS === 'off';
    this.#base = { plugin_version: version, node_major: Number(process.versions.node.split('.')[0]), os: platform() };
  }

  // installId is null unless the user opted in. Never throws and never waits: analytics must not slow or
  // break the tracker call that triggered it.
  capture(installId: string | null | undefined, event: string, props: Record<string, Prop> = {}): void {
    this.#post(installId, event, () => this.#props(props));
  }

  // A bug, not a ToolError. handled: false when it would have crashed the process.
  captureException(installId: string | null | undefined, err: unknown, props: Record<string, Prop> & { handled?: boolean } = {}): void {
    const { handled = true, ...rest } = props;
    this.#post(installId, '$exception', () => ({ ...this.#props(rest), ...scrubError(err, { handled }), $exception_level: 'error' }));
  }

  #props(props: Record<string, Prop>): Record<string, Prop> {
    const properties: Record<string, Prop> = { ...this.#base, $process_person_profile: false, $geoip_disable: true, $lib: 'job-tracker' };
    for (const [k, v] of Object.entries(props)) properties[k] = typeof v === 'string' && !SAFE.test(v) ? 'other' : v;
    return properties;
  }

  #post(installId: string | null | undefined, event: string, properties: () => Record<string, unknown>): void {
    if (!installId || this.#off) return;
    try {
      const body = JSON.stringify({ api_key: this.#token, event, distinct_id: installId, properties: properties(), timestamp: new Date().toISOString() });
      const p = this.#send(this.#url, body).catch(() => {});
      this.#inflight.add(p);
      void p.finally(() => this.#inflight.delete(p));
    } catch {
      // Best effort.
    }
  }

  // Gives events still in flight a bounded chance to leave before the process exits.
  async flush(ms = 2000): Promise<void> {
    if (!this.#inflight.size) return;
    await Promise.race([Promise.allSettled([...this.#inflight]), new Promise((r) => setTimeout(r, ms).unref())]);
  }
}
