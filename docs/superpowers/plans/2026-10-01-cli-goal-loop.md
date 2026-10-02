# CLI 目标协作实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择当前对话自行实现，不另派执行者代改。

**Goal:** 在 BEYOND 增加可选 CLI 执行路径，负责人下发后不陪跑，收到结果后核验并在同一会话中继续达成目标。

**Architecture:** 独立 CLI 入口负责启动和续跑，后台程序保存结果并通知真实调用者。Desktop Worker 委派 CLI 时复用原任务；PM 直接委派独立结果时使用显式 CLI 执行登记。业务裁决始终由负责人作出，既有 Worker 回执及回源算法不替换。

**Tech Stack:** Node.js 内置模块、原生 Codex CLI 的 JSONL 与 exec resume、现有同步控制 runtime 和工作台事务、Desktop 消息能力适配。无新增运行依赖、全局守护进程或 Hook。

**Spec:** [CLI 目标协作设计](../specs/2026-10-01-cli-goal-loop-design.md)。

## Global Constraints

- 基线：BEYOND 3.2.7；本次不改版本号、不打包、不安装、不发布。
- CLI 使用用户配置的第三方 API，在指定项目目录工作，保留会话上下文。
- CLI 只通知这个负责人，不同时接受 PM 和 Worker 两套指挥。
- CLI 普通失败不自动暂停；CLI 一轮成功退出不自动等于业务完成。
- CLI 中间结果不进入 `worker-result.enqueue`；默认 Worker 路径继续可用。
- 实施不直接修改真实业务项目、已安装 Skills、当前正在运行的本机原型、用户登录、模型矩阵或生产环境。
- 本机原型是移植参考，不直接复制其固定路径、版本、业务措辞或恢复假设；不能把本机兼容实现写成官方能力保证。
- 项目身份使用现有 `ProjectIdentityProvider` 校验；直接 CLI 不要求 `createWorker=true`，但不能跳过控制根、仓库或执行目录校验。

## Review Focus

1. CLI 在启动者答复之前结束：首次绑定和失败结果也必须自动回到原负责人，不靠事后 attach。
2. 会话启动前即失败、没有 sessionId：仍保存失败证据和通知；恢复不能猜测或另开会话重复已有动作。
3. 两个不同纠偏同时要求 resume：只运行一轮，另一个明确冲突；相同请求可重放但不能重复启动。
4. 消息送达后负责人没有处理、或宿主在回合尾部吞掉执行机会：送达和处理分开记录，真实验证不能由用户催促代替。
5. 结果生成后用户停止、改变授权，或 taskDir 经符号链接指向另一项目：不执行迟到指令，不越界读写或结束进程。

---

## 文件与接口约定

新运行代码放在 `模板交付包/scripts/cli/`；功能测试沿用 `scripts/check-*.mjs` 和 `node:test`。唯一运行规则放在 `模板交付包/docs/AI编程协同机制/机制/04-CLI目标协作机制.md`，根入口只映射，身份 Skill 只衔接，不复制后台算法。

### 共同数据形状

以下字段为此次新增接口的实施约定，不代表现行产品已经支持。传输均为 JSON 对象；时间为有效 ISO 字符串；所有定位文件必须位于经校验的任务目录内。

- `Identity = { projectId, taskId, ownerThreadId }`。负责人必须匹配启动者继承的 Desktop 身份，不接受 CLI 输出提供的回源目标。
- `Binding = { ...Identity, ownerTurnId, executionRoot, projectRoute?, profilePath, taskMode, contract }`。`taskMode` 为 `formal / assist`，formal 对应已登记 CLI 独立任务；assist 不新登记任务。`contract = { goal, boundaries, acceptance, factEntries, skillEntries }`；后两个是可为空的精确入口数组，不是全仓资料。
- `Run = { ...Identity, runNumber, requestId, sessionId, status, resultPath }`。`sessionId` 首次初始化可为 null，之后只能绑定真实 CLI 事件。
- `TaskState = { schemaVersion: 1, ...Binding, sessionId, runNumber, status, currentResultPath, managerPid, processIdentity, updatedAt }`。managerPid/processIdentity 在尚未启动或已退出时为 null，启动后记录进程 PID 与可核验启动身份；初始 status 为 starting，已启动为 running，已退出为 Result 的运行状态。
- `Result = { ...Identity, runNumber, sessionId, status, exitCode, finalText, eventsPath, stderrPath, error, completedAt }`。`status` 为 `completed / failed / stopped / unknown`；业务状态不由此字段决定。
- `Review = { ...Identity, runNumber, resultSha256, decision, evidenceLocator, conclusion, reviewedAt }`。`decision` 为 `continue / accept / pause / close`；通知与 review 都不自行触发下一轮。
- `Profile = { schemaVersion: 1, runner: { command, args }, codexHome, model }`。可执行程序、配置根均为已确认绝对路径；档案只引用隔离认证配置，不保存 API key，不允许静默替换认证来源。
- `NotificationOutcome = { status, markerPath, error? }`；`TerminalOutput = { operationId, taskId, execution, status, stateRevision, archived }`。CLI 终态输出不含虚假 worker 字段；旧 Worker 输出形状不变。

状态目录由固定控制根推导为 `local/runtime/cli-tasks/<projectId>/<taskId>/`。当前任务使用 `task.json`，每轮保存 `runs/<runNumber>/`；负责人只提交任务身份和轮次，不任意提供结果文件路径。目录边界在创建前和读取时均核对真实路径，拒绝重解析点逃逸。

## Task 1: CLI 任务状态与结果存储

**Files:**
- Create: `模板交付包/scripts/cli/cli-task-store.mjs`
- Test: `scripts/check-cli-task-store.mjs`

**Interfaces:**
- `new CliTaskStore({ controlRoot })`：使用既有控制根下的 CLI 命名空间。
- `create(binding: Binding): TaskState`、`read(identity: Identity): TaskState`。
- `beginRun(identity, { requestId, prompt, expectedRunNumber, expectedSessionId }): Run`：排他分配一轮；prompt 实际内容参与请求去重。
- `bindSession(run: Run, sessionId: string): TaskState`、`finishRun(run: Run, result: Result): Result`。
- `readResult(identity, runNumber): Result`、`recordReview(review: Review): Review`；内部解析路径并核对身份及结果指纹。
- `claimNotification(identity, runNumber): { claimed, markerPath }`、`finishNotification(identity, runNumber, { status, error?, sentAt? })`。通知状态为 `claimed / delivered / delivery-unknown / unavailable`。

- [x] **Step 1: 写失败测试。** 覆盖 `first-run-can-fail-without-session`、`same-request-replays`、`different-concurrent-resume-rejected`、`owner-project-session-mismatch-rejected`、`stale-result-cannot-replace-current`、`linked-directory-escape-rejected`。并发项用两个真实测试进程同时申请，断言仅一份运行被分配，不能只做同一进程顺序调用。核心断言：

```js
assert.equal(first.sessionId, null);
assert.equal(store.beginRun(id, request).runNumber, first.runNumber);
assert.throws(() => store.beginRun(id, changedPrompt), /conflict/);
assert.throws(() => store.readResult(otherOwner, first.runNumber), /identity/);
assert.equal(store.read(id).runNumber, first.runNumber);
```

- [x] **Step 2: 运行 `node --test scripts/check-cli-task-store.mjs`。** 实现前应因模块或接口缺失失败，记录实际失败原因。
- [x] **Step 3: 实现上述接口。** 使用原子替换保存状态和结果、排他锁分配运行及通知；借鉴现有工作台持久化方式，不抽取重构旧模块。运行结果先稳定保存再更新当前状态；review、通知各自去重。未确认存活归属的锁或运行只能标记 unknown 并定点核验，不自动重启。
- [x] **Step 4: 重跑本任务测试。** 全部通过；错配与拒绝场景断言其他任务内容和当前状态未变。
- [x] **Step 5: 仅提交本任务两个文件。** 提交前 `git diff --check`，提交信息 `feat: add isolated CLI task state`。

## Task 2: 首次异步启动与同会话续跑

**Files:**
- Create: `模板交付包/scripts/cli/native-cli-runner.mjs`
- Create: `模板交付包/scripts/cli/cli-bridge.mjs`
- Test: `scripts/check-cli-launcher.mjs`

**Interfaces:**
- Consumes: Task 1 的 `CliTaskStore`。
- `runNativeCli({ binding, run, profile, prompt, store, onTerminal }): Promise<Result>`：消费真实事件，在 `thread.started` 时立即绑定会话；关闭进程并落盘后调用 `onTerminal(result)` 一次。
- `launchCliRequest(request, context): Promise<Run>`：context 提供 `controlRoot / executionRoot / ownerThreadId / ownerTurnId` 及通知适配；入口返回已确认后台启动的回执，不返回业务成功。
- CLI：`node scripts/cli/cli-bridge.mjs --request <文件>`，请求 `{ schemaVersion: 1, requestId, action, input }`。
- `action` 为 `cli.start / cli.resume / cli.result / cli.status / cli.review / cli.stop / cli.recover`。start 消费 Binding；resume 消费 Identity、prompt、expectedRunNumber、expectedSessionId；result/status/review 消费 Task 1 对应输入。stop/recover 接受当前状态指纹和明确停止或恢复依据，不做自动重启。

- [x] **Step 1: 写失败测试。** 使用测试内生成的 Node 假 CLI，覆盖 `launch-returns-before-terminal`、`thread-start-persists-before-exit`、`resume-uses-exact-session`、`spawn-failure-retained`、`event-failure-not-completed`、`stderr-warning-does-not-block-success`、`profile-does-not-leak-or-fallback`、`stop-only-owned-process`。用测试进程信号控制结束，不依赖模型声称等过时间。断言：

```js
assert.equal(launched.status, 'running');
assert.equal(store.read(id).sessionId, emittedSession);
assert.equal(fakeArgs.includes('--last'), false);
assert.equal(result.status, 'failed');
assert.equal(otherProcessWasStopped, false);
```

- [x] **Step 2: 运行 `node --test scripts/check-cli-launcher.mjs`。** 确认缺失入口或预期行为失败，不把假 CLI 错误当作产品失败。
- [x] **Step 3: 实现原生 runner 与独立启动入口。** 以原生 exec JSONL 运行、指定 sessionId resume，prompt 从 stdin 传入；只将进程/事件/最终输出闭合写为 completed，普通 stderr 警告不判成运行失败。后台辅助进程以隐藏方式启动，返回前确认其接管绑定；不在同步 `executeRuntimeRequest` 里等待 CLI。执行目录复用现有项目路由校验，不需要 Desktop 创建 Worker 能力。formal 模式要求原登记匹配；存在原 Worker 任务的 assist 模式要求当前负责人确为该 Worker。续跑前重新核对任务尚未关闭和当前授权，不能只凭旧 CLI 状态继续。停止与恢复需同时核对保存 PID 的启动身份、会话事件及当前状态指纹，证据不足不发 kill 或 restart。
- [x] **Step 4: 重跑 Task 1、2 测试。** 同一会话两轮，第二轮实际读取第一轮产物；中断恢复保持已有会话和副作用，不复用完整本机恢复方案中的用户路径假设。
- [x] **Step 5: 仅提交本任务三个文件。** 提交信息 `feat: launch and resume CLI without model waiting`。

## Task 3: 回合结束观察与原负责人通知

**Files:**
- Create: `模板交付包/scripts/cli/desktop-host.mjs`
- Create: `模板交付包/scripts/cli/cli-notify.mjs`
- Modify: `模板交付包/scripts/cli/cli-bridge.mjs`、`native-cli-runner.mjs`
- Test: `scripts/check-cli-notification.mjs`

**Interfaces:**
- `createDesktopHost({ env, pluginRoot, sourceRecordPath }): HostAdapter`。入口来自真实继承的 Desktop 环境和指定插件目录；不遍历其他安装或复制原生管道协议。
- `HostAdapter.currentSource(): { ownerThreadId, ownerTurnId, sourceRecordPath }`：对照继承的 thread 身份与该线程当前记录，取得真实源回合；调用者不能用请求字段指定另一个线程或历史回合。入口在 launchCliRequest 构造 context 时使用它，不要求用户手工查编号。
- `HostAdapter.checkCapability(): Promise<{ available, reason? }>`：发现已安装插件声明及当前 `send_message_to_thread` schema，拒绝不支持宿主。
- `HostAdapter.waitForSourceTurnEnd({ ownerThreadId, ownerTurnId, signal }): Promise<void>`：订阅前后读取同一回合的持久记录，匹配身份，退出观察时释放资源。
- `HostAdapter.send({ ownerThreadId, prompt }): Promise<{ status, error? }>`：调用实际工具，参数严格为 `threadId + prompt`；源身份为原启动者。
- `notifyWhenReady({ store, identity, runNumber, host }): Promise<NotificationOutcome>`：等待源回合退出及结果已落盘，去重后送出一次；Task 2 的 onTerminal 使用此接口。

- [x] **Step 1: 写失败测试。** 覆盖结果先到、回合先结束、订阅期间追加结束记录、分块记录、多次文件事件、没有 sessionId 的启动失败、插件版本路径变化、工具声明错配、送达超时和宿主退出。断言：

```js
assert.equal(sendCountBeforeSourceEnd, 0);
assert.equal(sendCountAfterResultAndSourceEnd, 1);
assert.deepEqual(Object.keys(sentArgs).sort(), ['prompt', 'threadId']);
assert.equal(notification.status, 'delivery-unknown');
assert.equal(reviewExists, false);
```

- [x] **Step 2: 运行 `node --test scripts/check-cli-notification.mjs`。** 确认前置绑定、事件观察或消息接口尚不存在时确实失败。
- [x] **Step 3: 实现两个条件共同放行及真实宿主适配。** owner 的结束信号观察在派发时建立，不等结果到达才订阅。兼容本机记录的方法只留在 HostAdapter；发现、读取和发送均检查真实身份。通知携带结果类型、项目、任务、轮次、状态和受管结果入口，不使用 Worker 终态回调文本。发送不明只记账，不盲重发；已处理记录与送达记录独立。后台程序完成一次通知尝试后退出，不等负责人思考结束。
- [x] **Step 4: 重跑 Task 1—3。** 断言重复通知事件不重复发送，通知过程不创建 Worker pending，日志不包含认证秘密，所有观察资源在结束或异常后释放。
- [x] **Step 5: 精确提交本任务文件。** 提交信息 `feat: notify the original CLI owner after dispatch`。

## Task 4: 两条产品路径与工作台兼容

**Files:**
- Modify: `模板交付包/scripts/runtime/control-runtime.mjs`、`模板交付包/scripts/runtime/workbench-transaction.mjs`
- Modify: `模板交付包/AGENTS.md`
- Modify: `模板交付包/skills/identity-pm/SKILL.md`、`模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md`
- Modify: `模板交付包/skills/identity-worker/SKILL.md`、`模板交付包/skills/identity-worker/references/lifecycle-and-recovery.md`
- Create: `模板交付包/docs/AI编程协同机制/机制/04-CLI目标协作机制.md`
- Test: `scripts/check-cli-workbench.mjs`、`scripts/check-cli-routing.mjs`

**Interfaces:**
- `workbench.register` 新记录可用 `execution: { kind: 'cli', ownerThreadId, stateLocator }`，不传 worker；旧记录无 execution 时按原 Worker 处理。正式 CLI 必须包含 projectId，runtime 验证它与控制根及状态入口一致。
- `WorkbenchTransactionStore.consumeAcceptedCliResult(input, { faultAt } = {}): TerminalOutput`；input 使用真实 ownerThreadId、当前轮次、结果指纹、已保存 review、expectedStatus 和验收/证据定位，明确 kind 为 `accepted-cli`。
- 新 action `workbench.accept-cli` 由 runtime 读取受管 CLI 结果及 review，再交给上面接口；不是直接相信 caller 传入的 finalText。原 `workbench.accept` 明确不能接受 CLI 类型。
- CLI 的暂停/恢复沿用既有业务状态更新；close 按 execution 分支校验真实 owner、停止依据及当前记录。原 Worker close 及其 pending 取消校验原样保留。
- accept-cli 使用现有意图、状态提交、历史、视图和完成事务步骤；历史/output 存 execution，不补虚假 worker。recover 根据 kind 恢复 CLI 事务，不能误走 Worker 校验；Worker 事务结构不变。

- [x] **Step 1: 写失败测试。** 覆盖 `pm-can-own-two-distinct-cli-goals`、`legacy-worker-still-unique`、`cli-cannot-use-worker-accept`、`accept-cli-requires-current-result-and-review`、`cli-accept-replay-archives-once`、`cli-fault-recovery-at-every-stage`、`closed-goal-rejects-late-accept`、`cross-project-no-workbench-write`。路由断言两条路径都有负责人，未启用 CLI 的原终态顺序及参数未变。
- [x] **Step 2: 运行 `node --test scripts/check-cli-workbench.mjs scripts/check-cli-routing.mjs`。** 预期 CLI 登记/验收能力缺失而失败。
- [x] **Step 3: 实现类型化登记、验收和规则入口。** 条件分支只影响显式 CLI 记录，旧 Worker 校验不宽放。CLI 状态更新要求 ownerThreadId 与登记匹配；close 不沿用 Worker 的 workerStopped 自述，而是核对 bridge 保存的停止依据。工作台显示 CLI/负责人及状态入口，不新增业务状态。进入 Skill 修改前读取 skill-creator 与 writing-skills，依据本任务的触发与回归用例实施，不另建身份 Skill。Skill 加入已确认 CLI 后台运行的等待例外：本 Worker 不向 PM 申请续派，但正式完成/暂停仍回 PM；需要项目裁决仍走既有进展回源。PM 根据结果缺口继续同一 CLI 会话，不拿 CLI 成功替代目标完成。根入口只增加选路和唯一文档映射，专业方法沿用现有 Action Skills。
- [x] **Step 4: 验证新工作台测试与相邻基线。** 运行 Task 1—4 测试，再运行 `node --test scripts/check-m3-workbench-transaction.mjs scripts/check-workbench-upgrade-migration.mjs scripts/check-worker-result-receipts.mjs scripts/check-native-worker-return.mjs scripts/check-project-runtime-routing.mjs scripts/check-accept-receipt-cache-expiry.mjs`。旧用例失败先查真实回退，不删断言凑绿。
- [x] **Step 5: 精确提交本任务文件。** 提交信息 `feat: integrate optional CLI execution with BEYOND goals`。

## Task 5: 完整目标循环、真实唤醒与回归证据

**Files:**
- Create: `scripts/check-cli-goal-loop.mjs`
- Create: `scripts/prepare-cli-host-probe.mjs`
- Modify: `模板交付包/scripts/verify-install-integrity.mjs`、`scripts/check-install-integrity.mjs`
- Modify: `模板交付包/README.md`
- Test: Task 1—4 测试与以下既有相邻基线；真实宿主记录保存在临时/受管本机目录，不提交私有对话或 API 日志。

**Interfaces:**
- 模拟完整测试直接调用 Task 1—4 接口；覆盖任务登记、启动、通知、review、resume、验收和重复事件。
- `prepare-cli-host-probe.mjs --output <新临时目录>` 只创建隔离样例、任务输入与证据位置，不安装、不自动调用付费 API。输出明确区分模拟/真实、送达/处理、运行完成/业务完成。
- integrity 内容校验将新增产品脚本和唯一机制文档纳入必需文件，不要求用户已安装 CLI、不读取认证配置；关闭 CLI 能力不影响原产品完整性。

- [x] **Step 1: 写失败测试。** 完整样例第一轮故意部分完成或出现普通失败，负责人核验后下发纠偏，CLI 第二轮读取第一轮文件并修复，最终运行样例真实测试。断言相同 sessionId、两个 run、业务未提前完成、最终历史一条、零 CLI 中间 Worker pending。另测用户中途停止或换目标、两个目标通知乱序、通知 delivered 但未 review，以及缺产品脚本而验真错误。
- [x] **Step 2: 运行 `node --test scripts/check-cli-goal-loop.mjs` 及 `node scripts/check-install-integrity.mjs`。** 验证新全链场景和新增文件校验在实现前有精确失败依据。
- [x] **Step 3: 实现完整样例和证据汇总。** 不新建监控网页；可查看原生工作事件与最终产物，但不宣称右侧终端已获得输入能力。补 README 可选入口、独立 API 配置引用、同会话续跑、可见性、支持宿主及停用边界。版本及发布材料不变。
- [x] **Step 4: 运行完整隔离回归。**

```text
node --test scripts/check-cli-task-store.mjs scripts/check-cli-launcher.mjs scripts/check-cli-notification.mjs scripts/check-cli-workbench.mjs scripts/check-cli-routing.mjs scripts/check-cli-goal-loop.mjs
node --test scripts/check-m3-workbench-transaction.mjs scripts/check-workbench-upgrade-migration.mjs scripts/check-worker-result-receipts.mjs scripts/check-native-worker-return.mjs scripts/check-project-runtime-routing.mjs scripts/check-accept-receipt-cache-expiry.mjs scripts/check-receipt-write-concurrency.mjs scripts/check-receipt-list-concurrency.mjs
node scripts/check-install-integrity.mjs
node scripts/check-public-content.mjs
git diff --check
```

预期各命令退出码 0、测试失败 0。测试数量以实际输出为准，不预先编造通过数。安装检查只是新增文件覆盖，不能代替目标循环验证。

- [x] **Step 5: 验证真实 Desktop 链并精确提交。** 使用已配置第三方 API 和隔离样例验证首次 start、失败通知、至少两轮同会话续跑、空闲回调、忙碌主问题完整、回合尾部到达、重复送达防重，以及 Worker→CLI→PM 原链。需要新的用户可见测试对话时先取得用户明确授权；不借模拟子智能体替代真实 Worker。没有实时宿主能力或自动处理证据时记录“未验证/失败”，不通过人工催促或人工收口改判。自动回调测试须跨实际回合观察，不能在同一模型回合等待它结束。全部证据闭合后提交 `test: verify CLI goal loop and legacy compatibility`，仍不安装或发布。

## 交付与放行

实现阶段逐项保存测试结果和失败修复依据。完成后说明哪些程序逻辑通过隔离验证、哪些路径通过真实验证、仍有什么限制；未完成的项不挤进“全部通过”。默认 Desktop Worker 路径可继续用，但不因它通过而宣布 CLI 新分支可用。

本计划由当前对话自己实施。先请用户审阅实施顺序，再开始 Task 1；不另询问执行者选择、不自动派新的开发对话、不修改现役工具来试错。

## 2026-10-02 验证记录

- 隔离回归：CLI 44/44、原 Worker/回执/路由/工作台 122/122；安装内容 68 项、公开内容 221 个文件及差异检查通过。
- 真实本机：原生 CLI 使用已有第三方 API；直接负责人两轮同会话纠偏、真实 Worker 两轮协作并最终回 PM、两个重叠正式 CLI 目标分别验收、实际启动失败通知均已验证，未靠用户催促。
- 前台保护：三个 CLI 结果先完成，但均在派发回合的真实结束记录之后通知；新回合实际处理多个通知，正常目标各归档一次，失败不验收。对真实记录重放通知入口，全部防重且原送达记录不变。
- 实测发现同一 Windows 绝对路径的斜杠形式被误判不一致。新增两项失败测试后修正比较方式；不同执行根、相对状态定位仍拒绝。并发真实启动使用修正版；Worker 使用之前复制的版本，自行修正请求路径后完成，未在运行中替换其脚本。
- 验证范围不包括生产或跨主机实测；也不保证宿主在其他回合的极端 final 边界一定安排处理。失去子进程启动证明时保守失败，不自动重启。私有宿主记录和 API 日志仅在临时目录保存。
- 本轮仅在候选源和临时项目操作；未修改已安装 Skills、认证配置、模型矩阵、万事通或生产环境，未打包、安装或发布。
