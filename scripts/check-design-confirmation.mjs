// Static contract/navigation and frozen-source regression only.
// Real model decisions, actual CLI model routing and Desktop callback delivery
// require separate evidence. Passing this file does not prove those behaviors.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = '模板交付包/';
const normalize = text => text.replace(/\r\n/g, '\n');
const read = file => normalize(readFileSync(join(root, file), 'utf8'));
const sha256 = text => createHash('sha256').update(normalize(text)).digest('hex');
const fixture = JSON.parse(read('scripts/fixtures/design-confirmation-frozen-baseline.json'));
const pm = product + 'skills/identity-pm/SKILL.md';
const design = product + 'skills/task-design/SKILL.md';
const rule = product + 'skills/task-design/references/complex-design-document-and-implementation.md';
const dev = product + 'skills/task-dev/SKILL.md';
const failure = product + 'skills/task-dev/references/implementation-delivery-and-failure.md';
const testing = product + 'skills/task-test/SKILL.md';
const guide = product + 'docs/AI编程协同机制/工程资料指南.md';
const agents = product + 'AGENTS.md';
const cli = product + 'docs/AI编程协同机制/机制/04-CLI目标协作机制.md';
const productTemplate = product + 'docs/AI编程协同机制/模板/产品设计与契约基线模板.md';
const architectureTemplate = product + 'docs/AI编程协同机制/模板/技术架构与核心代码逻辑模板.md';
// Explicitly authorized 2026-10-14 exception: only enqueue's final atomic
// replacement gains the existing bounded I/O retry. Keep the original hashes.
const receiptFile = product + 'scripts/runtime/worker-result-receipts.mjs';
const receiptRenameBefore = '        fs.renameSync(temporary, target);';
const receiptRenameAfter = [
  '        // Brief Windows sharing conflicts must not discard an otherwise valid receipt.',
  '        // Bound attempts without changing the lock or atomic replacement semantics.',
  '        retryTransientFileOperation(() => fs.renameSync(temporary, target), 200);',
].join('\n');
// Explicitly authorized 3.2.15 assist-owner transfer. Preserve the original
// fixture: only these reviewed complete contents replace their old hashes.
// Do not exempt CLI directories, callbacks, Skills or the model policy.
const assistTransferFingerprints = [
  { path: cli,
    before: 'f919553d21558e8265f8a59a7ee1b9321419cddd22912d86d112524f81604a51',
    after: 'ebedc6b6f61956d5a9d713bb48afcee3fa27941774dd5c430a8f52e1711b72a5' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '3b5a76f1f94124195ee0259ee97dc79dd96cc8f6392e938bd65bb582c8892660',
    after: '926f60ae449203194a25baca943f823511bdeadbe90e8e9ea740df0c402a6c35' },
  { path: product + 'scripts/cli/cli-task-store.mjs',
    before: '8ca4e392dff1ea77e8ebb32d07d7e5e8272b2798578c794218534f27876f4d60',
    after: 'a5ded774c6805b295fc86acc5b8348dd3a2ceb802273d59d143ccc1e69e1000f' },
];
// Authorized 2026-10-15 removal of Claude version gating, not a general freeze refresh.
// Normalize only these exact edits back to the already approved baseline.
const claudeCompatibilityEdits = [
  { path: product + 'scripts/cli/claude-profile.mjs', before: [
    '// Completion hooks are documented; interactive message injection is version-specific.',
    "export const CLAUDE_VERSION = '2.1.296';",
  ].join('\n'), after: [
    '// Probe executable availability, never a version allowlist or version range.',
    '// Native session identity, handshake and delivery checks remain authoritative.',
  ].join('\n') },
  { path: product + 'scripts/cli/claude-profile.mjs',
    before: "Claude effort unsupported by the pinned native CLI",
    after: "Claude effort unsupported by the native adapter" },
  { path: product + 'scripts/cli/claude-profile.mjs',
    before: "  if (version.status !== 0 || version.stdout.trim() !== `${CLAUDE_VERSION} (Claude Code)`) throw new Error('Claude Code version changed or unavailable; interactive adapter revalidation required');",
    after: "  if (version.error || version.status !== 0 || typeof version.stdout !== 'string' || !version.stdout.trim()) throw new Error('Claude Code version probe failed; executable unavailable or returned no version information');" },
  { path: cli, before: '`claude.exe 2.1.296`', after: '`claude.exe`，不设置精确版本白名单或版本范围' },
  { path: cli,
    before: '但向可见终端注入消息使用本机已验证版本的消息管道，并非上游稳定公共接口。版本变化必须重新验证；不要自行加入',
    after: '但向可见终端注入消息使用原生消息管道，并非上游稳定公共接口。版本信息仅用于诊断，不因升级或版本号未列举而拒绝启动、续跑或恢复；可执行文件不可用、实际握手或消息传递失败时仍准确报错，不承诺未来协议变化必然兼容。不要自行加入' },
];
// Only the reviewed compatibility-test revision is allowed; keep the fixture.
const claudeCompatibilityTestFingerprints = [
  { path: product + 'scripts/cli/claude-version-compatibility.test.mjs',
    before: 'c394825879c2327e183f23201dfdbe05c1a2abfea1581244c76f3e722268dbdf',
    after: 'e72ee3134cfec81b9700853c5af170d8ea37eef82e193f506f696a469c2d539c' },
];
// Authorized 4.0 capability repair. Chain from the approved source, never
// refresh the original freeze or exempt an entire CLI directory.
const zcodeCompatibilityFingerprints = [
  { path: cli,
    before: 'ebedc6b6f61956d5a9d713bb48afcee3fa27941774dd5c430a8f52e1711b72a5',
    after: 'f649c326dbd354cfd316e82495130d0707d96b99cde2fc02454d0f9f99f52fe9' },
  { path: product + 'scripts/cli/zcode-profile.mjs',
    before: '0195dcf24e942d20cc7dfe20182cc882e1f91a1d53ba651852aabbded5cbac59',
    after: '1b9c6c8f8e66d980f650b4831313b6673b1b96838fea89f4a85ffc9fa4b1db86' },
];
// Authorized 2026-10-16 CLI contract/background-command repairs. These exact
// contents chain to v4.0.0; the original fixture and other frozen files stay intact.
const cliContractTurnCompletionFingerprints = [
  { path: cli,
    before: 'f649c326dbd354cfd316e82495130d0707d96b99cde2fc02454d0f9f99f52fe9',
    after: '68bf7af9b07c35da6e60d1ab7f2fc1efde7dac3d6bb20d592fbd1d37a5316a1d' },
  { path: product + 'scripts/cli/claude-client.mjs',
    before: 'c2c57dd6a10ed1d9b343114e1f885d5186cb66416e995919952d341fe79bb66b',
    after: '11b889c69562eab7d3fba2bf1521ac8d94e847b022c797b167d6a237421fa32a' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '926f60ae449203194a25baca943f823511bdeadbe90e8e9ea740df0c402a6c35',
    after: '04dfb2af62b15a6532f960ed0b820bade36c6a2484f7d5ae375f8508a0f77991' },
  { path: product + 'scripts/cli/cli-task-store.mjs',
    before: 'a5ded774c6805b295fc86acc5b8348dd3a2ceb802273d59d143ccc1e69e1000f',
    after: 'fb2f0646092983106cc38de955e1d4654c75ab2d82f7aff7e3f45254c3b3f4f8' },
  { path: product + 'scripts/cli/interactive-cli-runner.mjs',
    before: 'e6f49e8b4d7efce4fd781e249e0bc5e9bb949d5c38cd7b358e3f4bb6899d88e0',
    after: 'fdab2cfe052b82162d29a5df9fdb5e89d409f1a16dacc57e4e291d644a576c42' },
  { path: product + 'scripts/cli/native-cli-runner.mjs',
    before: '4d1da06de84d65bb8a14441a4312b24ba503807f44cb22ed05958498deb0f2d3',
    after: '44ee001321a7ffcd67d41a88c359b1f8e37ecdc8eacfc02bc04cbd706ad1ee04' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: '73896a0d56cb22dfdd66a564cc4464588edde5de1b6c7b824245bea30c3a929a',
    after: '36a8fb5175a5c5e47c4a9f86896c2b0491eda5dd8abd93a28cbab9db22255feb' },
];
// Authorized 2026-10-16 stage and queued same-session continuation. Map only
// these six reviewed contents back through the prior seven-file repair chain.
const cliStageContinuationFingerprints = [
  { path: cli,
    before: '68bf7af9b07c35da6e60d1ab7f2fc1efde7dac3d6bb20d592fbd1d37a5316a1d',
    after: '2a37a1b36d4930ce3dac4617f68c70677511308e8fb24c971fafab540894cf9b' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '04dfb2af62b15a6532f960ed0b820bade36c6a2484f7d5ae375f8508a0f77991',
    after: '8c6b5aff293daa86e95fcfeae0109e960dc61b6e12798a4212920b4ea93ac9eb' },
  { path: product + 'scripts/cli/cli-task-store.mjs',
    before: 'fb2f0646092983106cc38de955e1d4654c75ab2d82f7aff7e3f45254c3b3f4f8',
    after: '4dbb0a14d681ee7db3eb951e344e52c0df76e27f5aa7ee9fbb23cd92a8e8a770' },
  { path: product + 'scripts/cli/interactive-cli-runner.mjs',
    before: 'fdab2cfe052b82162d29a5df9fdb5e89d409f1a16dacc57e4e291d644a576c42',
    after: 'b8a2dae94590536ad8e701b12be383fe0d1329b7c06958844c16eb8f00e748db' },
  { path: product + 'scripts/cli/native-cli-runner.mjs',
    before: '44ee001321a7ffcd67d41a88c359b1f8e37ecdc8eacfc02bc04cbd706ad1ee04',
    after: 'c507ab37daa034fa39c89465c0f0acceb21e07b745f6fbd5827077344a81ca77' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: '36a8fb5175a5c5e47c4a9f86896c2b0491eda5dd8abd93a28cbab9db22255feb',
    after: 'c111a1c09c08f1bbcae9ea6895246d9ad96db575b3b3ee5bced0b2377b9737d3' },
];
// Authorized document loading only: these four existing files remain pinned;
// callback transport, model policy and prior client repairs are not exempted.
const cliDocumentContextFingerprints = [
  { path: cli,
    before: '2a37a1b36d4930ce3dac4617f68c70677511308e8fb24c971fafab540894cf9b',
    after: '2abc5b2ea2e0dd21f2c225fe2a0fb0ca2603527d60eedf805dd5c10ddf6f3b78' },
  { path: product + 'scripts/cli/interactive-cli-runner.mjs',
    before: 'b8a2dae94590536ad8e701b12be383fe0d1329b7c06958844c16eb8f00e748db',
    after: 'adcb9e693fa127bd2fd62621474ee8d1ef227b00871e6d02ab882476892c8c74' },
  { path: product + 'scripts/cli/native-cli-runner.mjs',
    before: 'c507ab37daa034fa39c89465c0f0acceb21e07b745f6fbd5827077344a81ca77',
    after: 'df778c3b023a87b30bb40ac05717db2bced79ed34fd0b2895fd23ed99d0d8b71' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: 'c111a1c09c08f1bbcae9ea6895246d9ad96db575b3b3ee5bced0b2377b9737d3',
    after: '14f57f9d0e4ea4b0297e3cb90fa95697f48f2c9ea30b50cc8178a297e8221609' },
];
// Authorized executable discovery only. Existing protocol and callback files
// keep their prior pins; only the profile bridge and its guide change here.
const codexExecutableFingerprints = [
  { path: cli,
    before: '2abc5b2ea2e0dd21f2c225fe2a0fb0ca2603527d60eedf805dd5c10ddf6f3b78',
    after: '6cbf07bf9218c17c217fad9b26037bd3253745b5796605f65caa93db5f3660c6' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '8c6b5aff293daa86e95fcfeae0109e960dc61b6e12798a4212920b4ea93ac9eb',
    after: '3e35aedc35d3f90e5929c47a38e26f81954afb56128e25729fe0c1f7eeb04b30' },
];
// Only manager launch/lifetime and its operating guide are authorized here.
// Desktop/CLI callback implementations and model selection retain their pins.
const cliManagerLifetimeFingerprints = [
  { path: cli,
    before: '6cbf07bf9218c17c217fad9b26037bd3253745b5796605f65caa93db5f3660c6',
    after: '37f3e65d658d5f5cde328a04cc2645eb4bae5f5bed1af7aacc0ca91d33cb46ed' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '3e35aedc35d3f90e5929c47a38e26f81954afb56128e25729fe0c1f7eeb04b30',
    after: '3cbab8bd3d25f15bb5149c0cdbdf7e7c95f7a92e545765834efefc2322a76db8' },
];
function normalizeClaudeCompatibility(file, text) {
  for (const change of claudeCompatibilityEdits.filter(item => item.path === file)) {
    if (text.split(change.after).length !== 2) return null;
    text = text.replace(change.after, change.before);
  }
  return text;
}
function matchesFrozenFingerprint(item, currentHash) {
  const manager = cliManagerLifetimeFingerprints.find(change => change.path === item.path);
  if (manager) {
    if (currentHash !== manager.after) return false;
    currentHash = manager.before;
  }
  const executable = codexExecutableFingerprints.find(change => change.path === item.path);
  if (executable) {
    if (currentHash !== executable.after) return false;
    currentHash = executable.before;
  }
  const documents = cliDocumentContextFingerprints.find(change => change.path === item.path);
  if (documents) {
    if (currentHash !== documents.after) return false;
    currentHash = documents.before;
  }
  const stageContinuation = cliStageContinuationFingerprints.find(change => change.path === item.path);
  if (stageContinuation) {
    if (currentHash !== stageContinuation.after) return false;
    currentHash = stageContinuation.before;
  }
  const continuation = cliContractTurnCompletionFingerprints.find(change => change.path === item.path);
  if (continuation) {
    if (currentHash !== continuation.after) return false;
    currentHash = continuation.before;
  }
  const approved = [...assistTransferFingerprints, ...claudeCompatibilityTestFingerprints].find(change => change.path === item.path);
  const compatibility = zcodeCompatibilityFingerprints.find(change => change.path === item.path);
  if (compatibility) return (!approved || item.sha256 === approved.before)
    && compatibility.before === (approved?.after ?? item.sha256) && currentHash === compatibility.after;
  return approved
    ? item.sha256 === approved.before && currentHash === approved.after
    : currentHash === item.sha256;
}

function headings(text) {
  const seen = new Map();
  return [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].replace(/\s+#+\s*$/, '').toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0; seen.set(slug, count + 1);
    return count ? slug + '-' + count : slug;
  });
}
function links(file, source = read) {
  const prose = source(file).replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/<!--[^]*?-->/g, '');
  return [...prose.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)]
    .map(match => match[1].replace(/^<|>$/g, '').split(/\s+["']/)[0])
    .filter(href => !/^[a-z]+:/i.test(href))
    .map(href => {
      const [target, anchor] = href.split('#');
      return {
        path: relative(root, target ? resolve(root, dirname(file), decodeURIComponent(target)) : resolve(root, file)).split(sep).join('/'),
        anchor: anchor ? decodeURIComponent(anchor) : null,
      };
    });
}
function checkLink(file, target, anchor = null, source = read) {
  const matches = links(file, source).filter(link => link.path === target && link.anchor === anchor);
  assert.ok(matches.length > 0, file + ' must have a usable route to ' + target + (anchor ? '#' + anchor : ''));
  assert.ok(existsSync(join(root, target)), target);
  assert.ok(lstatSync(join(root, target)).isFile(), target);
  if (anchor) assert.ok(headings(source(target)).includes(anchor), 'missing target heading: ' + anchor);
}
function contains(file, fragments, source = read) {
  const text = source(file);
  for (const fragment of fragments) assert.ok(text.includes(fragment), file + ': missing contract ' + fragment);
}
function filesBelow(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = directory + '/' + entry.name;
    assert.ok(!entry.isSymbolicLink(), 'frozen tree contains a symlink: ' + file);
    return entry.isDirectory() ? filesBelow(file) : [file];
  }).sort();
}
function frozenFailures(source = read) {
  const errors = [];
  for (const item of fixture.files) {
    try {
      let current = normalizeClaudeCompatibility(item.path, source(item.path));
      if (current === null) { errors.push(item.path); continue; }
      if (item.path === receiptFile) {
        if (current.split(receiptRenameAfter).length !== 2) { errors.push(item.path); continue; }
        current = current.replace(receiptRenameAfter, receiptRenameBefore);
      }
      if (!matchesFrozenFingerprint(item, sha256(current))) errors.push(item.path);
    }
    catch { errors.push(item.path + ': missing or unreadable'); }
  }
  for (const item of fixture.portions) {
    const text = source(item.path);
    const start = text.indexOf(item.start);
    const end = item.end ? text.indexOf(item.end, start + item.start.length) : text.length;
    if (start < 0 || end < start || sha256(text.slice(start, end)) !== item.sha256)
      errors.push(item.path + ': ' + item.start);
  }
  return errors;
}

test('PM, design, development failure and CLI consumers reach the actual owner', () => {
  // Skills are discovered by logical name in the installed skills root, not
  // by relative links from ~/.codex/skills to a source checkout.
  contains(agents, ['新的业务开发任务先进入`task-design`']);
  contains(pm, ['PM在派单前完整读取`task-design/SKILL.md`']);
  assert.ok(lstatSync(join(root, design)).isFile());
  checkLink(design, rule);
  checkLink(dev, failure);
  checkLink(failure, rule, '5-多模型审查与无进展诊断');
  checkLink(agents, cli);
  contains(rule, ['项目根映射的`04-CLI目标协作机制.md`']);
});

test('new rule links and anchors are readable; installed Skills do not link into source docs', () => {
  for (const file of [pm, design, rule, dev, failure, testing]) {
    for (const link of links(file)) {
      assert.ok(link.path.startsWith(product + 'skills/'), 'installed Skill escapes its skill tree: ' + file + ' -> ' + link.path);
      assert.ok(existsSync(join(root, link.path)) && lstatSync(join(root, link.path)).isFile(), file + ' -> ' + link.path);
      if (link.anchor) assert.ok(headings(read(link.path)).includes(link.anchor), file + ': invalid anchor ' + link.anchor);
    }
  }
});

test('approval has a specific scope and revision, without turning discussion into development permission', () => {
  contains(rule, [
    '确认须对应需求/设计的路径、章节、修订和实现范围',
    '可追溯的用户原话或消息入口',
    '用户只批准设计时仍不开发',
    '确认前只在授权内调查、写设计',
    '不能借实验开发正式功能',
    '旧批准不能覆盖新范围',
    '不重复索要同一批准',
    '记录其指定的适用范围与条件',
    '本次例外不自行泛化为长期默认',
    '明确的跨任务授权也不逐任务重问',
  ]);
  contains(pm, ['未确认不派开发', '已确认需求与设计的路径/章节/修订、确认来源']);
  contains(agents, ['只读问答、状态查询和精确文件操作不套业务设计流程']);
  contains(design, ['用户要求只讨论或不写文件时仅在回复中给草案，不落盘、不开发']);
});

test('implementation and testing consume approved documentation, not an untraceable PM summary', () => {
  contains(rule, [
    '执行者开始前实际读取任务所指当前正文与必要直接依赖，不能只读派单摘要',
    '修订不匹配时仅核实受影响差异',
    '共享正文保持明确写入者',
    '不能靠把文档改成错误实现来消除失败',
    '其他不冲突工作继续',
    '未满足项如实保留',
  ]);
  contains(dev, ['本业务任务的需求与技术设计是否已确认，当前改动是否仍在批准范围内']);
  contains(testing, ['已确认需求/设计的哪一项结果及当前适用修订', '不能修改验收去迎合错误实现']);
  contains(guide, ['正文、修订和确认来源', '不强制另建PRD、技术设计、实施报告三份文件']);
});

test('multi-model assistance preserves evidence, model identity limits and sole-writer ownership', () => {
  contains(rule, [
    '不同模型的审查者', '先独立阅读用户原话', '不只接收主模型结论',
    '不以票数定真伪', '不提供凭据、无关业务数据或整个私有仓库',
    '不能把不同CLI或指向同一模型的简写别名算成异模型',
    '不能据此保证网关背后的真实身份',
    '不创建新的正式任务或源码写入者', '不另写通知、等待或回调流程',
    '模型选择服从当前策略、用户锁定与预算',
    '不伪称已审查，也不静默回退成同一模型',
    '不冻结无关任务',
  ]);
});

test('failure consultation is evidence-driven and does not freeze ordinary progress or bypass permissions', () => {
  contains(rule, [
    '同一问题连续两轮有针对性的修复仍失败，且没有新的有效证据时',
    '有新定位证据时不机械凑次数或停工',
    '预期/实际、最小复现、已试方法及结果、版本/约束和未知项',
    '协助者只读分析', '选取能区分原因的验证，再实施并回测',
    '权限、环境或必需业务决定缺失不能靠换模型绕过',
    '不自动改变任务状态',
  ]);
  contains(failure, ['该处唯一规定触发条件、模型核对及不可用处理', '原执行者保留实现写入权']);
});

test('changed consumers contain no opposite no-document default', () => {
  const forbidden = [
    '不新建设计文档、计划、报告或检查点',
    'PM轻量任务设计只进入任务包，不形成项目文档',
    '这里不读取控制runtime实现，也不新建任何设计产物',
  ];
  for (const file of [pm, design, rule, dev, testing, guide]) {
    for (const text of forbidden) assert.ok(!read(file).includes(text), file + ': stale opposite rule ' + text);
  }
  // Boundaries for ordinary process artifacts must remain; this change does
  // not authorize parallel versions, full-template checklists or fake facts.
  contains(rule, ['优先复用项目已有设计、架构或契约文档', '不得使用“最终版、最新版、修订版”等平行文件']);
  contains(rule, ['未知值先给建议或调查，不虚构承诺']);
  contains(productTemplate, ['修订', '确认']);
  contains(architectureTemplate, ['只链接对应需求和决策正文，不在架构中复制每轮确认记录']);
});

// These are declared document-contract guards, not inferred model behaviors.
// Independent review tightened both sides: ordinary approved implementation
// keeps moving, while small changes that alter the business still need approval.
const reviewedBoundaries = [
  { file: agents, fragments: [
    '普通低风险、可逆且范围明确的实施细节不因此增加审查、文档、子智能体、新对话或等待点',
    '但不能据此跳过新业务任务的需求与设计确认及默认独立审查',
  ] },
  { file: pm, fragments: ['已定及否决决策理由'] },
  { file: rule, fragments: [
    '按是否改变已批准的业务范围、公开契约、验收、权限或关键技术路线判断',
    '不按按钮、字段或代码量判断',
    '恢复已有明确预期的缺陷修复沿原授权继续',
    '最终提请开发确认前按第5节完成独立模型审查与意见核实',
    '中间讨论和展示草案不以审查完成为前提',
    '草案阶段已获开发批准但默认审查尚未完成时，先说明并沿已有授权补完审查',
    '方案未变不重问，实质改案才确认受影响部分',
    '不能把“开始开发”默认为免审查',
    '由用户明确选择单模型路径并按第0节记录适用范围',
    '同一文件当次只由一个写入者维护',
    'PM将获准设计交给Worker后不并写',
    '其他人的修订交当前写入者合入',
    '不靠分章节掩盖同文件冲突',
    '汇报说明身份核实边界',
    '缺少返回标识时只称已请求该模型，不称已证实异模型审查',
  ] },
  { file: architectureTemplate, fragments: [
    '只链接对应需求和决策正文，不在架构中复制每轮确认记录',
    '实现期间更新受影响的稳定设计',
    '保留方案与实际实现的差异、调整理由以及代码和验证入口',
    '不用当前错误实现覆盖已确认目标',
  ] },
];

test('reviewed boundaries distinguish drafts, approvals, implementation details and evidence ownership', () => {
  for (const { file, fragments } of reviewedBoundaries) contains(file, fragments);
  assert.ok(!read(agents).includes('普通低风险、可逆且范围明确的任务不因此增加审查、文档、子智能体、新对话或等待点'),
    'the old blanket small-task exception bypasses business confirmation');
});

test('reviewed boundary checks reject removal of every declared safeguard', () => {
  for (const { file, fragments } of reviewedBoundaries) {
    for (const fragment of fragments) {
      const original = read(file);
      assert.ok(original.includes(fragment), 'mutation must target a present safeguard');
      assert.throws(() => contains(file, fragments,
        target => target === file ? original.replaceAll(fragment, '[removed safeguard]') : read(target)),
      { code: 'ERR_ASSERTION' }, file + ': removal was not detected: ' + fragment);
    }
  }
});

test('protected source is frozen except the precise authorized receipt and CLI repairs', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.baselineCommit, '041b0fe0f290ad628dc5c9f29b9d725419958781');
  assert.equal(new Set(fixture.files.map(item => item.path)).size, fixture.files.length);
  for (const item of [...fixture.files, ...fixture.portions]) {
    assert.ok(!isAbsolute(item.path) && !item.path.split('/').includes('..'));
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  for (const directory of fixture.directories) {
    const additions = directory === product + 'scripts/cli' ? ['cli-context', 'codex-executable', 'manager-launch'].map(name => product + 'scripts/cli/' + name + '.mjs') : [];
    assert.deepEqual(filesBelow(directory), [...fixture.files.filter(item => item.path.startsWith(directory + '/')).map(item => item.path), ...additions].sort(),
      'frozen directory membership changed: ' + directory);
  }
  assert.deepEqual(frozenFailures(), [], 'frozen source changed; do not refresh this fixture to silence a regression');
});

test('assist transfer permits exactly the reviewed files and rejects rollback or further changes', () => {
  assert.deepEqual(assistTransferFingerprints.map(item => item.path).sort(), [
    cli, product + 'scripts/cli/cli-bridge.mjs', product + 'scripts/cli/cli-task-store.mjs',
  ].sort());
  for (const change of assistTransferFingerprints) {
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path'], 'no extra or nested pin fields');
    const original = fixture.files.find(item => item.path === change.path);
    assert.ok(original, change.path);
    assert.equal(change.before, original.sha256);
    assert.match(change.after, /^[a-f0-9]{64}$/);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, 'old contents must not pass');
    assert.equal(matchesFrozenFingerprint(original, sha256(normalizeClaudeCompatibility(change.path, read(change.path)))), true);
    for (const mutate of [text => text + '\nextra content', text => text.slice(1)]) {
      assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
    }
    assert.ok(frozenFailures(file => {
      if (file === change.path) throw Error('missing');
      return read(file);
    }).includes(change.path + ': missing or unreadable'));
  }
  const callback = fixture.files.find(item => item.path.endsWith('/cli-notify.mjs'));
  assert.ok(callback);
  assert.equal(matchesFrozenFingerprint(callback, sha256(read(callback.path) + '\nchanged')), false);
});

test('receipt exception rejects removal, changed retry budget and unrelated receipt edits', () => {
  assert.ok(fixture.files.some(item => item.path === receiptFile));
  for (const mutate of [
    text => text.replace(receiptRenameAfter, receiptRenameBefore),
    text => text.replace('fs.renameSync(temporary, target), 200)', 'fs.renameSync(temporary, target), 201)'),
    text => text.replace('attempts = 20', 'attempts = 200'),
    text => text + '\n// unrelated receipt change\n',
  ]) {
    assert.ok(frozenFailures(file => file === receiptFile ? mutate(read(file)) : read(file)).includes(receiptFile));
  }
});

test('CLI continuation repair pins exactly seven reviewed files and rejects rollback or extra edits', () => {
  assert.deepEqual(cliContractTurnCompletionFingerprints.map(item => item.path).sort(), [cli,
    ...['claude-client', 'cli-bridge', 'cli-task-store', 'interactive-cli-runner', 'native-cli-runner', 'visible-cli-runner'].map(name => product + 'scripts/cli/' + name + '.mjs'),
  ].sort());
  for (const change of cliContractTurnCompletionFingerprints) {
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    const original = fixture.files.find(item => item.path === change.path);
    assert.ok(original);
    const prior = [...zcodeCompatibilityFingerprints, ...assistTransferFingerprints, ...claudeCompatibilityTestFingerprints].find(item => item.path === change.path);
    assert.equal(change.before, prior?.after ?? original.sha256);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, 'rollback must not pass');
    assert.equal(matchesFrozenFingerprint(original, sha256(normalizeClaudeCompatibility(change.path, read(change.path)))), true);
    for (const mutate of [text => text + '\nextra content', text => text.slice(1)]) {
      assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
    }
    assert.ok(frozenFailures(file => {
      if (file === change.path) throw Error('missing');
      return read(file);
    }).includes(change.path + ': missing or unreadable'));
  }
});

test('CLI stage continuation pins exactly six reviewed files and rejects rollback or extra edits', () => {
  assert.deepEqual(cliStageContinuationFingerprints.map(item => item.path).sort(), [cli,
    ...['cli-bridge', 'cli-task-store', 'interactive-cli-runner', 'native-cli-runner', 'visible-cli-runner'].map(name => product + 'scripts/cli/' + name + '.mjs'),
  ].sort());
  for (const change of cliStageContinuationFingerprints) {
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    const original = fixture.files.find(item => item.path === change.path);
    const prior = cliContractTurnCompletionFingerprints.find(item => item.path === change.path);
    assert.ok(original && prior, change.path);
    assert.equal(change.before, prior.after, 'the previous seven-file pins remain the immediate baseline');
    assert.match(change.after, /^[a-f0-9]{64}$/);
    const documents = cliDocumentContextFingerprints.find(item => item.path === change.path);
    const executable = codexExecutableFingerprints.find(item => item.path === change.path);
    const manager = cliManagerLifetimeFingerprints.find(item => item.path === change.path);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), manager?.after ?? executable?.after ?? documents?.after ?? change.after);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, 'rollback to the preceding repair must not pass');
    assert.equal(matchesFrozenFingerprint(original, manager?.after ?? executable?.after ?? documents?.after ?? change.after), true);
    for (const mutate of [text => text + '\nextra content', text => text.slice(1)]) {
      assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
    }
  }
});

test('stage continuation does not exempt callbacks, Claude client, Skills or model policy', () => {
  for (const file of [
    product + 'scripts/cli/cli-notify.mjs',
    product + 'scripts/cli/claude-client.mjs',
    product + 'skills/identity-worker/SKILL.md',
    product + 'skills/identity-pm/references/lifecycle-and-closeout.md',
  ]) {
    assert.ok(fixture.files.some(item => item.path === file), file);
    assert.ok(!cliStageContinuationFingerprints.some(item => item.path === file));
    assert.ok(frozenFailures(candidate => candidate === file ? read(candidate) + '\nextra content' : read(candidate)).includes(file));
  }
  for (const item of fixture.portions) {
    assert.ok(!cliStageContinuationFingerprints.some(change => change.path === item.path));
    assert.ok(frozenFailures(file => file === item.path ? read(file).replace(item.start, item.start + ' changed') : read(file)).includes(item.path + ': ' + item.start));
  }
});

test('document loading pins only three runners and their guide, keeping earlier repairs frozen', () => {
  assert.deepEqual(cliDocumentContextFingerprints.map(item => item.path).sort(), [cli,
    ...['interactive-cli-runner', 'native-cli-runner', 'visible-cli-runner'].map(name => product + 'scripts/cli/' + name + '.mjs'),
  ].sort());
  for (const change of cliDocumentContextFingerprints) {
    const previous = cliStageContinuationFingerprints.find(item => item.path === change.path);
    const original = fixture.files.find(item => item.path === change.path);
    assert.equal(change.before, previous.after);
    const executable = codexExecutableFingerprints.find(item => item.path === change.path);
    const manager = cliManagerLifetimeFingerprints.find(item => item.path === change.path);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), manager?.after ?? executable?.after ?? change.after);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, manager?.after ?? executable?.after ?? change.after), true);
    assert.ok(frozenFailures(file => file === change.path ? read(file) + '\nchanged' : read(file)).includes(change.path));
  }
  for (const name of ['cli-notify', 'desktop-host', 'claude-client', 'cli-task-store', 'cli-bridge']) {
    const file = product + 'scripts/cli/' + name + '.mjs';
    assert.ok(!cliDocumentContextFingerprints.some(item => item.path === file));
    assert.ok(frozenFailures(candidate => candidate === file ? read(file) + '\nchanged' : read(file)).includes(file));
  }
});

test('Codex executable repair pins only the bridge and guide, preserving the prior freeze chain', () => {
  assert.deepEqual(codexExecutableFingerprints.map(item => item.path).sort(), [cli, product + 'scripts/cli/cli-bridge.mjs'].sort());
  for (const change of codexExecutableFingerprints) {
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    const original = fixture.files.find(item => item.path === change.path);
    const previous = [...cliDocumentContextFingerprints, ...cliStageContinuationFingerprints].find(item => item.path === change.path);
    assert.equal(change.before, previous.after);
    const manager = cliManagerLifetimeFingerprints.find(item => item.path === change.path);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), manager?.after ?? change.after);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, manager?.after ?? change.after), true);
    assert.ok(frozenFailures(file => file === change.path ? read(file) + '\nchanged' : read(file)).includes(change.path));
  }
});

test('independent manager launch pins only bridge and guide without changing notification or model policy', () => {
  assert.deepEqual(cliManagerLifetimeFingerprints.map(item => item.path).sort(), [cli, product + 'scripts/cli/cli-bridge.mjs'].sort());
  for (const change of cliManagerLifetimeFingerprints) {
    const original = fixture.files.find(item => item.path === change.path);
    assert.equal(change.before, codexExecutableFingerprints.find(item => item.path === change.path).after);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), change.after);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, change.after), true);
    assert.ok(frozenFailures(file => file === change.path ? read(file) + '\nchanged' : read(file)).includes(change.path));
  }
  for (const name of ['cli-notify', 'desktop-host', 'cli-task-store', 'claude-client']) {
    const file = product + 'scripts/cli/' + name + '.mjs';
    assert.ok(!cliManagerLifetimeFingerprints.some(item => item.path === file));
    assert.ok(frozenFailures(candidate => candidate === file ? read(file) + '\nchanged' : read(file)).includes(file));
  }
  for (const item of fixture.portions) assert.ok(frozenFailures(file => file === item.path ? read(file).replace(item.start, item.start + ' changed') : read(file)).includes(item.path + ': ' + item.start));
});

test('ZCode compatibility exception admits only reviewed contents, not rollback or extra protocol edits', () => {
  assert.deepEqual(zcodeCompatibilityFingerprints.map(item => item.path).sort(), [cli, product + 'scripts/cli/zcode-profile.mjs'].sort());
  for (const change of zcodeCompatibilityFingerprints) {
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    const original = fixture.files.find(item => item.path === change.path);
    assert.ok(original);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, sha256(normalizeClaudeCompatibility(change.path, read(change.path)))), true);
    for (const mutate of [text => text + '\nextra content', text => text.slice(1)]) {
      assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
    }
  }
  const hook = fixture.files.find(item => item.path.endsWith('/zcode-tui-hook.mjs'));
  assert.ok(hook);
  assert.equal(matchesFrozenFingerprint(hook, sha256(read(hook.path) + '\nchanged')), false);
});

test('Claude compatibility exception rejects version gate restoration and protocol changes', () => {
  assert.equal(claudeCompatibilityEdits.length, 5);
  for (const change of claudeCompatibilityEdits) {
    assert.ok(frozenFailures(file => file === change.path ? read(file).replace(change.after, change.before) : read(file)).includes(change.path));
  }
  const profile = product + 'scripts/cli/claude-profile.mjs';
  for (const mutate of [
    text => text.replace('version.error ||', "version.stdout.trim() !== '2.1.300 (Claude Code)' || version.error ||"),
    text => text.replace('version.error ||', 'version.stdout.trim().startsWith(\'2.\') === false || version.error ||'),
    text => text.replace("'--resume'", "'--continue'"),
    text => text + '\n// unrelated change\n',
  ]) assert.ok(frozenFailures(file => file === profile ? mutate(read(file)) : read(file)).includes(profile));
  assert.equal(claudeCompatibilityTestFingerprints.length, 1);
  const change = claudeCompatibilityTestFingerprints[0];
  assert.equal(change.path, product + 'scripts/cli/claude-version-compatibility.test.mjs');
  assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
  const original = fixture.files.find(item => item.path === change.path);
  assert.equal(change.before, original.sha256);
  assert.equal(matchesFrozenFingerprint(original, change.before), false);
  assert.equal(matchesFrozenFingerprint(original, sha256(read(change.path))), true);
  for (const mutate of [text => text + '\nextra', text => text.slice(1)]) {
    assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
  }
});

test('the freeze checker detects edits in both complete files and protected sections', () => {
  const callback = fixture.files.find(item => item.path.endsWith('/lifecycle-and-closeout.md')).path;
  assert.ok(frozenFailures(file => read(file) + (file === callback ? '\nchanged' : '')).includes(callback));
  for (const item of fixture.portions) {
    const failures = frozenFailures(file => file === item.path ? read(file).replace(item.start, item.start + ' changed') : read(file));
    assert.ok(failures.includes(item.path + ': ' + item.start), item.path);
  }
});

test('the navigation checker rejects broken consumer links and anchors without filesystem mutations', () => {
  const original = read(failure);
  assert.throws(() => checkLink(failure, rule, '5-多模型审查与无进展诊断',
    file => file === failure ? original.replace('complex-design-document-and-implementation.md', 'missing.md') : read(file)));
  assert.throws(() => checkLink(failure, rule, '5-多模型审查与无进展诊断',
    file => file === rule ? read(file).replace('## 5. 多模型审查与无进展诊断', '## 5. Heading removed') : read(file)));
});
