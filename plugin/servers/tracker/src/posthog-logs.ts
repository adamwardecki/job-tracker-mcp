import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;

type LogAttributes = Record<string, string | number | boolean>;

const loggerProvider = token && host
  ? new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': 'job-hunt-tracker-mcp' }),
      processors: [
        new BatchLogRecordProcessor(new OTLPLogExporter({
          url: `${host.replace(/\/+$/, '')}/i/v1/logs`,
          headers: { Authorization: `Bearer ${token}` },
        })),
      ],
    })
  : undefined;

const logger = loggerProvider?.getLogger('job-hunt-tracker.posthog');

export function logPostHog(severityText: 'INFO' | 'WARN' | 'ERROR', body: string, attributes: LogAttributes = {}): void {
  logger?.emit({ severityText, body, attributes });
}

export async function shutdownPostHogLogs(): Promise<void> {
  if (!loggerProvider) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3_000);
    void loggerProvider.shutdown().catch(() => {}).finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
