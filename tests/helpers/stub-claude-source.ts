import { mkdtempSync, writeFileSync } from '../support/fenced-fs.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

/** A native peer answers SDK initialization and calls its real permission callbacks over stdin/stdout. */
export function stubClaudeSource(lines: readonly string[], calls: readonly Record<string, unknown>[] = [], failure?: 'timeout' | 'throw'): string {
  const bin = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-claude-source-')));
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(join(bin, 'argv.txt'))}, process.argv.slice(2).join('\\n'));
fs.writeFileSync(${JSON.stringify(join(bin, 'cwd.txt'))}, process.cwd());
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const pending = new Map();
let callback;
let started = false;
const rl = readline.createInterface({input:process.stdin});
rl.on('line', async line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    callback = message.request.hooks.PreToolUse[0].hookCallbackIds[0];
    fs.writeFileSync(${JSON.stringify(join(bin, 'initialize.json'))}, JSON.stringify(message.request));
    send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});
  } else if (message.type === 'control_response') {
    const done = pending.get(message.response.request_id);
    if (done) done(message.response);
  } else if (message.type === 'user' && !started) {
    started = true;
    fs.writeFileSync(${JSON.stringify(join(bin, 'prompt.json'))}, JSON.stringify(message.message.content));
    const decisions = [];
    for (const [at, call] of ${JSON.stringify(calls)}.entries()) {
      const tool_use_id = 'tool-' + at;
      const ask = async request => {
        const request_id = 'request-' + pending.size;
        const answer = new Promise(resolve => pending.set(request_id, resolve));
        send({type:'control_request',request_id,request:{...request,tool_use_id}});
        return answer;
      };
      const failure = ${JSON.stringify(failure ?? null)};
      const result = failure === 'timeout' ? null : await ask({subtype:'hook_callback',callback_id:callback,input:{hook_event_name:'PreToolUse',cwd:process.cwd(),...call,...(failure === 'throw' ? {tool_name:null} : {})}});
      let decision = result?.subtype === 'success' ? result.response.hookSpecificOutput.permissionDecision : null;
      const argv = process.argv.slice(2);
      const settingsAt = argv.indexOf('--settings');
      const settings = settingsAt < 0 ? {} : JSON.parse(argv[settingsAt + 1]);
      const forceAsk = settings.permissions?.ask?.includes(call.tool_name);
      if (decision === 'ask' || forceAsk && decision !== 'deny') {
        const permission = await ask({subtype:'can_use_tool',tool_name:call.tool_name,input:call.tool_input});
        decision = permission.subtype === 'success' ? permission.response.behavior : 'deny';
      } else if (decision === null) {
        // A failed hook falls through to native literal allows and in-cwd read approval.
        const allowedAt = argv.indexOf('--allowedTools');
        const rules = allowedAt < 0 ? [] : argv[allowedAt + 1].split(',');
        decision = rules.some(rule => rule.startsWith(call.tool_name + '(')) || call.tool_name === 'Read' && call.tool_input.file_path.startsWith(process.cwd() + '/') ? 'allow' : 'deny';
      }
      if (decision === 'allow' && call.tool_name === 'Read') fs.readFileSync(call.tool_input.file_path);
      decisions.push(decision);
    }
    fs.writeFileSync(${JSON.stringify(join(bin, 'decisions.json'))}, JSON.stringify(decisions));
    for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + '\\n');
    process.exit(0);
  }
});
`, { mode: 0o755 });
  return bin;
}
