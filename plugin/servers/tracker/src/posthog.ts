import { PostHog } from 'posthog-node';

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;

function warnMissing(name: string): void {
  process.stderr.write(`${name} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${name} is configured\n`);
}

if (!token) warnMissing('POSTHOG_PROJECT_TOKEN');
if (!host) warnMissing('POSTHOG_HOST');

export const posthog = token && host
  ? new PostHog(token, { host, enableExceptionAutocapture: true })
  : undefined;

export async function shutdownPostHog(): Promise<void> {
  await posthog?.shutdown(3_000).catch(() => {});
}
