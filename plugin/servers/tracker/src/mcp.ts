// Minimal MCP (JSON-RPC 2.0) handler: initialize, ping, tools/list, tools/call.

import { ToolError } from './errors.ts';
import { checkArgs, TOOL_MAP, TOOLS } from './tools.ts';
import type { Tracker } from './tracker.ts';
import { errorMessage, errorText, isRecord } from './util.ts';

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId | undefined;
  result?: unknown;
  error?: { code: number; message: string };
}

// A batch request gets an array of replies (nested as the batch was).
export type RpcReply = RpcResponse | RpcReply[];
export type RpcHandler = (msg: unknown) => Promise<RpcReply | null>;

export const SERVER_INFO = { name: 'job-hunt-tracker', version: '0.5.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Job-hunt tracker: the single source of truth for companies, roles, events, rules and config.
Call setup_status first in every run. Dedupe every lead with find_company before doing any work on it.
Statuses move only through transition (found → verified → scored → queued → applied → interviewing → offer; dropped; closed).
Every event needs a reason; drops need a verbatim employer quote or rule:<id>; applied needs confirmation text.
Gmail drafts are claimed only after verify_artifact with the read-back.`;

export function makeHandler(tracker: Tracker, { log = () => {} }: { log?: (msg: string) => void } = {}): RpcHandler {
  return async function handle(msg: unknown): Promise<RpcReply | null> {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter((r) => r !== null);
      return out.length ? out : null;
    }
    // Whatever arrived on the wire; every field is checked before use.
    const { id, method, params } = (msg || {}) as RpcRequest;
    const isNotification = id === undefined || id === null;
    const reply = (result: unknown): RpcResponse | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): RpcResponse | null => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          return reply({
            protocolVersion: requested && SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = typeof params?.name === 'string' ? TOOL_MAP.get(params.name) : undefined;
          if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
          const args = params?.arguments || {};
          const errors = checkArgs(tool, args);
          if (errors.length) return reply(toolResult({ error: `Invalid arguments: ${errors.join('; ')}` }, true));
          try {
            // checkArgs has matched args against this tool's inputSchema, which is what the handler's type says.
            const result = await tool.handler(tracker, args as never);
            return reply(toolResult(result, false));
          } catch (err) {
            if (!(err instanceof ToolError)) log(`tool ${tool.name} failed: ${errorText(err)}`);
            return reply(toolResult({ error: errorMessage(err) }, true));
          }
        }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      log(`request failed: ${errorText(err)}`);
      return fail(-32603, errorMessage(err));
    }
  };
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

function toolResult(result: unknown, isError: boolean): ToolResult {
  const text = isRecord(result) && typeof result.markdown === 'string' && !isError ? result.markdown : JSON.stringify(result, null, 2);
  const out: ToolResult = { content: [{ type: 'text', text }], isError };
  if (!isError && isRecord(result)) out.structuredContent = result;
  return out;
}
