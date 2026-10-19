# 可选CLI目标协作

只有老板或当前任务明确选择原生CLI执行时读取。本机制是可选分支，不替换默认桌面Worker、不新增身份Skill，也不要求普通BEYOND安装具备CLI或API认证。直接调用者仍对已批准业务目标负责；CLI负责执行，不能自行验收、创建桌面任务或改写授权。

## 两条路径

- `PM → Worker ↔ CLI → Worker → PM`：原Worker持有任务和CLI会话，负责核验、纠偏、同会话续做。CLI每轮只通知该Worker；Worker最终完成或真实暂停时仍按原身份入口enqueue、回源和输出final。不能由PM接管已经归原Worker的CLI辅助。
- `PM或Worker ↔ CLI`：当前调用者直接持有CLI目标、核验并继续同会话。PM可把明确的独立CLI结果登记为正式任务；没有原Worker时不编造Worker编号。已有Worker任务的CLI使用属于辅助，不另登记正式CLI目标。

调用者派发成功后结束本轮派发，不等业务完成、不轮询或长时间陪跑。当前还有老板请求则继续答完。日志模式在实际CLI退出后通知；原生交互模式在原生回合结束事件且结果稳定落盘后，确认负责人当前前台回合已结束，再尝试一次通知原调用者（Codex使用`turn/completed`，其他可选适配见各自支持边界）。空闲窗口不代表业务已完成，也不要求CLI整个进程先退出。交互辅助进程只服务绑定的这一个任务：关闭窗口后在当前轮结束时退出；负责人accept/pause/close后退出，不安装全局Hook、常驻系统服务或第二套调度器。

## 只使用 Codex CLI 的最短路径

需要先稳定使用一种 CLI 时，直接复用本页 Codex 原生交互路径，不先配置 Claude 或 ZCode，也不新增服务、定时器或第二套回传。下面是用法，不改变模型矩阵或默认桌面 Worker 路径；已有其他 CLI 任务仍留在原提供者和原会话，不自动迁移。

1. 复用本机已验证的专用 Codex 配置；其绝对路径随任务保存，不把密钥、桌面登录或带版本号的示例路径打进包。新配置按下一节模板填入实际程序和专用 `CODEX_HOME`，使用 `mode=interactive`、`ui=window`。例如第三方 `glm-5.3-flash-codex` 的已验证配置使用 `effort=low`，不能直接照抄其他模型的 `medium`；其他模型按实际支持选择。这是兼容实例，不是统一模型默认值。
2. 从真实项目执行目录调用本页 `cli.start`。把完整目标、边界和最终验收写入 contract，现行需求与设计放入 factEntries，本轮交付写入 stage；辅助执行使用 assist，独立正式任务仍走本页原登记入口。不要因改用 CLI 丢掉项目资料或额外创建桌面执行者。
3. 返回 running 后结束派发，继续处理当前老板请求；没有前台工作就结束本回合。任务内保存原生 sessionId，工作过程在独立原生终端可见。负责人不等候轮询，也不手工模拟完成回调。
4. 收到真实 CLI_RESULT_READY 后，沿本页核对结果与实际产物。未达到完整目标时先 review=continue，再按保存的 runNumber、sessionId 执行 resume；有已保存下一轮要求时仍使用原 queue 自动接续，不重复 resume。已达标才 accept，不能把阶段完成或命令成功当成业务完成。
5. 关闭视图、Desktop 重连和程序升级均按本页原会话恢复规则处理，不用 `--last`，不新开替代会话，不强停正在执行的轮次。旧进程未退出时继续原连接；真实空档安装不会自动恢复业务。

开发仓已有 `scripts/probe-cli-concurrent-wakeup.mjs` 可只验证 Codex：dispatch 显式使用 `--providers codex --codex-profile <已配置文件> --codex-effort <支持的强度> --execution-parent <隔离测试父目录> --allow-live-model`。随后结束前台回合，真实通知回来才按同一 probe-root 执行 continue / accept。该探针使用真实模型、保存同一会话并独立复核测试；仅手动 inspect 或模拟通知不算通过。双轮成功证明该次派发、回传与续接，不等于长期无故障、忙碌前台重叠、多 CLI 并发或业务质量已经验收。

## 配置与启动

使用已经单独配置第三方API的原生Codex CLI。认证留在该CLI专用`CODEX_HOME`，不能复用桌面登录目录；产品不读取密钥，不自动安装或改写认证。配置文件只引用原生命令、专用目录及实际模型：

```json
{"schemaVersion":1,"runner":{"command":"<codex原生可执行文件绝对路径>","args":[]},"codexHome":"<CLI专用绝对目录>","model":"<第三方API实际支持的模型>","mode":"interactive","effort":"medium","ui":"window"}
```

新配置选择`mode=interactive`，运行真正的Codex原生交互界面，不拿JSON日志冒充对话。Windows的`ui=window`打开独立可见终端；`ui=attach`返回命令，由用户在自己的终端连接同一会话（Linux使用此方式）。这是外部原生终端，不声称已经能往Desktop右侧终端输入。已有未指定mode的配置继续沿用exec日志模式，不改变旧任务。交互模式需要Node.js 24及支持认证app-server的Codex可执行文件，最新实测0.162.0-alpha.2，仍逐次核对原生能力；不支持时说明真实原因，不静默换回日志。

Windows 桌面安装目录的 Codex 路径不再要求人工随升级改写：配置指向本用户 `OpenAI/Codex/bin/<缓存目录>/codex.exe` 或已注册包的 `app/resources/codex.exe`，且 args 为空时，先复用仍可用的程序；路径失效或能力不符时，只从当前用户注册的 OpenAI.Codex 安装包查找签名有效、具备所需能力的 CLI。不按缓存目录名、时间戳或任意 PATH 猜版本，不增加精确版本白名单；来源不明、注册冲突或能力不符时明确报错并保留原会话。自定义程序路径和带参数的包装入口仍遵守原显式配置，不自动替换。

已有原生会话先核实保存的进程身份，再继续连接原进程和原 session；升级发现不重启、不 detach、不改写历史结果，也不重新运行可能已被升级删除的旧程序做前置探测。模型、强度、认证目录、启动参数等仍执行原配置一致性检查，不能借路径发现绕过。只有原进程已确认退出、原负责人按既有路径续跑时，才重新定位可用程序并用保存的 sessionId 恢复；不自动续做、不创建替代会话。已打开的原生视图不切换程序；旧程序文件已被删除时，重新打开视图可能需要在原会话自然结束后恢复，不能为显示窗口强停任务。

不得在该文件放密钥、认证参数或隐式`--last`。第三方认证仍由CLI自己的专用目录读取。已获完全访问授权的 Codex 路径在交互服务、会话、每轮派单及兼容 exec 启动中均设置完全访问及`approval_policy=never`，不让用户逐命令审批；这只解决执行权限，不扩大任务授权，不自行授权生产发布。专业方法与项目资料沿用原任务授权，CLI按当前问题读一个匹配Action Skill及相关事实，不全量加载桌面历史；它不以`identity-worker`身份直接回PM。

三种 CLI 共用资料入口，不依赖它们是否自动识别同一种规则文件或用户 Skill 目录。每次受管派单或续跑时读取项目根与执行路径上的现有 `AGENTS.md`（同目录有非空 `AGENTS.override.md` 时优先），以及本轮 `contract.factEntries / skillEntries` 点名的正文，连同绝对来源、文件指纹和原目录交给 CLI；原生客户端自己的规则仍保持不变，不生成或覆盖 `CLAUDE.md`、全局配置或 Skill 副本。

`factEntries` 应指向本任务需要的现行需求、技术设计或直接相关资料入口，不能把“只给根规则”当成已交接模块设计。相对路径从已核验的项目主根解析，跨根时使用 `projectRoute.canonicalProjectRoot`，不随 CLI 的嵌套工作目录漂移；文件内链接从该文件原目录定位。显式指定的 Action Skill 读取正文；未指定时只提供控制仓已有四个 Action Skill 的可用路径，CLI 按当前动作选择，不全量加载全部方法或冒充桌面 Worker。

同一会话受管续跑重新读取当前资料，保留原 session 和历史成果，不沿用旧轮正文充当新版本。只读点名文件及根规则，不递归展开归档与全部链接；缺失、不可读或超出内联预算的条目明确标为未加载，可在原授权内按需补读，不能猜内容或找同名历史资料替代，也不因此增加整项任务审批。受管轮次的 `document-context.json` 只记录已内联的来源与指纹、未加载条目和可选 Skill 路径，不复制正文或建立另一套项目文档；它证明桥接读取了什么，不能代替 CLI 实际采用当前需求与设计的交付核验。原生窗口手工输入仍按客户端自己的读取机制执行，不声称该输入已经过受管资料刷新。

固定入口是`node <当前controlRoot>/scripts/cli/cli-bridge.mjs --request <JSON请求文件>`，工作目录必须是本任务真实`executionRoot`。启动、续跑入口从当前桌面进程和本轮记录核对真实调用者、回合与消息工具；不能从聊天猜线程或从其他项目寻找入口。消息能力不可用就不启动或续跑CLI、不声称它会自动回来。本地状态、结果、核验、停止与恢复仍可由继承身份匹配的原负责人调用，不依赖已经失效的消息通道。原路径照常可用。

直接CLI正式任务先通过原固定runtime执行`workbench.register`：

```json
{"schemaVersion":1,"requestId":"register-cli-goal","action":"workbench.register","input":{"projectId":"<已登记项目>","taskId":"<任务>","task":"<独立业务结果>","execution":{"kind":"cli","ownerThreadId":"<当前真实调用者>","stateLocator":"<controlRoot>/local/runtime/cli-tasks/<projectId>/<taskId>/task.json"},"status":"进行中","progress":"准备CLI执行","pause":"无","updatedAt":"<ISO时间>"}}
```

不传`worker`。状态入口由项目和任务唯一派生；允许先登记、再启动，不要求提前创建空CLI会话。原Worker辅助CLI跳过此登记。

启动请求：

```json
{"schemaVersion":1,"requestId":"cli-goal-run-1","action":"cli.start","input":{"projectId":"<项目>","taskId":"<任务>","taskMode":"formal","executionRoot":"<本次正式执行根>","profilePath":"<专用配置绝对路径>","contract":{"goal":"<完整业务目标>","boundaries":"<授权与不做事项>","acceptance":"<可判定验收>","factEntries":["<相关事实入口>"],"skillEntries":["<匹配Action Skill入口>"]},"stage":{"goal":"<本轮要交付的阶段结果>","acceptance":"<本轮证据和停止位置>"},"prompt":"<当前获准执行内容>"}}
```

`taskMode=assist`用于原Worker辅助或未登记的局部协助。跨根任务在input原样增加经核验的`projectRoute`；不得跨项目回退。同一请求编号只能重放同一参数；响应`running`表示后台已接管，不是CLI完成。结果缺失、启动不明或受管状态冲突时先定点核对，不重复启动。

完整目标、边界和最终验收留在 `contract`；每轮的 `stage.goal / stage.acceptance` 只界定这轮交付和结束位置，不能把阶段完成当成整个业务完成。start/resume 的阶段随该轮输入保存并传给三个 CLI；旧请求未带 stage 仍兼容。负责人按完整目标选择下一阶段，不把“查清现状、迁移、发布、供数验收”全部捆成一轮，也不为了分轮重建任务或会话。CLI交回阶段证据及完整目标的剩余缺口，负责人据此连续推进；这不是新增老板审批点。

start 和 resume 的 input 均可带 `"configuration":{"model":"<实际支持的模型>","effort":"<该模型支持的强度>"}`。调用者按当前任务、已有模型矩阵和第三方实际能力选择，不继承桌面模型。每轮保存本次配置，续做未指定的字段沿用该任务上一轮，不因其他任务换档或共享默认值变化而跟着改变；`effort:null`明确回到该 CLI 的原生默认。此对象只接受 model、effort，不接受密钥、权限或任意启动参数。结果中的 configuration 是派发配置，不冒充第三方服务确实采用了同名底层模型或推理预算的证明。模型目录可见不等于当前密钥有调用权；服务端拒绝时保留失败，负责人可在原授权目标内选择已可用模型续做，但不替换认证或反复调用被拒模型。

## 通知、核验与同会话循环

### 关闭 Desktop 后保留已派发工作

Windows 新启动的受管管理进程通过本机系统进程入口创建，核对同一用户、同一桌面会话且已脱离宿主作业组，再交付任务；不提权、不安装常驻服务。派发已接管后，关闭 Codex Desktop 不结束该 CLI 轮次，原 session 和结果仍由原任务保存。启动未确认就保留证据，不重复派发；系统入口被拒绝时不退回一个仍会随宿主退出的进程并宣称成功。此修补不迁移或重启已经运行的旧管理进程，也不承诺注销、关机或手工关闭 CLI 窗口后继续执行。

重新打开 Desktop 后，原负责人用 `cli.status / cli.result` 读取原任务，再按已有核验与 `cli.resume` 路径继续保存的 sessionId；仍在运行就连接原进程，不创建替代会话。受管 resume 会把本轮已核验的原负责人通知连接交给仍存活的管理进程；同一负责人、原对话记录及当前回合不匹配或新连接不可用时，不派发新指令，不猜其他消息管道。只刷新内存中的消息连接，不改原会话、模型、成果或历史通知。Desktop 离线时通知可能不可用，结果仍保留；不重发历史未知通知，不能把“后台完成”说成“PM 已处理”。

`CLI_RESULT_READY`携带项目、任务、轮次、状态、受管结果入口和指纹。它不同于Worker终态：不执行`worker-result.enqueue`，不创建Worker pending，不执行ack，不自动判定业务完成或暂停。消息送达与负责人已核验是两件事；发送超时只能记为未知，不能盲重发。通知不可用时结果保留，不能冒充自动处理成功。

同一桌面负责人来自不同CLI后台进程的通知串行发送，不限制CLI业务执行并发。发送前重新核对该负责人最新回合是否结束，而不只等待原派发回合；等待期间已经核验或被新轮替代的结果不再补发。接口返回成功后，还须观察到负责人新回合记录，才放行下一条通知；接口调用与回合记录确认分别默认最多观察60秒。发送失败、超时或记录未前进时保留未知交接凭据，不能仅因发送进程退出就再发；后续发送先确认原负责人记录已前进，再按最新回合是否结束继续，不自动重发未知消息。这不修补桌面程序自身的会话缓存，也不保证平台一定创建可执行回合。

收到通知，先核对登记负责人、项目、任务、当前轮和结果指纹，再定点读取结果及当前主证据。过期、重复、已关闭或不归本人的结果不启动新的执行。当前老板问题完整保留；处理结果后继续当前请求，尾部简述实际处理内容，不用后台通知替换前台目标。桌面平台若未形成可执行回合，本机制不能保证自动分析已发生；自然进入的后续回合仅补查本人已登记CLI结果，不轮询。

使用同一入口执行`cli.status`或`cli.result`，input为`projectId / taskId / ownerThreadId`，读取结果再加`runNumber`。`task.json`绑定真实`sessionId`，每轮`runs/<N>/`保存输入、工作事件、标准错误、结果、通知和核验；运行状态不是新的业务状态。工作事件可查看CLI正在做什么，但不是内部推理，也不声称桌面右侧终端已经获得输入能力。

负责人通过`cli.review`保存核验前，须依据当前产物和验收作出判断：

```json
{"schemaVersion":1,"requestId":"review-goal-1","action":"cli.review","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<调用者>","runNumber":1,"resultSha256":"<本轮result.json的SHA256>","decision":"continue","evidenceLocator":"<当前主证据>","conclusion":"<实际缺口或验收结论>","reviewedAt":"<ISO时间>"}}
```

`decision`仅为`continue / accept / pause / close`。这是负责人的核验记录，不自行改变工作台。每轮原始核验不可改写；普通失败或部分完成选择continue，不把进程exitCode=0当成业务完成。真实暂停后恢复时，在同一轮补交`decision=continue`的核验，附原`review.json`的`supersedesReviewSha256`与当前授权的`authorizationLocator`；另存续做依据，原暂停记录保留。工作台原暂停任务仍由负责人按既有恢复路径处理。要继续原目标时：

```json
{"schemaVersion":1,"requestId":"cli-goal-run-2","action":"cli.resume","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<调用者>","expectedRunNumber":1,"expectedSessionId":"<保存的真实会话>","prompt":"<依据缺口的纠偏与剩余验收>"}}
```

若同一任务已获新的明确授权，需要替换先前探针、只读阶段等限制，resume 的 input 同时提供完整 `contract`（字段同 start）与 `authorizationLocator`（授权原文入口）。仅在本轮稳定结束、原负责人已核验 continue 后生效，不在忙碌轮次中换约束；仅修改 prompt 不会暗中放宽原边界。初始契约及历史结果不改写，每轮保存当时有效的契约与更新依据，后续普通续跑沿用当前契约；原 taskId、sessionId、成果和模型配置不变。CLI 回答不能自行授权变更。

### 忙碌时保存下一轮要求

新要求不必为抢占当前轮而停止 CLI。原负责人用 `cli.queue` 保存下一轮的明确阶段和指令；保存立即返回，不等待当前轮，不修改正在执行的输入、完整目标、会话或模型：

```json
{"schemaVersion":1,"requestId":"next-stage-2","action":"cli.queue","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<原负责人>","expectedRunNumber":1,"expectedSessionId":"<已绑定的原会话>","stage":{"goal":"<下一阶段结果>","acceptance":"<阶段完成证据>"},"prompt":"<已明确的新要求及仍适用的约束>"}}
```

每个任务只有一个待接续项。再次调整时，负责人合并仍有效的要求，用新 requestId 和 `replacesRequestId` 指向旧项，保留旧项历史，不默默覆盖或丢失要求。若确需调整完整契约，可同时保存上述完整 contract 与既有授权入口；它只在下一轮生效，不额外索取批准。状态中的 `continuations` 可查待续、替换、取消与已消费记录。

本轮结束仍使用原通知。负责人读取结果后，若选择 `cli.review decision=continue`，入口自动取已保存的下一轮指令，在原会话、原配置下接续；不需要老板再发一次，也不需负责人另发 resume。若同轮 continue 判断已经保存，随后保存下一轮要求时复用该判断接续，两次操作交错也不漏派。审查发现新事实使待续要求不再合适，先替换或撤销再继续，不能机械执行旧计划。没有待续项则保持原 review→resume 用法。pause 保留但不执行待续项；accept/close 或明确 stop 取消未消费项，不会停后自启。撤销入口为 `cli.cancel-next`，input 带原身份、`continuationId`（待续 requestId）及 reason。

重复保存或重复审查只关联同一待续项和下一轮，不新开会话；启动未确认时保留原请求与证据，沿既有恢复路径核对，不能换请求号重开。原生界面手输或普通 resume 不能越过未处理的待续项；需先接续、替换或撤销。负责人移交前也先处理待续项，不把前任未消费指令隐式交给接手人。这一补充不改变原通知时机，不保证桌面平台丢失唤醒后仍能自行启动分析。

只能续跑已保存的那个会话；不能使用`--last`、新会话或同时启动第二个进程绕过现场。原生窗口仍开着时，resume把新要求交回同一辅助进程和会话；窗口已正常退出时，从保存的sessionId重新连接，不丢上下文。若后台未接管、会话缺失或退出事实不明，先核对影响，不能自动重开。需要换档时，先核验本轮、保存 continue，再 detach 空闲窗口，确认退出后在 resume 中传 configuration，继续原 sessionId；不改共享配置、不在活跃轮偷偷换模型。能力不足可以升档，工作已转为明确重复操作可以降档；权限、认证或输入缺失不能靠换模型掩盖。不支持的强度明确报错，不悄悄忽略或换算成另一档。

用户可在当前轮结束后于原生窗口输入补充或纠偏；忙碌时的新要求走上述`cli.queue`。手输接续自动保存的continue记录仅表示用户在原窗口要求续跑，来源为`cli-ui`及原生事件，不表示PM已核验。真实新turn记入同一任务的新运行轮次并通知原负责人；这不自动满足原验收、改写目标或代替PM验收。负责人已经accept/pause/close的目标不接收自动续做。窗口丢失但辅助进程仍在时，用`cli.open`（同一身份input）重新打开同一会话；`cli.detach`关闭视图连接，当前轮若正在执行则等它实际结束再退出。停止业务执行仍使用下一节的`cli.stop`，不是detach。

## 业务收口与停止

原Worker路径：CLI结果满足原任务后，Worker核验正式目标、权限及主证据，再按原Worker完成/暂停协议回PM。CLI中间轮不提前收口该任务。

直接CLI正式任务：只有CLI本轮已结束、当前结果稳定且调用者保存`decision=accept`的真实验收后，才用原runtime的`workbench.accept-cli`：

```json
{"schemaVersion":1,"requestId":"accept-cli-goal-2","action":"workbench.accept-cli","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<登记负责人>","operationId":"accept-cli-goal-2","expectedStatus":"进行中","runNumber":2,"resultSha256":"<当前result.json的SHA256>","affectsMainline":true,"pendingDependencies":[]}}
```

runtime从受管结果及核验读取正式证据和验收结论；一次事务完成验收、活动区回收、历史及视图，重放同一请求不重复归档。不能用原`workbench.accept`伪装Worker、用陈旧轮次验收或以CLI文本自行授权发布。真正的外部资源/取舍阻断才由负责人用`workbench.pause`并带`projectId / taskId / ownerThreadId`保留原因与恢复条件；普通失败继续原会话。

老板明确停止运行对象时，先读当前状态，用`cli.stop`带`projectId / taskId / ownerThreadId / stateSha256 / expectedSessionId / reason`，指纹为`task.json`解析对象经`JSON.stringify`后的SHA256。后台只停止本轮保存并核验启动时间的CLI进程；不能按名称全机杀进程。首次会话尚未绑定时提交的停止请求仍只作用于那一轮。停止请求不等于已经停止，状态不明不能启动第二个实例；CLI启动的外部服务或远端动作仍按业务自己的停止路径核对。后台失去控制时，`cli.recover`使用同样身份与指纹，分别核对管理进程、实际CLI及锁的保存PID与启动时间；PID被复用不操作新进程。确认原进程均已退出后，只修复已有稳定结果的状态索引，或保存unknown。实际CLI仍存活或启动后进程证明缺失时拒绝恢复，不把后台退出等同CLI退出，也不自动重启。

老板明确关闭整个CLI任务时，仍用原`workbench.close`；input带`projectId / taskId / ownerThreadId / operationId / expectedStatus / businessState=已关闭 / ownerDirective=explicit-owner-instruction / closedBy / closedAt / closureReason / taskLocator / authorizationLocator / stateSha256`。必须有稳定退出状态，无未结束的CLI进程；未启动的登记用`stateSha256=not-started`。关闭不是完成，不删业务现场、不生成或消费Worker pending。用户换目标不自动改写旧任务或让旧结果验收新目标。

## 负责人移交

用户明确要求把 CLI 任务交给另一位负责人时，用同一入口的 `cli.transfer`；不另建任务、不重开会话、不改变默认 Worker 唯一执行者规则。仅移交已结束且稳定保存结果、尚未验收或关闭的任务；正在执行的轮次、未知退出状态和绑定正式 Worker 的辅助 CLI 不强行接管。空闲原生窗口由入口正常 detach，确认保存的进程均已退出后再变更负责人。

正式 CLI 沿用下面的工作台移交请求（不填 `taskMode` 时仍按正式任务处理）：

```json
{"schemaVersion":1,"requestId":"handoff-cli-goals","action":"cli.transfer","input":{"projectId":"<项目>","fromOwnerThreadId":"<原负责人>","toOwnerThreadId":"<新负责人>","authorizationLocator":"<老板明确移交指令入口>","expectedWorkbenchStateRevision":1,"tasks":[{"taskId":"<任务>","expectedStatus":"进行中","expectedStateSha256":"<task.json解析对象的SHA256>","expectedRunNumber":1,"expectedSessionId":"<保存的会话>","expectedResultSha256":"<result.json文件SHA256>"}]}}
```

由原负责人或接手人调用，先核对真实项目、任务与原负责人；不根据项目名称猜归属。每个任务保存移交前像与过程记录，工作台统一更新负责人，状态仍是原来的进行中或已暂停。中断时重放同一请求继续；移交尚未完成的任务不续跑或收口，不影响无关任务推进。

未登记在工作台的独立辅助 CLI，只有老板明确授权移交后，才使用 `input.taskMode="assist"`，一次指定一个任务；不提供工作台 revision 或任务 status，不新建、伪造正式任务记录。已绑定正式 Worker 或已归档的任务不走这条路径。仍从已核实的项目主根目录调用，工作目录在另一个仓库/工作树时核对任务保存的 `projectRoute`，不能把负责人移交变成项目搬迁。

```json
{"schemaVersion":1,"requestId":"handoff-one-assist","action":"cli.transfer","input":{"taskMode":"assist","projectId":"<项目>","fromOwnerThreadId":"<原负责人>","toOwnerThreadId":"<新负责人>","authorizationLocator":"<老板明确移交指令入口>","tasks":[{"taskId":"<原辅助任务>","expectedStateSha256":"<task.json解析对象的SHA256>","expectedRunNumber":14,"expectedSessionId":"<原会话>","expectedResultSha256":"<result.json文件SHA256>"}]}}
```

辅助移交保持 `assist`、原 taskId、sessionId、模型配置、执行目录、任务契约和历史记录；只变更控制归属并保存移交证据。旧负责人不能再用普通控制入口操作该任务，新负责人须独立审查原结果后才能续跑同一会话。重复提交已完成的同一请求只返回原移交回执，不夺回后续归属；中断请求必须沿用原 requestId、双方身份和指纹，不能换新请求抢占。工作台与其他任务不受辅助移交影响。

移交请求从项目主根目录发起；接手后的 `cli.result / cli.review / cli.resume` 要在保存的原 `executionRoot` 执行，不迁移工作目录。同一请求并发可能一次成功、另一次安全拒绝，随后原样重放即可核对结果。进程硬退出若留下任务锁，仍保持封锁，须先核实持锁进程已经退出并恢复原锁，再重放移交；不能把“防止双控”当成“任意故障都会自动恢复”。

历史运行、回答、复核和通知不改写。新负责人先读原目标、项目事实与已有结果，独立复核缺口，再在同一 sessionId 续做或按已有业务标准验收；不继承前任的验收结论。新轮通知新负责人，旧结果不重复通知。移交不是完成、验收或新的业务授权。

项目自己的验收条件写在已有项目文档、任务 contract 和业务测试中，通过 factEntries 引用。通用 runtime 只核对身份、稳定结果、负责人复核与事务一致性，不硬编码某个项目、站点、日期窗口或业务字段。升级保留历史自定义字段和证据，但不把旧字段继续作为通用流程门槛；取消或关闭任务也不等于业务修复成功。

## 支持边界

Codex交互模式通过官方app-server连接原生TUI，连接仅绑定127.0.0.1，使用每次辅助进程生成的本地认证token；token不放命令行、结果或发布包。远程WebSocket接口仍是官方实验特性，本产品只将它作为经过版本能力检查的本机可选分支，不宣称上游保证生产可用。协议依据：[OpenAI官方app-server说明](https://learn.chatgpt.com/docs/app-server)。

当前实现面向本机Windows/Linux原生CLI与可核验的Codex Desktop本机记录、官方消息工具入口；没有这些条件时明确报告不可用。远程跨主机、长期调度、常驻MCP服务、桌面终端输入控制和自动业务授权不在本机制内。模拟消息接口通过，只能证明程序时序，不能冒充真实Desktop自动唤醒、实际负责人分析或生产完成。

## 可选 ZCode 原生助手（试验适配）

需要可见 ZCode 会话协助开发、审查时，仍用上面的同一入口和 start / review / resume / result 协议，只换显式配置；默认 Codex 路径不变。当前适配 Windows、Node.js 24、社区 `zcode-app-cli`，不设置精确版本号或整文件哈希白名单。用户先拥有可用的独立 ZCode 启动器及第三方认证；BEYOND 不安装 ZCode、不拷贝密钥、不修改其默认模型或其他会话。

```json
{"schemaVersion":1,"provider":"zcode","runner":{"command":"<node.exe绝对路径>","args":["<已配置认证的ZCode启动器绝对路径>"]},"packageRoot":"<zcode-app-cli安装目录>","model":"<providerId/modelId>","mode":"interactive","ui":"window"}
```

- 启动器需透传参数与环境、连接当前终端，并在自己的原生 CLI 实际退出后退出。执行目录使用任务的 executionRoot；原生权限模式为 yolo，执行范围仍受原任务授权约束。
- 显示真正的 ZCode 终端，输入、工具过程和最终回答由原生界面呈现；不是把结果日志伪装成聊天。会话内可手动补充，同样计入本目标的新一轮；不允许受管会话悄悄改目标、跳转另一会话或更换模型。模型通过原生“仅本会话”接口选择，保存的默认配置不变。
- 指定 effort 时先从当前模型的原生选项核对，再通过仅本会话的 `/effort` 应用并回读；不照搬其他 CLI 的档位名称。选项不支持或回读不一致时，在派发业务提示前失败。
- 每轮等原生 submit 实际返回、结果稳定落盘，再复用既有通知原调用者的流程；调用者不陪跑。ZCode 自己不发桌面消息、不生成 Worker pending，也不自行认定目标完成。同一 sessionId 支持“审查 → 修复 → 复核”连续协作。
- 与 Codex 的可分离视图不同，这版 ZCode 窗口就是实际运行进程。cli.open 只报告已经打开的原窗口，不重复开进程；正常关闭后需明确 resume 保存的 sessionId。窗口意外退出记为 unknown，先核对结果再决定续做。cli.detach 在当前轮结束后关闭该窗口；cli.stop 请求中断当前轮。
- **兼容检查**：启动前检查原生依赖、唯一接入位置和生成副本的语法；接入后、派发前检查实际对象的提交、结束、模型选择、会话识别及忙碌/结果接口。版本号、无关注释或其他代码变化不单独构成拒绝原因；缺失或歧义接口则明确报告缺哪项能力，不自动新建会话或跳过检查。上游私有 TUI 不是稳定宿主 API，因此这不承诺任意未来版本均兼容。适配仍只生成任务内副本，不改原安装、不自动升级、不退回日志模式。依据：[上游项目](https://github.com/kingsword09/zcode-cli)、[宿主集成边界](https://github.com/kingsword09/zcode-cli/blob/main/docs/HOST_INTEGRATION.md)。

自动回归使用 `scripts/check-cli-zcode.mjs` 与 `scripts/check-zcode-capabilities.mjs`，不调用付费模型；人工明确要求真实验证时，使用开发仓的 `scripts/probe-zcode-native.mjs --profile <配置> --allow-live-model`。该探针只创建临时计算器项目，验证原生可见会话三轮协作和独立测试；它不向真实桌面 PM 发消息，因此不能当成真实 PM 自动唤醒的通过证据。

## 可选 Claude Code 原生助手（试验适配）

Claude Code 使用同一 CLI 入口、结果核验和原会话续跑流程，不增加第二套任务状态或改变默认 Worker 回传。当前适配 Windows 原生 `claude.exe`，不设置精确版本白名单或版本范围；已有认证继续由 Claude 自己读取，不复制密钥、不修改其全局设置。配置示例：

```json
{"schemaVersion":1,"provider":"claude","runner":{"command":"<claude.exe绝对路径>","args":[]},"model":"<Claude端当前可用的模型>","permissionMode":"bypassPermissions","mode":"interactive","ui":"window"}
```

- 运行真实交互终端，不使用 `-p` 日志模式；固定绑定执行目录、模型和会话。窗口关闭后通过保存的 sessionId 恢复，不用 `--continue` 猜最近对话。手动追问纳入同一任务的新一轮，忙碌时拒绝并行插单。
- 完成信号来自 Claude 的 `Stop` / `StopFailure`，读取完整回答，不扫描屏幕或轮询聊天日志。还有后台工作或计划任务时不把 Stop 当成本轮稳定结果；其中本轮 Stop 已登记的后台命令，其完整终态通知可继续交给原会话处理，不算新插单、不产生新轮次，也不立即报告完成，仍等后续无后台工作的 Stop。未知、重复或带额外指令的通知不放行；旧版原生 hooks 缺少来源字段时，此处只能关联待办 ID 和报文，不能认证一份完全相同的人工复制报文。API 失败、空回答及意外退出不会伪装完成。原生回答结束仍不等于业务验收，负责人必须核验实际产物。
- 仅通过本次启动的 `--settings` 加载任务私有 hooks，不安装或覆盖用户、项目的全局 hooks。收到结果后沿用既有的前台保护和负责人通知；Claude 不自行向 PM 发消息、不生成 Worker pending。
- 异常旁路只观察本轮已接受指令后、原生 hook 指定的同一会话记录增量。连续三次同工具出现明确的 `automode-unavailable` 权限分类失败时，保存定点证据并在原负责人前台结束后发送本轮一次 `CLI_ATTENTION_REQUIRED`。明确的 `AskUserQuestion` 和 `automode-blocked` 权限拒绝另按具体问题去重提醒，同轮后续新问题不被前一次提醒吞掉；问题已有回答、拒绝已转为具体问题、当前轮结束或已有停止请求时抑制对应旧提醒，原证据保留。普通耗时、其他会话不触发提醒。负责人沿证据核查原问题、技术事实和已有授权；新增业务决定或安全授权才向老板说明事实与建议，不照抄未经核实的选项，不代替用户批准。提醒不是终态，不自动停进程、改任务状态、换模型或绕过权限；最终结果仍走原通知。观察器失效只记诊断，不终止 CLI；缺少相应原生记录时不宣称能识别所有卡住情况。
- `permissionMode` 必须显式选择，不继承桌面权限。上述免确认示例只用于用户已授权完全访问的 CLI；auto 仍会进行逐次判定，dontAsk 会拒绝需要批准的动作，二者不能等同完全访问。启动和恢复沿用同一明确权限；首次目录信任、系统 ACL、管理员或组织限制不能靠参数保证消失，失败需保留并通知负责人，不假装任务仍正常执行，也不伪造批准。
- 本版本通过 `--effort` 传入 low / medium / high / xhigh / max，并只为该子进程设置对应环境值，避免继承值覆盖本轮选择；不修改 Claude 全局设置。底层模型或服务端仍可能不支持、限制或忽略强度，不能仅凭参数存在宣称推理预算已经生效。依据：[Claude 原生参数](https://code.claude.com/docs/en/cli-reference)。
- `cli.open` 只报告已存在的原窗口；`cli.detach` 等当前回答结束后关闭，`cli.stop` 停止有进程证明的本次 Claude 进程并等实际退出后记录 stopped。CLI 在外部另起的业务服务不在该停止动作内。
- **支持限制**：生命周期 hooks 是[Claude官方能力](https://code.claude.com/docs/en/hooks)，但向可见终端注入消息使用原生消息管道，并非上游稳定公共接口。版本信息仅用于诊断，不因升级或版本号未列举而拒绝启动、续跑或恢复；可执行文件不可用、实际握手或消息传递失败时仍准确报错，不承诺未来协议变化必然兼容。不要自行加入会反复阻止 Stop、切换会话或另行调度任务的 hooks，并据此宣称该适配保证完成。启动未登记保留 unknown 证据，不自动重启另一会话。

隔离回归：`scripts/check-cli-claude.mjs`。明确授权真实模型后，可运行 `scripts/probe-visible-cli.mjs --profile <Claude配置> --allow-live-model --exercise-reopen`；需要沿用已经信任的演示目录时，增加 `--execution-parent <已信任演示目录>`，探针只在其中新建唯一测试子目录。它验证审查、修复、复核和同会话恢复，不验证真实桌面 PM 已被自动唤醒。

三个提供者的真实并发唤醒另用开发仓 `scripts/probe-cli-concurrent-wakeup.mjs`，显式传三个 profile、已信任的测试父目录及 `--allow-live-model`。dispatch 只派发，不读结果；负责人完成当前主工作并结束回合，由真实回调进入后核验、同会话换档续做，最后验收。它会调用付费模型，不能加入默认自动回归，也不能用人工 inspect 代替自动唤醒证据。
