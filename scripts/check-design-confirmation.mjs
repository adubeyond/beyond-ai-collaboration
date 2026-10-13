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
    try { if (sha256(source(item.path)) !== item.sha256) errors.push(item.path); }
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

test('callback, CLI implementation, model policy and PM closeout are frozen to the declared baseline', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.baselineCommit, '041b0fe0f290ad628dc5c9f29b9d725419958781');
  assert.equal(new Set(fixture.files.map(item => item.path)).size, fixture.files.length);
  for (const item of [...fixture.files, ...fixture.portions]) {
    assert.ok(!isAbsolute(item.path) && !item.path.split('/').includes('..'));
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  for (const directory of fixture.directories) {
    assert.deepEqual(filesBelow(directory), fixture.files.filter(item => item.path.startsWith(directory + '/')).map(item => item.path).sort(),
      'frozen directory membership changed: ' + directory);
  }
  assert.deepEqual(frozenFailures(), [], 'frozen source changed; do not refresh this fixture to silence a regression');
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
