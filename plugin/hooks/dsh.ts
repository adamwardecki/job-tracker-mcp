#!/usr/bin/env node

// DeepSeek Harness entry point: node hooks/dsh.ts pre-tool | post-tool | prompt | stop
// dsh's Claude Code hook bridge runs this from hooks/dsh-hooks.json with Claude Code payloads, minus the
// transcript (transcript_path is always '') and the stop loop flag (stop_hook_active is always false).
// This fills both in from our own step log and session file, then runs the shared gates in gates.ts.

import { errorText } from '../servers/tracker/src/util.ts';
import { handlers, setOutput } from './gates.ts';
import { isBrowser, isSendTool, splitToolName } from './lib/classify.ts';
import type { DshPayload } from './lib/hosts/dsh.ts';
import { gatePrompt } from './lib/hosts/dsh.ts';
import { loadSession } from './lib/session.ts';
import { stepsPath, writeStep } from './lib/steps.ts';
import type { HookOutput } from './lib/types.ts';

// The bridge lets a hook that times out pass, so stop before its 30 s timeout and fail the way a crash does.
const DEADLINE_MS = 10_000;

const event = process.argv[2];
// Declared wide: setOutput's callback assigns it, which flow analysis cannot see.
let captured = null as HookOutput | null;
setOutput((o) => {
  captured = o;
});
const print = (o: unknown) => process.stdout.write(JSON.stringify(o));

let p: DshPayload = {};

// Same rule as main.ts: a crash must not let a submit or a send through; anything else passes. Exit 2 is a
// block in the bridge. Any other non-zero exit passes, except in the browser and mail matcher group of
// dsh-hooks.json, which turns every failure into a block.
function fail(why: string): never {
  process.stderr.write(`[job-hunt hook] ${why}\n`);
  const { server, short } = splitToolName(p.tool_name);
  if (event === 'pre-tool' && (isBrowser(server) || isSendTool(server, short))) {
    process.stderr.write('[job-hunt] The gate could not finish, so this browser or send action is blocked. Tell the user.\n');
    process.exit(2);
  }
  process.exit(1);
}

const deadline = setTimeout(() => fail(`timed out after ${DEADLINE_MS} ms`), DEADLINE_MS);

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  p = JSON.parse(raw || '{}') as DshPayload; // dsh-hooks-claude-code's hook input.
  const sid = p.session_id || 'unknown';
  const transcript_path = stepsPath(sid);

  if (event === 'post-tool') {
    writeStep(sid, p.tool_use_id, String(p.tool_name || ''), p.tool_input, p.tool_response);
  } else if (event === 'pre-tool') {
    await handlers['pre-tool']({ session_id: sid, tool_name: p.tool_name, tool_input: p.tool_input || {}, transcript_path });
    if (captured) print(captured);
  } else if (event === 'prompt') {
    const { prompt, command, args } = gatePrompt(p.prompt);
    await handlers.prompt({ session_id: sid, prompt, transcript_path });
    const notes: string[] = [];
    if (captured?.hookSpecificOutput?.additionalContext) notes.push(captured.hookSpecificOutput.additionalContext);
    // dsh injects the skill body as written, so tell the model what $ARGUMENTS stands for.
    if (command && args) notes.push(`[job-hunt] In this command, $ARGUMENTS = "${args}".`);
    if (notes.length) print({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n') } });
  } else if (event === 'stop') {
    // Without the bridge's flag, a block already sent this session means the model is being held.
    const before = loadSession(sid);
    await handlers.stop({ session_id: sid, transcript_path, stop_hook_active: (before.stop_blocks || 0) > 0 });
    if (captured) print(captured);
  } else {
    throw new Error(`unknown event "${event}"`);
  }
  clearTimeout(deadline);
} catch (err) {
  fail(errorText(err));
}
