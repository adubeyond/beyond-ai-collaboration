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
// Authorized 4.0.1 Windows process identity repair: the same creation-time
// proof bypasses a reproduced cmdlet stall. Keep the original freeze intact.
const windowsProcessIdentityFingerprints = [
  { path: product + 'scripts/cli/process-identity.mjs',
    before: '649bd6e7106ea3f27f7bb99f35ff8d9d215d383aba4373363d1b7ff52cdff10a',
    after: 'ff56b97783e0386d29906b799532164ef4761b3efa43970a00ed7141322a98e6' },
];
// Retain, do not reimplement, the reviewed HF in bf4feb722f6672744ab4b5946984443d1ca435ce.
// Each parent hash is checked against the existing chain below; the original
// baseline stays immutable. No other edit to these files is admitted.
const retainedHotfixFingerprints = [
  { path: product + 'scripts/cli/claude-client.mjs',
    before: '11b889c69562eab7d3fba2bf1521ac8d94e847b022c797b167d6a237421fa32a',
    after: 'ccea449ddec42949d9a5a0a2d35c56d713ce64abe8815be58c4282ed4580738e' },
  { path: product + 'scripts/cli/claude-hook.mjs',
    before: '623b46edf87f39316fe0b457b69fd3813cc86eb468c3e41d1b6bea7800b7f55d',
    after: '4132270c0d779e25aa4c268d3c64281a82dcb88623a040a38e13f5ffeaac82ef' },
  { path: product + 'scripts/cli/claude-version-compatibility.test.mjs',
    before: 'e72ee3134cfec81b9700853c5af170d8ea37eef82e193f506f696a469c2d539c',
    after: '5c0a0fcc3becff56b110f1a5c5d5de41be963d5070083774d4b54ea19318cd72' },
  { path: product + 'scripts/cli/native-cli-runner.mjs',
    before: 'df778c3b023a87b30bb40ac05717db2bced79ed34fd0b2895fd23ed99d0d8b71',
    after: '8c9303cb5db35eb629d3c973c869ca5c1a82b4db82fbf1ebc1b338b55f2a69ba' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: '14f57f9d0e4ea4b0297e3cb90fa95697f48f2c9ea30b50cc8178a297e8221609',
    after: 'bdcdb230032ef4e3988b0229ee06838836269a7895fd95a3eb0e90e2bb6ab6c7' },
  { path: product + 'skills/identity-pm/references/lifecycle-and-closeout.md',
    before: '1d7488ae62a81afb316a3377f6070d8d528bdb66bbdc41924067a6cf7af8afac',
    after: '30e9da70b9925457c681d972b91449fcdd9e40f1f93c3bba383b33730615c4ca' },
  { path: product + 'skills/identity-worker/SKILL.md',
    before: '90df3379827811b20fda8959a22fca98a19643cc14a962572e1176377c46e9e3',
    after: '3510210cb3f13c6d168ef5620c1d572e5c241ec4c189d6b722f4198b7bfb11c1' },
];
const retainedHotfixAdditions = [
  { path: product + 'scripts/cli/claude-hook-stdin.test.mjs',
    sha256: 'c2e528e808a233a7faf9ca176ac392cf284fcd863f0f9d0ff3fcc2914f8ea49e' },
  { path: product + 'scripts/cli/cli-environment.test.mjs',
    sha256: '9baf7e819e94bcaea5ab2f6e29fde1e6844636c8b83c4e11b48ee475bdb40013' },
];
// Authorized 2026-10-18 same-owner reconnect and nonterminal CLI attention repairs.
// Pin only these seven reviewed complete contents to their normalized HEAD parents;
// preserve every earlier hash, the original fixture and frozen directory membership.
const cliReconnectAttentionFingerprints = [
  { path: product + 'scripts/cli/claude-client.mjs',
    before: 'ccea449ddec42949d9a5a0a2d35c56d713ce64abe8815be58c4282ed4580738e',
    after: '5f2ae2c58a15d13a72c8a4031ef5342cdb9ff4e9d861b302869a97c121150f58' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '3cbab8bd3d25f15bb5149c0cdbdf7e7c95f7a92e545765834efefc2322a76db8',
    after: '13ad78ae02613cb31d4d754a0240ec8a186fcc6753799e6409ed0db651143086' },
  { path: product + 'scripts/cli/cli-notify.mjs',
    before: '9787ad1801cc18a943ef4e9f8742c69bebc795bde216b5866e70848e040782d9',
    after: 'dd8f48cc36cb5ef0755a10df741386c0992e6fe00bcd207f7df6a1aa1e9125c6' },
  { path: product + 'scripts/cli/desktop-host.mjs',
    before: '1677d428b75b22f5bc64a4851c37adf07d4936162f4962d80f46396feb641eeb',
    after: '41d706a89e0d579cff8114174a3c0809b90de3070603ad3d92bb1d5e20e34d6c' },
  { path: product + 'scripts/cli/interactive-cli-runner.mjs',
    before: 'adcb9e693fa127bd2fd62621474ee8d1ef227b00871e6d02ab882476892c8c74',
    after: 'c0fbaa74dc88ab414883d573ccf347d5f182490ea8e9cf484ad5696051cef0cf' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: 'bdcdb230032ef4e3988b0229ee06838836269a7895fd95a3eb0e90e2bb6ab6c7',
    after: 'fc1d9f9e70df9ee8b782eef4c94c39371830b95d336b2869cfa1132302b9c117' },
  { path: cli,
    before: '37f3e65d658d5f5cde328a04cc2645eb4bae5f5bed1af7aacc0ca91d33cb46ed',
    after: 'cee5dc0899f122c52250d692db14086119fb0fb49b2ace58dda8513cd24e2136' },
];
// Reviewed 2026-10-19/20 maintenance composition, not a baseline refresh.
// CLI waiting/orphan fixes come from retained CLI-WAITING REV2; bridge/store
// retain the installed acceptedGoalRecovery repair, not the unshipped successor.
// The final guide also contains the Codex path and manual-continuation correction.
// The two runtime files are the reproduced premature-ack repair; lifecycle only
// moves verified fact synchronization before the independent continuation choice.
// Hashes use the same exact compatibility/retry normalization as the original freeze.
const reviewedMaintenanceFingerprints = [
  { path: cli,
    before: 'cee5dc0899f122c52250d692db14086119fb0fb49b2ace58dda8513cd24e2136',
    after: '6953d6bf75ae8cd93fa5039f2923e07fef0141a848cab3decee2299f2198cc1b' },
  { path: product + 'scripts/cli/claude-client.mjs',
    before: '5f2ae2c58a15d13a72c8a4031ef5342cdb9ff4e9d861b302869a97c121150f58',
    after: '0648a39e6beffd2dc5e222d8e72feed0e1d7d657d5cf2c36eeb48423bc9a773f' },
  { path: product + 'scripts/cli/cli-bridge.mjs',
    before: '13ad78ae02613cb31d4d754a0240ec8a186fcc6753799e6409ed0db651143086',
    after: '88d09a2f810cdbb3ccbbd62f7e90a24d20c1b42596437e41f13dbc2c9f376f0d' },
  { path: product + 'scripts/cli/cli-notify.mjs',
    before: 'dd8f48cc36cb5ef0755a10df741386c0992e6fe00bcd207f7df6a1aa1e9125c6',
    after: '6d1d598b003db2a5da8af83fddca87cefe712e8814abf8559f329a990790cf89' },
  { path: product + 'scripts/cli/cli-task-store.mjs',
    before: '4dbb0a14d681ee7db3eb951e344e52c0df76e27f5aa7ee9fbb23cd92a8e8a770',
    after: '2b234e1d89f15a38f29c0fb133c3660b306474ea1408b6fd1910caeb81193940' },
  { path: product + 'scripts/cli/interactive-client.mjs',
    before: '6e2c7ff9fb8e6a320246c50c4f7f8ee2c847bf873a9f074a26a81fc72271148d',
    after: '0a1bc37d4fba11025dddd6fb9053dbc49b9dded59761c7ca0cfd1e62f77f3fcc' },
  { path: product + 'scripts/cli/process-identity.mjs',
    before: 'ff56b97783e0386d29906b799532164ef4761b3efa43970a00ed7141322a98e6',
    after: 'a6af787dd5042572f7533dba147f1dffdb27ae5399da4f0e9ab959aee212f224' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: 'fc1d9f9e70df9ee8b782eef4c94c39371830b95d336b2869cfa1132302b9c117',
    after: 'c9c984eac8189323c72ed2d463435186b8caf679befc975aa08c13c710d77cba' },
  { path: product + 'scripts/runtime/control-runtime.mjs',
    before: 'cef99605ad2a3f436085443275beb07908ebca85392ad84273171cca04986122',
    after: 'e3075b239a98f643ca39633962fcf8adc41e891e1b38111f966df3192ef708ac' },
  { path: receiptFile,
    before: 'f4c2d54568b07fbe0872d5f1caaa19e3326ad8e438d638602bd75cef16f1c1e2',
    after: '0890fdbe63f0b88792cbd0d0d6b3330124b7066e29728f2161ddc9987126e8af' },
  { path: product + 'skills/identity-pm/references/lifecycle-and-closeout.md',
    before: '30e9da70b9925457c681d972b91449fcdd9e40f1f93c3bba383b33730615c4ca',
    after: 'e586f2f8f38e42cdb1c35bcd0d3b5b6c437451a5f4ec7808f19e654a7eac208e' },
];
const reviewedMaintenanceAdditions = [
  { path: product + 'scripts/cli/claude-compaction-cwd.test.mjs',
    sha256: '65a59bfea8403a2fc9494d2de55888c1c8af127da25726ff150012ca92223368' },
  { path: product + 'scripts/cli/claude-orphan-retirement.test.mjs',
    sha256: '6803564337287e6934786611373a0906b3630d42b80d6536b8ecabefd30bf445' },
  { path: product + 'scripts/cli/claude-waiting-attention.test.mjs',
    sha256: 'a73786c94fdbfce7ea00a8baa81bb1ed4b94d1a0a043cbe9731ca45e242ed3da' },
];
// Public source hashes used solely as rejected counterexamples, never allowlisted.
const excludedSuccessorFingerprints = [
  { path: product + 'scripts/cli/cli-bridge.mjs',
    sha256: '71b07101428d3fc3e8cbb9a070195be6005fe19c00315225df3fc6227d2d28b1' },
  { path: product + 'scripts/cli/cli-task-store.mjs',
    sha256: '0fe5ac8811a8fc75954ceef41b250dfadfd83807690a85a5af93b6f430b193eb' },
];
// Reviewed collaboration/delivery candidate, promoted unchanged for 4.1.0.
// These normalized pins were checked against the immutable tested candidate and
// its preceding committed maintenance source. Keep every earlier freeze node.
const collaborationDeliveryFingerprints = [
  { path: cli, before: '6953d6bf75ae8cd93fa5039f2923e07fef0141a848cab3decee2299f2198cc1b', after: '55033fc8a28f781cb7f4bffe36c987f46ec72f495042323d35d26ea9abf27fe4' },
  { path: product + 'scripts/cli/cli-bridge.mjs', before: '88d09a2f810cdbb3ccbbd62f7e90a24d20c1b42596437e41f13dbc2c9f376f0d', after: 'f71a1a4056977322fa1cdb92c771dd307186a5680a135f850b074ffe82de3f8c' },
  { path: product + 'scripts/cli/cli-notify.mjs', before: '6d1d598b003db2a5da8af83fddca87cefe712e8814abf8559f329a990790cf89', after: '68b935d8ee7021b25d1754235ba353bdc156123c424d3d76a81b9c47fe06cdc4' },
  { path: product + 'scripts/runtime/control-runtime.mjs', before: 'e3075b239a98f643ca39633962fcf8adc41e891e1b38111f966df3192ef708ac', after: 'd174ec56cd7f65361934547473de3bd92ad7f467f109b8cb71ed5e450f6f05e1' },
  { path: product + 'scripts/runtime/workbench-transaction.mjs', before: '6554383e59f6dc6bbaec8128b1b75abbad06ebce50b0d972f5b3d15709616aa8', after: '84a4334d80e15d29058c485b1bc44b42d07730d53c727d689ff7204dcec273e5' },
  { path: product + 'skills/identity-pm/references/lifecycle-and-closeout.md', before: 'e586f2f8f38e42cdb1c35bcd0d3b5b6c437451a5f4ec7808f19e654a7eac208e', after: '8b2fbfcb381ba5a6d9e7b0d4b68ac357ff1a2d4bc3850be8c84f089fa6bec973' },
  { path: product + 'skills/identity-worker/SKILL.md', before: '3510210cb3f13c6d168ef5620c1d572e5c241ec4c189d6b722f4198b7bfb11c1', after: 'f7773816a510205442ba411e221dd3ef1cc9fbd6ec9702c020365058be948cbe' },
  { path: product + 'skills/identity-worker/agents/openai.yaml', before: 'd15ff52e60d2a39bf2764f3a431a9adac59c949d650b6a4a600d954e505a8cd7', after: 'd2e5d1a2072f51ab46faaad412680cdf2a4aa72de3254208015797eb43d387a7' },
  { path: product + 'skills/identity-worker/references/capability-correction-and-cost.md', before: '05a561ba345c61a1af7e343dce4735a027615cc49fec61b0ac9f5ab49cb34447', after: 'a13801f9b3424bf2611f0e3e46e23fef728d9381bf91d09f404885dfd98af0a0' },
  { path: product + 'skills/identity-worker/references/collaboration-and-rework.md', before: '0bbcb50fd883d09ec2a4e4e28e479d2ebfe5ea0121444ac75a138297439563e2', after: '5aef12bbf095e81bc31ef661efa919553321773d4b4ed495d8279900f4fe18fb' },
  { path: product + 'skills/identity-worker/references/lifecycle-and-recovery.md', before: '39eb1a6ae5af776097867797b11d08a9345ae3c02dd269ad31bc6849b07e965d', after: '8d96291bc04173acfb216331a9ee17c46046be2773894842a8e0bb507b72506f' },
];
const collaborationDeliveryAdditions = [
  { path: product + 'scripts/runtime/delivery-policy.mjs', sha256: '0a8ff8392d15d8948b818a0405666026338d4701fdd93ad801837f98bb7970f7' },
  // Only the synthetic fixture token's spelling changed to avoid a false
  // secret-assignment alert; its runtime value and assertions are unchanged.
  { path: product + 'scripts/runtime/workbench-delivery.test.mjs', sha256: '579da5599e2cd1be68e985800cdc92b2f77e4411f39a89cceaaefd9c2be05018' },
  { path: product + 'scripts/cli/cli-notify.delivery-boundaries.test.mjs', sha256: '837f3fc28f12bbb199e4708f735092e3669d976b6480fe6db4e994c6e64b9715' },
];
const collaborationDeliveryPortions = [
  { path: pm, start: '## 5. 状态与执行边界',
    before: 'eeaadd9d8cd218a9e65a6912b3e17556d92fa424ffd8aa303f255fc7cba425a1',
    after: 'e8994c7535992e50d678c7aa69c03daeda879f2d3109ef64e25840e5642678d0' },
];
// Reviewed 4.1.1 Claude background-return repair, chained from d55de052.
// Only these three adapters, their guide and two existing regression files
// advance; the original baseline, Formal Worker delivery and Skills stay pinned.
const claudeBackgroundReturnFingerprints = [
  { path: cli,
    before: '55033fc8a28f781cb7f4bffe36c987f46ec72f495042323d35d26ea9abf27fe4',
    after: '4d3342dd4a0f078b020d8d09b98bfc2d0fc2538ada35407f48ee28dfe2d0e8a7' },
  { path: product + 'scripts/cli/claude-client.mjs',
    before: '0648a39e6beffd2dc5e222d8e72feed0e1d7d657d5cf2c36eeb48423bc9a773f',
    after: '782a161d255fa0685bea4e00750adad3f10e7a8a09a47e27ea0441292824fe24' },
  { path: product + 'scripts/cli/cli-notify.mjs',
    before: '68b935d8ee7021b25d1754235ba353bdc156123c424d3d76a81b9c47fe06cdc4',
    after: '519cdc7b014d4e89984e792f4989973fedf4a26b6d01dd36f08446fe53718c20' },
  { path: product + 'scripts/cli/visible-cli-runner.mjs',
    before: 'c9c984eac8189323c72ed2d463435186b8caf679befc975aa08c13c710d77cba',
    after: 'c19cee90ebdd44cb30a21dd83d6b595c102b33ffb2a1f272546f32cb86c07b1d' },
  { path: product + 'scripts/cli/claude-version-compatibility.test.mjs',
    before: '5c0a0fcc3becff56b110f1a5c5d5de41be963d5070083774d4b54ea19318cd72',
    after: '65f5ba32a0950ab478c3b7acb44f1fbae5a64bedaba1dbe438485191293507a0' },
  { path: product + 'scripts/cli/claude-compaction-cwd.test.mjs',
    before: '65a59bfea8403a2fc9494d2de55888c1c8af127da25726ff150012ca92223368',
    after: '5f915348886ad2328253307ead78b1256ef2b5560f37d7508a048d7e37971e75' },
];
const claudeBackgroundReturnAdditions = [
  { path: product + 'scripts/cli/claude-background-return.test.mjs',
    sha256: 'be8cdf9e7f27a409378a87d4d3aef2d0f522c7d60ba1b05b188e554c7db47c5c' },
];
const latestCliRepairHash = (file, previous) => claudeBackgroundReturnFingerprints.find(item => item.path === file)?.after
  ?? collaborationDeliveryFingerprints.find(item => item.path === file)?.after
  ?? reviewedMaintenanceFingerprints.find(item => item.path === file)?.after
  ?? cliReconnectAttentionFingerprints.find(item => item.path === file)?.after ?? previous;
function normalizeClaudeCompatibility(file, text) {
  for (const change of claudeCompatibilityEdits.filter(item => item.path === file)) {
    if (text.split(change.after).length !== 2) return null;
    text = text.replace(change.after, change.before);
  }
  return text;
}
function matchesFrozenFingerprint(item, currentHash) {
  const backgroundReturn = claudeBackgroundReturnFingerprints.find(change => change.path === item.path);
  if (backgroundReturn) {
    if (currentHash !== backgroundReturn.after) return false;
    currentHash = backgroundReturn.before;
  }
  const collaboration = collaborationDeliveryFingerprints.find(change => change.path === item.path);
  if (collaboration) {
    if (currentHash !== collaboration.after) return false;
    currentHash = collaboration.before;
  }
  const maintenance = reviewedMaintenanceFingerprints.find(change => change.path === item.path);
  if (maintenance) {
    if (currentHash !== maintenance.after) return false;
    currentHash = maintenance.before;
  }
  const reconnectAttention = cliReconnectAttentionFingerprints.find(change => change.path === item.path);
  if (reconnectAttention) {
    if (currentHash !== reconnectAttention.after) return false;
    currentHash = reconnectAttention.before;
  }
  const retained = retainedHotfixFingerprints.find(change => change.path === item.path);
  if (retained) {
    if (currentHash !== retained.after) return false;
    currentHash = retained.before;
  }
  const processIdentity = windowsProcessIdentityFingerprints.find(change => change.path === item.path);
  if (processIdentity) {
    if (currentHash !== processIdentity.after) return false;
    currentHash = processIdentity.before;
  }
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
  for (const item of [...retainedHotfixAdditions, ...reviewedMaintenanceAdditions, ...collaborationDeliveryAdditions, ...claudeBackgroundReturnAdditions]) {
    try { if (!matchesFrozenFingerprint(item, sha256(source(item.path)))) errors.push(item.path); }
    catch { errors.push(item.path + ': missing or unreadable'); }
  }
  for (const item of fixture.portions) {
    const text = source(item.path);
    const start = text.indexOf(item.start);
    const end = item.end ? text.indexOf(item.end, start + item.start.length) : text.length;
    const change = collaborationDeliveryPortions.find(change => change.path === item.path && change.start === item.start);
    if ((change && change.before !== item.sha256) || start < 0 || end < start || sha256(text.slice(start, end)) !== (change?.after ?? item.sha256))
      errors.push(item.path + ': ' + item.start);
  }
  return errors;
}

function frozenDirectoryMembers(directory) {
  const earlierAdditions = directory === product + 'scripts/cli'
    ? ['cli-context', 'codex-executable', 'manager-launch'].map(name => product + 'scripts/cli/' + name + '.mjs') : [];
  return [...fixture.files, ...retainedHotfixAdditions, ...reviewedMaintenanceAdditions, ...collaborationDeliveryAdditions, ...claudeBackgroundReturnAdditions].filter(item => item.path.startsWith(directory + '/'))
    .map(item => item.path).concat(earlierAdditions).sort();
}

function checkFrozenDirectory(directory, actual = filesBelow(directory)) {
  assert.deepEqual(actual, frozenDirectoryMembers(directory), 'frozen directory membership changed: ' + directory);
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
    '确认前只在授权内调查、设计或制作已获准的原型',
    '不能借原型开发正式业务功能',
    '旧批准不能覆盖新范围',
    '不重复索要同一批准',
    '记录其指定的适用范围与条件',
    '本次例外不自行泛化为长期默认',
    '明确的跨任务授权也不逐任务重问',
  ]);
  contains(pm, ['新的业务开发任务，PM在派单前完整读取`task-design/SKILL.md`', '复用已有文档记录需求、技术设计及确认依据', '已确认需求与设计的路径/章节/修订、确认来源']);
  contains(agents, ['只读问答、状态查询和精确文件操作不套业务设计流程']);
  contains(design, ['用户要求只讨论或不写文件时仅在回复中给草案，不落盘、不开发']);
});

test('implementation and testing consume approved documentation, not an untraceable PM summary', () => {
  contains(rule, [
    '开始前实际读取当前需求、技术设计与必要直接依赖',
    '有原型时实际操作对应修订',
    '不能只读派单摘要或看截图',
    '修订不匹配时仅核实受影响差异',
    '同一文件当次只由一个写入者维护',
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
  // Decision rationale now lives with the engineering owner, not the PM hot path.
  { file: product + 'docs/AI编程协同机制/模板/阶段方案与关键决策模板.md', fragments: [
    '**选择与理由**：采用什么、为什么，与目标和约束如何对应',
    '若替代旧方案，写明被替代内容、原因和当前入口',
  ] },
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
    '项目 PM 维护整体目标与跨模块取舍，产品交互负责人维护需求、原型及其确认来源，模块负责人随实现更新技术设计、契约和必要实施记录',
    '交接后其他人的修订由当前写入者合入',
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
    checkFrozenDirectory(directory);
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
    const retained = retainedHotfixFingerprints.find(item => item.path === change.path);
    const latest = latestCliRepairHash(change.path, retained?.after ?? manager?.after ?? executable?.after ?? documents?.after ?? change.after);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), latest);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, 'rollback to the preceding repair must not pass');
    assert.equal(matchesFrozenFingerprint(original, latest), true);
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
    const retained = retainedHotfixFingerprints.find(item => item.path === change.path);
    const latest = latestCliRepairHash(change.path, retained?.after ?? manager?.after ?? executable?.after ?? change.after);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), latest);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, latest), true);
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
    const latest = latestCliRepairHash(change.path, manager?.after ?? change.after);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), latest);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, latest), true);
    assert.ok(frozenFailures(file => file === change.path ? read(file) + '\nchanged' : read(file)).includes(change.path));
  }
});

test('independent manager launch pins only bridge and guide without changing notification or model policy', () => {
  assert.deepEqual(cliManagerLifetimeFingerprints.map(item => item.path).sort(), [cli, product + 'scripts/cli/cli-bridge.mjs'].sort());
  for (const change of cliManagerLifetimeFingerprints) {
    const original = fixture.files.find(item => item.path === change.path);
    assert.equal(change.before, codexExecutableFingerprints.find(item => item.path === change.path).after);
    const latest = latestCliRepairHash(change.path, change.after);
    assert.equal(sha256(normalizeClaudeCompatibility(change.path, read(change.path))), latest);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    assert.equal(matchesFrozenFingerprint(original, latest), true);
    assert.ok(frozenFailures(file => file === change.path ? read(file) + '\nchanged' : read(file)).includes(change.path));
  }
  for (const name of ['cli-notify', 'desktop-host', 'cli-task-store', 'claude-client']) {
    const file = product + 'scripts/cli/' + name + '.mjs';
    assert.ok(!cliManagerLifetimeFingerprints.some(item => item.path === file));
    assert.ok(frozenFailures(candidate => candidate === file ? read(file) + '\nchanged' : read(file)).includes(file));
  }
  for (const item of fixture.portions) assert.ok(frozenFailures(file => file === item.path ? read(file).replace(item.start, item.start + ' changed') : read(file)).includes(item.path + ': ' + item.start));
});

test('Windows process identity repair pins one exact file and rejects rollback or extra edits', () => {
  assert.deepEqual(windowsProcessIdentityFingerprints.map(item => item.path), [product + 'scripts/cli/process-identity.mjs']);
  const change = windowsProcessIdentityFingerprints[0];
  assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
  const original = fixture.files.find(item => item.path === change.path);
  assert.ok(original);
  assert.equal(change.before, original.sha256, 'the original frozen baseline is not refreshed');
  const current = read(change.path);
  const latest = latestCliRepairHash(change.path, change.after);
  assert.equal(sha256(current), latest);
  assert.equal(matchesFrozenFingerprint(original, latest), true);
  assert.equal(matchesFrozenFingerprint(original, change.before), false, 'the old cmdlet implementation must not pass');
  // Reconstruct the exact earlier node before testing its original rollback.
  // This retains the old assertion instead of comparing an intermediate node
  // with a final file that also contains the independently reviewed exit proof.
  const earlier = current
    .replace('export function processStart(pid, { timeoutMs } = {}) {', 'export function processStart(pid) {')
    .replace('windowsHide: true, timeout: timeoutMs });', 'windowsHide: true });')
    .replace([
      '// A lost exit receipt is not proof of exit. Both saved identities must be gone;',
      '// missing proof and access failures deliberately remain errors, not permission to retire.',
      'export function nativeViewIsGone(record, options = { readStart: pid => processStart(pid, { timeoutMs: 2000 }) }) {',
      '  return processIsGone(record.server, options)',
      '    && processIsGone({ pid: record.view?.windowPid, startedAt: record.view?.windowStartedAt }, options);',
      '}', '', '',
    ].join('\n'), '');
  assert.equal(sha256(earlier), change.after, 'the full previous process-identity node remains reproducible');
  assert.equal(matchesFrozenFingerprint(original, sha256(earlier)), false, 'rollback of the exit proof must not pass');
  const rollback = earlier.replace([
    '    // Query the same Process.StartTime directly. The Get-Process cmdlet path can',
    '    // stall in a minimal host even when the underlying .NET query is available.',
    "    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });",
  ].join('\n'), "    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', windowsHide: true });");
  assert.equal(sha256(rollback), change.before, 'rollback counterexample is the exact prior file');
  for (const text of [rollback, current + '\n// unrelated identity change\n', current.slice(1)]) {
    assert.ok(frozenFailures(file => file === change.path ? text : read(file)).includes(change.path));
  }
  assert.ok(frozenFailures(file => {
    if (file === change.path) throw Error('missing');
    return read(file);
  }).includes(change.path + ': missing or unreadable'));
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

test('retained hotfix pins follow only the seven reviewed predecessor nodes and reject rollback', () => {
  const predecessors = [
    ['scripts/cli/claude-client.mjs', cliContractTurnCompletionFingerprints],
    ['scripts/cli/claude-hook.mjs', fixture.files],
    ['scripts/cli/claude-version-compatibility.test.mjs', claudeCompatibilityTestFingerprints],
    ['scripts/cli/native-cli-runner.mjs', cliDocumentContextFingerprints],
    ['scripts/cli/visible-cli-runner.mjs', cliDocumentContextFingerprints],
    ['skills/identity-pm/references/lifecycle-and-closeout.md', fixture.files],
    ['skills/identity-worker/SKILL.md', fixture.files],
  ];
  assert.deepEqual(retainedHotfixFingerprints.map(item => item.path).sort(), predecessors.map(([path]) => product + path).sort());
  for (const [relative, prior] of predecessors) {
    const path = product + relative;
    const change = retainedHotfixFingerprints.find(item => item.path === path);
    const predecessor = prior.find(item => item.path === path);
    const original = fixture.files.find(item => item.path === path);
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    assert.equal(change.before, predecessor.after ?? predecessor.sha256);
    const latest = latestCliRepairHash(path, change.after);
    assert.equal(sha256(read(path)), latest, path);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, path + ': rejects rollback');
    assert.equal(matchesFrozenFingerprint(original, latest), true, path);
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(file => file === path ? mutate(read(file)) : read(file)).includes(path), path);
    }
    assert.ok(frozenFailures(file => { if (file === path) throw new Error('missing'); return read(file); }).includes(path + ': missing or unreadable'));
  }
});

test('reconnect and attention pins follow exactly seven predecessor nodes and reject rollback or extra edits', () => {
  const predecessors = [
    ['scripts/cli/claude-client.mjs', retainedHotfixFingerprints],
    ['scripts/cli/cli-bridge.mjs', cliManagerLifetimeFingerprints],
    ['scripts/cli/cli-notify.mjs', fixture.files],
    ['scripts/cli/desktop-host.mjs', fixture.files],
    ['scripts/cli/interactive-cli-runner.mjs', cliDocumentContextFingerprints],
    ['scripts/cli/visible-cli-runner.mjs', retainedHotfixFingerprints],
    ['docs/AI编程协同机制/机制/04-CLI目标协作机制.md', cliManagerLifetimeFingerprints],
  ];
  assert.deepEqual(cliReconnectAttentionFingerprints.map(item => item.path).sort(), predecessors.map(([file]) => product + file).sort());
  for (const [relative, prior] of predecessors) {
    const file = product + relative;
    const change = cliReconnectAttentionFingerprints.find(item => item.path === file);
    const predecessor = prior.find(item => item.path === file);
    const original = fixture.files.find(item => item.path === file);
    assert.ok(original && predecessor, file);
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    assert.equal(change.before, predecessor.after ?? predecessor.sha256, file + ': exact predecessor retained');
    const latest = latestCliRepairHash(file, change.after);
    assert.equal(sha256(normalizeClaudeCompatibility(file, read(file))), latest, file);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, file + ': rollback rejected');
    assert.equal(matchesFrozenFingerprint(original, latest), true, file);
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(candidate => candidate === file ? mutate(read(candidate)) : read(candidate)).includes(file), file);
    }
    assert.ok(frozenFailures(candidate => { if (candidate === file) throw new Error('missing'); return read(candidate); }).includes(file + ': missing or unreadable'));
  }
  for (const item of fixture.portions) assert.ok(!cliReconnectAttentionFingerprints.some(change => change.path === item.path));
});

test('reviewed maintenance pins extend exact historical nodes without refreshing the baseline', () => {
  const predecessors = [
    ['docs/AI编程协同机制/机制/04-CLI目标协作机制.md', cliReconnectAttentionFingerprints],
    ['scripts/cli/claude-client.mjs', cliReconnectAttentionFingerprints],
    ['scripts/cli/cli-bridge.mjs', cliReconnectAttentionFingerprints],
    ['scripts/cli/cli-notify.mjs', cliReconnectAttentionFingerprints],
    ['scripts/cli/cli-task-store.mjs', cliStageContinuationFingerprints],
    ['scripts/cli/interactive-client.mjs', fixture.files],
    ['scripts/cli/process-identity.mjs', windowsProcessIdentityFingerprints],
    ['scripts/cli/visible-cli-runner.mjs', cliReconnectAttentionFingerprints],
    ['scripts/runtime/control-runtime.mjs', fixture.files],
    ['scripts/runtime/worker-result-receipts.mjs', fixture.files],
    ['skills/identity-pm/references/lifecycle-and-closeout.md', retainedHotfixFingerprints],
  ];
  assert.deepEqual(reviewedMaintenanceFingerprints.map(item => item.path).sort(), predecessors.map(([file]) => product + file).sort());
  for (const [relative, prior] of predecessors) {
    const file = product + relative;
    const change = reviewedMaintenanceFingerprints.find(item => item.path === file);
    const predecessor = prior.find(item => item.path === file);
    const original = fixture.files.find(item => item.path === file);
    assert.ok(original && predecessor, file);
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    assert.equal(change.before, predecessor.after ?? predecessor.sha256, file + ': exact predecessor retained');
    let current = normalizeClaudeCompatibility(file, read(file));
    assert.notEqual(current, null);
    if (file === receiptFile) {
      assert.equal(current.split(receiptRenameAfter).length, 2, 'the prior bounded retry is retained exactly once');
      current = current.replace(receiptRenameAfter, receiptRenameBefore);
    }
    const latest = latestCliRepairHash(file, change.after);
    assert.equal(sha256(current), latest, file);
    assert.equal(matchesFrozenFingerprint(original, latest), true, file);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, file + ': reviewed fix rollback rejected');
    assert.equal(matchesFrozenFingerprint(original, original.sha256), false, file + ': initial baseline rollback rejected');
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(candidate => candidate === file ? mutate(read(candidate)) : read(candidate)).includes(file), file);
    }
    assert.ok(frozenFailures(candidate => { if (candidate === file) throw new Error('missing'); return read(candidate); }).includes(file + ': missing or unreadable'));
  }
  for (const item of fixture.portions) assert.ok(!reviewedMaintenanceFingerprints.some(change => change.path === item.path));
});

test('maintenance admits only the three retained regression files and rejects unknown membership', () => {
  assert.deepEqual(reviewedMaintenanceAdditions.map(item => item.path).sort(),
    ['claude-compaction-cwd', 'claude-orphan-retirement', 'claude-waiting-attention'].map(name => product + 'scripts/cli/' + name + '.test.mjs').sort());
  for (const item of reviewedMaintenanceAdditions) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
    const latest = latestCliRepairHash(item.path, item.sha256);
    assert.equal(sha256(read(item.path)), latest);
    assert.equal(matchesFrozenFingerprint(item, latest), true);
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(file => file === item.path ? mutate(read(file)) : read(file)).includes(item.path));
    }
    assert.ok(frozenFailures(file => { if (file === item.path) throw new Error('missing'); return read(file); }).includes(item.path + ': missing or unreadable'));
    const directory = product + 'scripts/cli';
    const current = filesBelow(directory);
    assert.throws(() => checkFrozenDirectory(directory, current.filter(file => file !== item.path)), /membership changed/);
    assert.throws(() => checkFrozenDirectory(directory, [...current, directory + '/unreviewed.test.mjs'].sort()), /membership changed/);
  }
});

test('maintenance retains accepted-goal recovery and excludes the separate successor implementation', () => {
  assert.deepEqual(excludedSuccessorFingerprints.map(item => item.path).sort(),
    ['cli-bridge', 'cli-task-store'].map(name => product + 'scripts/cli/' + name + '.mjs').sort());
  for (const item of excludedSuccessorFingerprints) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
    const file = item.path;
    const original = fixture.files.find(item => item.path === file);
    assert.equal(matchesFrozenFingerprint(original, item.sha256), false, file + ': unshipped branch is not a maintenance exception');
    assert.ok(read(file).includes('acceptedGoalRecovery'), file + ': preserve the installed recovery path');
    assert.ok(!read(file).includes('sessionFrom') && !read(file).includes('createSuccessor'), file);
  }
  assert.ok(!read(cli).includes('sessionFrom'), 'the guide must describe the actual packaged path');
});

test('retained hotfix regression files require exact contents and frozen directory membership', () => {
  assert.deepEqual(retainedHotfixAdditions.map(item => item.path).sort(),
    ['claude-hook-stdin', 'cli-environment'].map(name => product + 'scripts/cli/' + name + '.test.mjs').sort());
  for (const item of retainedHotfixAdditions) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
    assert.equal(sha256(read(item.path)), item.sha256);
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(file => file === item.path ? mutate(read(file)) : read(file)).includes(item.path));
    }
    assert.ok(frozenFailures(file => { if (file === item.path) throw new Error('missing'); return read(file); }).includes(item.path + ': missing or unreadable'));
  }
  for (const directory of fixture.directories) {
    const current = filesBelow(directory);
    checkFrozenDirectory(directory, current);
    assert.throws(() => checkFrozenDirectory(directory, current.slice(1)), /membership changed/);
    assert.throws(() => checkFrozenDirectory(directory, [...current, directory + '/unexpected.mjs'].sort()), /membership changed/);
  }
});

test('collaboration delivery pins the reviewed successor and rejects rollback, extra edits and unknown files', () => {
  assert.equal(collaborationDeliveryFingerprints.length, 11);
  for (const change of collaborationDeliveryFingerprints) {
    const original = fixture.files.find(item => item.path === change.path);
    const predecessor = reviewedMaintenanceFingerprints.find(item => item.path === change.path)
      ?? retainedHotfixFingerprints.find(item => item.path === change.path);
    assert.ok(original);
    assert.equal(change.before, predecessor?.after ?? original.sha256);
    const latest = latestCliRepairHash(change.path, change.after);
    assert.equal(matchesFrozenFingerprint(original, latest), true);
    if (latest !== change.after) assert.equal(matchesFrozenFingerprint(original, change.after), false);
    assert.equal(matchesFrozenFingerprint(original, change.before), false);
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(file => file === change.path ? mutate(read(file)) : read(file)).includes(change.path));
    }
  }
  for (const item of collaborationDeliveryAdditions) {
    assert.equal(sha256(read(item.path)), item.sha256);
    assert.ok(frozenFailures(file => file === item.path ? read(file) + '\nextra' : read(file)).includes(item.path));
    assert.ok(frozenFailures(file => { if (file === item.path) throw Error('missing'); return read(file); }).includes(item.path + ': missing or unreadable'));
  }
  assert.equal(collaborationDeliveryPortions.length, 1);
  for (const item of collaborationDeliveryPortions) {
    assert.equal(item.before, fixture.portions.find(original => original.path === item.path && original.start === item.start).sha256);
  }
});

test('Claude background return advances exactly six reviewed predecessor nodes and rejects rollback or edits', () => {
  const predecessors = [
    [cli, collaborationDeliveryFingerprints],
    [product + 'scripts/cli/claude-client.mjs', reviewedMaintenanceFingerprints],
    [product + 'scripts/cli/cli-notify.mjs', collaborationDeliveryFingerprints],
    [product + 'scripts/cli/visible-cli-runner.mjs', reviewedMaintenanceFingerprints],
    [product + 'scripts/cli/claude-version-compatibility.test.mjs', retainedHotfixFingerprints],
    [product + 'scripts/cli/claude-compaction-cwd.test.mjs', reviewedMaintenanceAdditions],
  ];
  assert.deepEqual(claudeBackgroundReturnFingerprints.map(item => item.path).sort(), predecessors.map(([file]) => file).sort());
  for (const [file, prior] of predecessors) {
    const change = claudeBackgroundReturnFingerprints.find(item => item.path === file);
    const predecessor = prior.find(item => item.path === file);
    const original = [...fixture.files, ...reviewedMaintenanceAdditions].find(item => item.path === file);
    assert.ok(original && predecessor, file);
    assert.deepEqual(Object.keys(change).sort(), ['after', 'before', 'path']);
    assert.equal(change.before, predecessor.after ?? predecessor.sha256, file + ': exact previous version retained');
    assert.match(change.after, /^[a-f0-9]{64}$/);
    assert.equal(sha256(normalizeClaudeCompatibility(file, read(file))), change.after, file);
    assert.equal(matchesFrozenFingerprint(original, change.after), true, file);
    assert.equal(matchesFrozenFingerprint(original, change.before), false, file + ': previous version rejected');
    assert.equal(matchesFrozenFingerprint(original, original.sha256), false, file + ': original version rejected');
    for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
      assert.ok(frozenFailures(candidate => candidate === file ? mutate(read(candidate)) : read(candidate)).includes(file), file);
    }
    assert.ok(frozenFailures(candidate => { if (candidate === file) throw Error('missing'); return read(candidate); }).includes(file + ': missing or unreadable'));
  }
});

test('Claude background return adds only its exact regression file and rejects missing or unknown members', () => {
  assert.deepEqual(claudeBackgroundReturnAdditions.map(item => item.path), [product + 'scripts/cli/claude-background-return.test.mjs']);
  const item = claudeBackgroundReturnAdditions[0];
  assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(read(item.path)), item.sha256);
  for (const mutate of [text => text + '\nextra', text => text.slice(1), () => '']) {
    assert.ok(frozenFailures(file => file === item.path ? mutate(read(file)) : read(file)).includes(item.path));
  }
  assert.ok(frozenFailures(file => { if (file === item.path) throw Error('missing'); return read(file); }).includes(item.path + ': missing or unreadable'));
  for (const directory of fixture.directories) {
    const current = filesBelow(directory);
    checkFrozenDirectory(directory, current);
    const protectedMember = directory === product + 'scripts/cli' ? item.path : current[0];
    assert.throws(() => checkFrozenDirectory(directory, current.filter(file => file !== protectedMember)), /membership changed/);
    for (const extra of ['/unreviewed.test.mjs', '/unknown-directory/unreviewed.mjs']) {
      assert.throws(() => checkFrozenDirectory(directory, [...current, directory + extra].sort()), /membership changed/);
    }
  }
});

test('Claude background return does not advance Formal Worker runtime, Skills or model policy pins', () => {
  const protectedFiles = fixture.files.filter(item => item.path.startsWith(product + 'scripts/runtime/')
    || item.path.startsWith(product + 'skills/') || item.path === product + 'scripts/beyond-control.mjs');
  assert.ok(protectedFiles.length > 0);
  for (const item of protectedFiles) {
    assert.ok(![...claudeBackgroundReturnFingerprints, ...claudeBackgroundReturnAdditions].some(change => change.path === item.path));
    assert.ok(frozenFailures(file => file === item.path ? read(file) + '\nextra' : read(file)).includes(item.path));
  }
  for (const item of fixture.portions) {
    assert.ok(!claudeBackgroundReturnFingerprints.some(change => change.path === item.path));
    assert.ok(frozenFailures(file => file === item.path ? read(file).replace(item.start, item.start + ' changed') : read(file)).includes(item.path + ': ' + item.start));
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
