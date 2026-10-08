import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const claudeHookEvents = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'PreModelSwitch'];
export async function forwardClaudeHook(event, input, connection, env = process.env) {
  if (!claudeHookEvents.includes(event) || input.hook_event_name !== event || typeof input.session_id !== 'string' || !input.session_id) throw new Error('Invalid Claude hook identity');
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || !connection.token) throw new Error('Invalid local Claude hook connection');
  const transport = event === 'SessionStart' ? { pipe: env.CLAUDE_CODE_MESSAGING_SOCKET, token: env.CLAUDE_CODE_MESSAGING_TOKEN } : undefined;
  const response = await fetch(new URL('hook', url), { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ input, transport }), signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Claude owner rejected hook');
  return response.json();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Claude hook input too large'); }
    const connection = JSON.parse(fs.readFileSync(process.env.BEYOND_CLAUDE_HOOK_CONNECTION, 'utf8'));
    process.stdout.write(JSON.stringify(await forwardClaudeHook(process.argv[2], JSON.parse(text), connection)));
  } catch {
    // Never print transport credentials or provider diagnostics. Deny untracked manual input.
    if (['UserPromptSubmit', 'PreModelSwitch'].includes(process.argv[2])) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'BEYOND owner connection unavailable; do not start untracked work.' }));
    else { process.stderr.write('BEYOND Claude hook could not reach its owner.\n'); process.exitCode = 1; }
  }
}
