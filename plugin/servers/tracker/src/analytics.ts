// Anonymous usage analytics, sent to PostHog only after the user opts in (set_usage_analytics, the last setup
// step). The tracker reads the opt-in from its database before every event, so a revoke in the MCP server also
// stops the board process at once. An event carries a random install id (deleted on revoke), short enum-like
// values (statuses, kinds, counts) and the plugin, Node and OS versions: never names, URLs, text or error
// messages, and no person profile.
//
// Env: DO_NOT_TRACK=1 or JOB_TRACKER_ANALYTICS=off stops sending regardless of the opt-in.
// JOB_TRACKER_POSTHOG_TOKEN and JOB_TRACKER_POSTHOG_HOST point a dev build at another project.

import { platform } from 'node:os';

// A PostHog project token can only send events, so it is public by design, like the one on a web page.
const TOKEN = 'phc_zdkRbCmonEsZgmBKmbCqHSfkeuud5Mw2Z7KxpkyZ9Vg8';
const HOST = 'https://us.i.posthog.com';

export type Prop = string | number | boolean | null | undefined;
export type Send = (url: string, body: string) => Promise<unknown>;

// Only short lowercase tokens pass (statuses, kinds, actors). Anything that could be free text becomes 'other'.
const SAFE = /^[a-z][a-z0-9_-]{0,31}$/;

const fetchSend: Send = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });

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
    if (!installId || this.#off) return;
    try {
      const properties: Record<string, Prop> = { ...this.#base, $process_person_profile: false, $geoip_disable: true, $lib: 'job-tracker' };
      for (const [k, v] of Object.entries(props)) properties[k] = typeof v === 'string' && !SAFE.test(v) ? 'other' : v;
      const body = JSON.stringify({ api_key: this.#token, event, distinct_id: installId, properties, timestamp: new Date().toISOString() });
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
