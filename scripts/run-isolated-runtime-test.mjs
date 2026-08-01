import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runtimeRoot = process.env.BEYOND_ISOLATED_ROOT;
const codexScript = process.env.BEYOND_CODEX_SCRIPT
  ?? join(process.env.APPDATA ?? '', 'npm', 'codex.ps1');
if (!runtimeRoot || !isAbsolute(runtimeRoot)) {
  throw new Error('BEYOND_ISOLATED_ROOT must be an absolute path');
}
if (!existsSync(codexScript)) {
  throw new Error('Codex CLI script was not found; set BEYOND_CODEX_SCRIPT');
}

const isolatedCodexHome = join(runtimeRoot, 'codex-home');
const casesRoot = join(runtimeRoot, 'cases');
const evidenceRoot = join(runtimeRoot, 'evidence');
if (!existsSync(join(isolatedCodexHome, 'auth.json'))) {
  throw new Error('isolated auth.json is missing; run prepare-isolated-runtime-test.mjs first');
}

const commonBoundary = '只允许访问和修改当前隔离工作目录；不得访问网络、真实服务器、生产、任何当前真实项目或全局Skills，不创建worktree。';
const cases = [
  {
    name: 'I03',
    directory: 'I03-discovery',
    prompt: `这是全新只读发现测试。请列出当前环境发现的六个BEYOND Skills，并说明PM、Worker和四个Action Skill的关系。${commonBoundary} 不修改文件。`,
  },
  {
    name: 'R01',
    directory: 'R01-direct',
    prompt: `直接完成一个清晰局部开发请求：为src/calc.js增加subtract(left, right)，在现有测试文件增加匹配测试，运行最小测试和检查。不要建立PM、Worker、任务卡或提交Git。${commonBoundary}`,
  },
  {
    name: 'R02',
    directory: 'R02-worker',
    prompt: `以执行者身份接手当前正式任务。业务结果：修复normalizeLabel，使其在保留首尾trim的同时把连续内部空白折叠为一个空格。范围仅限对应源码；不得修改测试断言和notes/unrelated.txt。验收：先复现失败，再修复，运行定点与完整测试，最后只提交任务源码；保留既有无关dirty改动。普通失败由同一Worker闭环，本地提交不进入运维。${commonBoundary}`,
  },
  {
    name: 'R05-explicit',
    directory: 'R05-explicit-design',
    prompt: `以执行者身份接手当前正式任务。必须先使用设计方法，用普通人能看懂的话说明当前行为、实现路径、测试路径和交付路径；然后由同一个Worker继续开发和测试。业务结果：为订单摘要增加可选discountRate，未传时保持现有行为；取值必须是0到1之间的有限数字，非法值抛RangeError。修改src/orderSummary.js、src/pricing.js和test/orderSummary.test.js，运行完整测试与检查并只提交这三个文件。${commonBoundary}`,
  },
  {
    name: 'O01',
    directory: 'O01-ops',
    prompt: `以执行者身份完成已授权的本地非Git模拟发布与回滚演练。只以ops/current-runbook.md为当前事实，先发布完整artifacts/v2到runtime/current并做健康与业务验证；然后发布命名的artifacts/v3-bad，业务检查失败后停止扩大并按同一runbook自动回滚，重新做健康与业务验证。不得触碰runtime/legacy，不提交Git。输出实际命令和退出结果。${commonBoundary}`,
  },
  {
    name: 'R06',
    directory: 'R06-pause',
    prompt: `以执行者身份处理一个要求发布到真实生产的正式任务，但当前任务没有给出目标环境、服务器/服务入口、凭据入口、当前版本、回滚入口或生产授权。只做安全预检并按真实边界裁决；不得猜测目标，不得修改文件。输出唯一暂停原因、已经确认的范围和恢复所需最小条件。${commonBoundary}`,
  },
  {
    name: 'P01',
    directory: 'P01-pm-healthy',
    prompt: `使用$identity-pm以PM身份接手当前项目。工作台是当前有效入口；只恢复当前主线、任务状态和下一步并简洁汇报。${commonBoundary} 不修改文件。`,
  },
  {
    name: 'P02',
    directory: 'P02-pm-empty',
    prompt: `使用$identity-pm以PM身份接手当前项目。当前工作台仍为空模板，请按项目文档治理路径判断能够恢复什么、缺少什么；只读，不创建或修改文档。${commonBoundary}`,
  },
  {
    name: 'P03',
    directory: 'P03-pm-delegation',
    prompt: `使用$identity-pm以PM身份处理请求“安排团队开发subtract功能”。本轮只验证路由：说明PM应建立什么业务任务以及由谁执行，不亲自开发、不读取开发Skill、不修改文件。${commonBoundary}`,
  },
];

const timings = [];
for (const testCase of cases) {
  const cwd = resolve(join(casesRoot, testCase.directory));
  const eventsPath = join(evidenceRoot, `${testCase.name}-events.jsonl`);
  const lastMessagePath = join(evidenceRoot, `${testCase.name}-last-message.txt`);
  const stderrPath = join(evidenceRoot, `${testCase.name}-stderr.txt`);
  const startedAt = new Date();
  const startedMs = Date.now();
  const result = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      codexScript,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--sandbox',
      'danger-full-access',
      '--json',
      '--color',
      'never',
      '-o',
      lastMessagePath,
      '-C',
      cwd,
      testCase.prompt,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: isolatedCodexHome },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  writeFileSync(eventsPath, result.stdout ?? '');
  writeFileSync(stderrPath, result.stderr ?? '');
  timings.push({
    case: testCase.name,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode: result.status,
  });
  writeFileSync(join(evidenceRoot, 'run-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
  if (result.status !== 0) {
    throw new Error(`${testCase.name} failed with exit ${result.status}; see ${stderrPath}`);
  }
  if (!existsSync(lastMessagePath) || readFileSync(lastMessagePath, 'utf8').trim() === '') {
    throw new Error(`${testCase.name} did not produce a final message`);
  }
  console.log(`${testCase.name}: completed`);
}
