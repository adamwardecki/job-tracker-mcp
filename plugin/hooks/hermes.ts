#!/usr/bin/env node

// Hermes entry point: node hooks/hermes.ts pre_tool_call | post_tool_call | pre_llm_call | post_llm_call
// The Hermes plugin (../__init__.py) pipes the hook kwargs as JSON on stdin. This prints a Hermes
// directive, or nothing. The gate logic is shared with Claude Code (hooks/gates.ts); only the payload
// and output shapes are translated here.

import { errorText } from '../servers/tracker/src/util.ts';
import { handlers, setOutput } from './gates.ts';
import { isBrowser, isSendTool, splitToolName } from './lib/classify.ts';
import type { HermesPayload } from './lib/hosts/hermes.ts';
import { appendStep, normalizeToolName, unwrapSkillInvocation, userText } from './lib/hosts/hermes.ts';
import { loadSession, saveSession } from './lib/session.ts';
import { stepsPath } from './lib/steps.ts';
import type { HookOutput } from './lib/types.ts';

const event = process.argv[2];
// Declared wide: setOutput's callback assigns it, which flow analysis cannot see.
let captured = null as HookOutput | null;
setOutput((o) => {
  captured = o;
});
const print = (o: unknown) => process.stdout.write(JSON.stringify(o));

let p: HermesPayload = {};
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  p = JSON.parse(raw || '{}') as HermesPayload; // The Hermes hook kwargs from __init__.py.
  const sid = p.session_id || p.task_id || 'unknown';

  if (event === 'post_tool_call') {
    appendStep({ ...p, session_id: sid });
  } else if (event === 'pre_tool_call') {
    await handlers['pre-tool']({ session_id: sid, tool_name: normalizeToolName(p.tool_name), tool_input: p.args || {}, transcript_path: stepsPath(sid) });
    const h = captured?.hookSpecificOutput;
    if (h?.permissionDecision === 'deny') print({ action: 'block', message: h.permissionDecisionReason });
  } else if (event === 'pre_llm_call') {
    const notes: string[] = [];
    if (!p.parent_session_id) {
      // Subagent turns are written by the model, never by the user, so they cannot approve anything.
      const typed = userText(p.user_message);
      await handlers.prompt({ session_id: sid, prompt: typed, transcript_path: stepsPath(sid) });
      if (captured?.hookSpecificOutput?.additionalContext) notes.push(captured.hookSpecificOutput.additionalContext);
      const { skill, args } = unwrapSkillInvocation(typeof p.user_message === 'string' ? p.user_message : '');
      if (skill?.startsWith('job-tracker:') && args) notes.push(`[job-hunt] In this command, $ARGUMENTS = "${args}".`);
    }
    const session = loadSession(sid);
    if (session.pending_nudge) {
      notes.push(session.pending_nudge);
      delete session.pending_nudge;
      saveSession(sid, session);
    }
    if (notes.length) print({ context: notes.join('\n') });
  } else if (event === 'post_llm_call') {
    const before = loadSession(sid);
    await handlers.stop({ session_id: sid, transcript_path: stepsPath(sid), stop_hook_active: (before.stop_blocks || 0) > 0 });
    if (captured?.decision === 'block') {
      const session = loadSession(sid);
      session.pending_nudge = captured.reason;
      saveSession(sid, session);
      print({ action: 'continue', message: captured.reason });
    }
  } else {
    throw new Error(`unknown event "${event}"`);
  }
} catch (err) {
  process.stderr.write(`[job-hunt hook] ${errorText(err)}\n`);
  // Same rule as main.ts: a crash must not let a submit or a send through; anything else passes.
  if (event === 'pre_tool_call') {
    const { server, short } = splitToolName(normalizeToolName(p.tool_name));
    if (isBrowser(server) || isSendTool(server, short)) print({ action: 'block', message: '[job-hunt] The gate crashed, so this browser or send action is blocked. Tell the user.' });
  }
}
