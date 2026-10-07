// Model decision comparison, NOT a live Desktop callback or end-to-end tool test.
// Actual unmodified policy text is supplied; expected outcomes never reach the model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/pm-progress-decisions.json'), 'utf8'));
const product = '模板交付包/';
const changedRules = ['skills/identity-pm/SKILL.md', 'skills/identity-pm/references/lifecycle-and-closeout.md',
  'skills/identity-pm/references/cross-task-coordination.md', 'skills/identity-worker/SKILL.md'];
const sharedRules = ['AGENTS.md', 'docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md'];
const sha = text => createHash('sha256').update(text).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const baselineIndex = process.argv.indexOf('--baseline-ref');
const baselineRef = baselineIndex < 0 ? 'v3.2.10' : process.argv[baselineIndex + 1];
if (!baselineRef || baselineRef.startsWith('--')) throw Error('--baseline-ref requires an existing Git ref');
const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const cli = process.env.BEYOND_PROBE_CLI ?? path.join(process.env.APPDATA ?? '', 'npm/codex.ps1');
const kinds = ['send', 'continue_local', 'accept', 'pause', 'ack', 'enqueue', 'progress_callback', 'terminal_callback', 'wait', 'create', 'close'];
const schema = {
  description: 'actions只记录本轮实际执行的副作用。wait仅表示调用阻塞等待工具，不包括结束回答后等待用户确认；后者在userReply说明。target统一填所属Worker的W编号（ack也如此），回源统一填PM，不填回执编号或角色别称。',
  type: 'object', additionalProperties: false, required: ['results'], properties: { results: {
    type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'actions', 'businessState', 'reason', 'userReply'], properties: {
        id: { type: 'string' }, businessState: { type: 'string', enum: ['进行中', '已暂停', '已完成', '混合'] },
        actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'target', 'purpose'],
          properties: { kind: { type: 'string', enum: kinds }, target: { type: 'string', enum: ['PM', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'] }, purpose: { type: 'string' } } } },
        reason: { type: 'string' }, userReply: { type: 'string' },
      },
    },
  } },
};

function decisionInput(rules) {
  const cases = fixture.cases.map(({ expectedActions, expectedState, ...input }) => input);
  return `这是隔离决策测试，不是真实任务派发。不要调用业务工具或联系任务。以下是本轮唯一使用的产品规则全文：\n${Object.entries(rules).map(([f, t]) => `\n--- ${f} ---\n${t}`).join('\n')}\n\n分别处理下面每个独立场景，场景之间不共享状态。事实均由测试环境提供，已说明核对完成的内容可直接使用，不必虚构再次读取。不要解释规则，给出该角色本轮确实需要执行的有副作用动作及面向用户的回答。actions只记录发送任务消息、继续本地业务、验收/暂停/ack/enqueue、回源、等待、新建或关闭；普通读取不计入。没有必要动作就空数组，不为填表制造动作。Worker阶段结果未完成的businessState仍是进行中，continue_local指本轮继续做业务而非结束后自我续派。不同任务状态可用混合。发送动作purpose须说明具体剩余结果或已解除条件。reason简述判断，userReply用人话完整回答当前问题，不捏造尚未执行的成果。只返回符合下列schema的JSON。\n${JSON.stringify(schema)}\n${JSON.stringify(cases, null, 2)}`;
}

function evaluate(output) {
  const results = output.results ?? [];
  const failures = [];
  for (const item of fixture.cases) {
    const matches = results.filter(r => r.id === item.id);
    if (matches.length !== 1) { failures.push(`${item.id}: expected exactly one result`); continue; }
    const result = matches[0];
    const actions = result.actions.map(a => `${a.kind}:${a.target}`);
    if (JSON.stringify([...actions].sort()) !== JSON.stringify([...item.expectedActions].sort())) {
      failures.push(`${item.id}: actions ${JSON.stringify(actions)} != ${JSON.stringify(item.expectedActions)}`);
    }
    if (result.businessState !== item.expectedState) failures.push(`${item.id}: state ${result.businessState}`);
    // Transaction ordering matters; ack never precedes its state commit.
    for (const action of result.actions.filter(a => a.kind === 'ack')) {
      const commit = result.actions.findIndex(a => a.target === action.target && ['accept', 'pause'].includes(a.kind));
      if (commit < 0 || commit >= result.actions.indexOf(action)) failures.push(`${item.id}: premature ack`);
    }
    if (item.id === 'true-pause' && actions.join(',') !== item.expectedActions.join(',')) failures.push(`${item.id}: callback before enqueue`);
  }
  if (results.length !== fixture.cases.length) failures.push('unexpected result count');
  return { cases: fixture.cases.length, passed: fixture.cases.filter(c => !failures.some(f => f.startsWith(c.id + ':'))).length,
    failures, note: 'Action/state assertions only. Reasons and user-facing replies require separate semantic review.' };
}

if (process.argv.includes('--check-fixtures')) {
  if (new Set(fixture.cases.map(c => c.id)).size !== fixture.cases.length) throw Error('duplicate fixture id');
  for (const c of fixture.cases) if (!c.request || !c.facts || !c.role || !c.expectedState) throw Error('incomplete fixture');
  const good = { results: fixture.cases.map(c => ({ id: c.id, actions: c.expectedActions.map(a => {
    const [kind, target] = a.split(':'); return { kind, target, purpose: 'checker self-test' };
  }), businessState: c.expectedState })) };
  if (evaluate(good).failures.length) throw Error('checker rejected its oracle');
  const mutations = [
    data => data.results[0].actions.push({ kind: 'send', target: 'W5' }),
    data => { data.results[3].actions = []; },
    data => { data.results[7].actions.reverse(); },
    data => { data.results[15].actions.pop(); },
  ];
  for (const mutate of mutations) { const data = structuredClone(good); mutate(data); if (!evaluate(data).failures.length) throw Error('checker missed mutation'); }
  console.log(JSON.stringify({ cases: fixture.cases.length, checkerMutations: mutations.length, passed: true }));
} else if (process.argv.includes('--evaluate')) {
  const file = path.resolve(process.argv[process.argv.indexOf('--evaluate') + 1]);
  const verdict = evaluate(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(JSON.stringify(verdict, null, 2)); if (verdict.failures.length) process.exitCode = 1;
} else if (process.argv.includes('--prepare-native')) {
  // Native isolated agents can consume these blinded inputs without CLI credentials.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-native-decisions-'));
  const common = Object.fromEntries(sharedRules.map(f => [f, git('show', `${baselineRef}:${product}${f}`)]));
  const variants = {
    A: Object.fromEntries(changedRules.map(f => [f, git('show', `${baselineRef}:${product}${f}`)])),
    B: Object.fromEntries(changedRules.map(f => [f, fs.readFileSync(path.join(root, product, f), 'utf8')])),
  };
  for (const [label, rules] of Object.entries(variants)) write(path.join(scratch, `input-${label}.txt`), decisionInput({ ...common, ...rules }));
  write(path.join(scratch, 'binding.json'), {
    sourceHead: git('rev-parse', 'HEAD').trim(), baselineCommit: git('rev-parse', `${baselineRef}^{commit}`).trim(), variants: { A: 'baseline', B: 'candidate' },
    fixtureSha256: sha(JSON.stringify(fixture)),
    inputs: Object.fromEntries(['A', 'B'].map(label => [label, sha(fs.readFileSync(path.join(scratch, `input-${label}.txt`)))])),
    limitations: ['Real model decisions, not Desktop callback delivery', 'Reconstructed cases, not full raw history', 'No reliability-rate claim from a small sample'],
  });
  console.log(JSON.stringify({ scratch, cases: fixture.cases.length, inputs: ['input-A.txt', 'input-B.txt'] }));
} else if (process.argv.includes('--run')) {
  if (!fs.existsSync(cli)) throw Error('Provide BEYOND_PROBE_CLI pointing to the installed Codex CLI');
  const homeConfig = fs.readFileSync(path.join(sourceHome, 'config.toml'), 'utf8');
  const modelLines = homeConfig.split(/\r?\n/).filter(l => /^model\s*=|^model_reasoning_effort\s*=/.test(l)).join('\n');
  const provider = homeConfig.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1];
  if (provider && provider !== 'openai') throw Error('This probe requires the existing OpenAI account, not a guessed third-party provider');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-progress-decisions-'));
  const home = path.join(scratch, 'codex-home'); fs.mkdirSync(home);
  const authCopy = path.join(home, 'auth.json');
  const runs = [];
  try {
    fs.copyFileSync(path.join(sourceHome, 'auth.json'), authCopy);
    write(path.join(home, 'config.toml'), `${modelLines}\napproval_policy = "never"\n[features]\nshell_tool = false\n`);
    const baseline = Object.fromEntries(changedRules.map(f => [f, git('show', `${baselineRef}:${product}${f}`)]));
    const candidate = Object.fromEntries(changedRules.map(f => [f, fs.readFileSync(path.join(root, product, f), 'utf8')]));
    const common = Object.fromEntries(sharedRules.map(f => [f, git('show', `${baselineRef}:${product}${f}`)]));
    const bind = rules => Object.fromEntries(Object.entries(rules).map(([f, text]) => [f, sha(text)]));
    write(path.join(scratch, 'binding.json'), { sourceHead: git('rev-parse', 'HEAD').trim(), baselineCommit: git('rev-parse', `${baselineRef}^{commit}`).trim(), modelLines,
      fixtureSha256: sha(JSON.stringify(fixture)), baseline: bind(baseline), candidate: bind(candidate), common: bind(common),
      limitations: ['Deidentified reconstructed scenarios, not raw history replay', 'Structured decisions only; no live task messages or runtime writes',
        'No Desktop busy-turn injection or wakeup test', 'Two samples per variant cannot establish a reliability rate'] });
    write(path.join(scratch, 'schema.json'), schema);
    console.log(`Evidence: ${scratch}`);
    for (let round = 1; round <= 2; round++) {
      for (const variant of round === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const directory = path.join(scratch, `${variant}-${round}`); fs.mkdirSync(directory);
        const rules = { ...common, ...(variant === 'baseline' ? baseline : candidate) };
        const input = decisionInput(rules);
        write(path.join(directory, 'input.txt'), input);
        const args = ['exec', '--disable', 'plugins', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
          '--json', '-C', directory, '--output-schema', path.join(scratch, 'schema.json'), '-o', path.join(directory, 'final.json'), '-'];
        const started = Date.now();
        console.log(`Starting ${variant}-${round}`);
        const status = await new Promise((resolve, reject) => {
          const direct = cli.endsWith('.exe');
          const child = spawn(direct ? cli : 'pwsh.exe', direct ? args : ['-NoProfile', '-File', cli, ...args], {
            cwd: directory, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          });
          const out = fs.createWriteStream(path.join(directory, 'events.jsonl'));
          const err = fs.createWriteStream(path.join(directory, 'stderr.log'));
          const timer = setTimeout(() => {
            // Killing only a PowerShell wrapper can leave its CLI child holding
            // pipes open. End only this test-owned process tree on timeout.
            if (process.platform === 'win32' && Number.isInteger(child.pid)) {
              try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
              catch { child.kill(); }
            } else child.kill();
          }, 300000);
          child.stdout.pipe(out); child.stderr.pipe(err); child.stdin.end(input);
          child.on('error', error => { clearTimeout(timer); reject(error); });
          child.on('close', code => { clearTimeout(timer); out.end(() => err.end(() => resolve(code))); });
        });
        if (status !== 0) {
          runs.push({ variant, round, status, durationMs: Date.now() - started, verdict: 'cannot-judge', reason: 'CLI failed before a valid model result' });
          throw Error(`${variant}-${round}: CLI exited ${status}; no behavioral verdict`);
        }
        const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const toolEvents = events.filter(e => /^item\./.test(e.type) && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(e.item?.type));
        if (toolEvents.length) throw Error('Decision-only probe unexpectedly attempted tools');
        const result = evaluate(JSON.parse(fs.readFileSync(path.join(directory, 'final.json'), 'utf8')));
        const run = { variant, round, status, durationMs: Date.now() - started, ...result };
        runs.push(run); write(path.join(directory, 'verdict.json'), run);
        console.log(`${variant}-${round}: ${result.passed}/${result.cases}; failures=${result.failures.length}`);
      }
    }
  } finally {
    // Remove only the credential copy created by this run, never source authentication.
    if (fs.existsSync(authCopy)) fs.unlinkSync(authCopy);
    write(path.join(scratch, 'results.json'), { runs, credentialCopyRemoved: !fs.existsSync(authCopy) });
    console.log('Isolated credential copy removed.');
  }
  if (runs.some(r => r.variant === 'candidate' && r.failures.length)) process.exitCode = 1;
} else {
  console.log('Usage: --check-fixtures | --prepare-native [--baseline-ref <ref>] | --run [--baseline-ref <ref>] | --evaluate <final.json>');
}
