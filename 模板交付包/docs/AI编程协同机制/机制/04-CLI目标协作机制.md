# 可选CLI目标协作

只有老板或当前任务明确选择原生CLI执行时读取。本机制是可选分支，不替换默认桌面Worker、不新增身份Skill，也不要求普通BEYOND安装具备CLI或API认证。直接调用者仍对已批准业务目标负责；CLI负责执行，不能自行验收、创建桌面任务或改写授权。

## 两条路径

- `PM → Worker ↔ CLI → Worker → PM`：原Worker持有任务和CLI会话，负责核验、纠偏、同会话续做。CLI每轮只通知该Worker；Worker最终完成或真实暂停时仍按原身份入口enqueue、回源和输出final。不能由PM接管已经归原Worker的CLI辅助。
- `PM或Worker ↔ CLI`：当前调用者直接持有CLI目标、核验并继续同会话。PM可把明确的独立CLI结果登记为正式任务；没有原Worker时不编造Worker编号。已有Worker任务的CLI使用属于辅助，不另登记正式CLI目标。

调用者派发成功后结束本轮派发，不等业务完成、不轮询或长时间陪跑。当前还有老板请求则继续答完。日志模式在实际CLI退出后通知；原生交互模式在原生回合结束事件且结果稳定落盘后，确认负责人当前前台回合已结束，再尝试一次通知原调用者（Codex使用`turn/completed`，其他可选适配见各自支持边界）。空闲窗口不代表业务已完成，也不要求CLI整个进程先退出。交互辅助进程只服务绑定的这一个任务：关闭窗口后在当前轮结束时退出；负责人accept/pause/close后退出，不安装全局Hook、常驻系统服务或第二套调度器。

## 配置与启动

使用已经单独配置第三方API的原生Codex CLI。认证留在该CLI专用`CODEX_HOME`，不能复用桌面登录目录；产品不读取密钥，不自动安装或改写认证。配置文件只引用原生命令、专用目录及实际模型：

```json
{"schemaVersion":1,"runner":{"command":"<codex原生可执行文件绝对路径>","args":[]},"codexHome":"<CLI专用绝对目录>","model":"<第三方API实际支持的模型>","mode":"interactive","effort":"medium","ui":"window"}
```

新配置选择`mode=interactive`，运行真正的Codex原生交互界面，不拿JSON日志冒充对话。Windows的`ui=window`打开独立可见终端；`ui=attach`返回命令，由用户在自己的终端连接同一会话（Linux使用此方式）。这是外部原生终端，不声称已经能往Desktop右侧终端输入。已有未指定mode的配置继续沿用exec日志模式，不改变旧任务。交互模式需要Node.js 24及支持认证app-server的Codex可执行文件，最新实测0.162.0-alpha.2，仍逐次核对原生能力；不支持时说明真实原因，不静默换回日志。

不得在该文件放密钥、认证参数或隐式`--last`。第三方认证仍由CLI自己的专用目录读取。已获完全访问授权的 Codex 路径在交互服务、会话、每轮派单及兼容 exec 启动中均设置完全访问及`approval_policy=never`，不让用户逐命令审批；这只解决执行权限，不扩大任务授权，不自行授权生产发布。专业方法与项目资料沿用原任务授权，CLI按当前问题读一个匹配Action Skill及相关事实，不全量加载桌面历史；它不以`identity-worker`身份直接回PM。

固定入口是`node <当前controlRoot>/scripts/cli/cli-bridge.mjs --request <JSON请求文件>`，工作目录必须是本任务真实`executionRoot`。启动、续跑入口从当前桌面进程和本轮记录核对真实调用者、回合与消息工具；不能从聊天猜线程或从其他项目寻找入口。消息能力不可用就不启动或续跑CLI、不声称它会自动回来。本地状态、结果、核验、停止与恢复仍可由继承身份匹配的原负责人调用，不依赖已经失效的消息通道。原路径照常可用。

直接CLI正式任务先通过原固定runtime执行`workbench.register`：

```json
{"schemaVersion":1,"requestId":"register-cli-goal","action":"workbench.register","input":{"projectId":"<已登记项目>","taskId":"<任务>","task":"<独立业务结果>","execution":{"kind":"cli","ownerThreadId":"<当前真实调用者>","stateLocator":"<controlRoot>/local/runtime/cli-tasks/<projectId>/<taskId>/task.json"},"status":"进行中","progress":"准备CLI执行","pause":"无","updatedAt":"<ISO时间>"}}
```

不传`worker`。状态入口由项目和任务唯一派生；允许先登记、再启动，不要求提前创建空CLI会话。原Worker辅助CLI跳过此登记。

启动请求：

```json
{"schemaVersion":1,"requestId":"cli-goal-run-1","action":"cli.start","input":{"projectId":"<项目>","taskId":"<任务>","taskMode":"formal","executionRoot":"<本次正式执行根>","profilePath":"<专用配置绝对路径>","contract":{"goal":"<完整业务目标>","boundaries":"<授权与不做事项>","acceptance":"<可判定验收>","factEntries":["<相关事实入口>"],"skillEntries":["<匹配Action Skill入口>"]},"prompt":"<当前获准执行内容>"}}
```

`taskMode=assist`用于原Worker辅助或未登记的局部协助。跨根任务在input原样增加经核验的`projectRoute`；不得跨项目回退。同一请求编号只能重放同一参数；响应`running`表示后台已接管，不是CLI完成。结果缺失、启动不明或受管状态冲突时先定点核对，不重复启动。

start 和 resume 的 input 均可带 `"configuration":{"model":"<实际支持的模型>","effort":"<该模型支持的强度>"}`。调用者按当前任务、已有模型矩阵和第三方实际能力选择，不继承桌面模型。每轮保存本次配置，续做未指定的字段沿用该任务上一轮，不因其他任务换档或共享默认值变化而跟着改变；`effort:null`明确回到该 CLI 的原生默认。此对象只接受 model、effort，不接受密钥、权限或任意启动参数。结果中的 configuration 是派发配置，不冒充第三方服务确实采用了同名底层模型或推理预算的证明。模型目录可见不等于当前密钥有调用权；服务端拒绝时保留失败，负责人可在原授权目标内选择已可用模型续做，但不替换认证或反复调用被拒模型。

## 通知、核验与同会话循环

`CLI_RESULT_READY`携带项目、任务、轮次、状态、受管结果入口和指纹。它不同于Worker终态：不执行`worker-result.enqueue`，不创建Worker pending，不执行ack，不自动判定业务完成或暂停。消息送达与负责人已核验是两件事；发送超时只能记为未知，不能盲重发。通知不可用时结果保留，不能冒充自动处理成功。

同一桌面负责人来自不同CLI后台进程的通知串行发送，不限制CLI业务执行并发。发送前重新核对该负责人最新回合是否结束，而不只等待原派发回合；等待期间已经核验或被新轮替代的结果不再补发。接口返回成功后，还须观察到负责人新回合记录，才放行下一条通知；接口调用与回合记录确认分别默认最多观察60秒。发送失败、超时或记录未前进时保留未知交接凭据，不能仅因发送进程退出就再发；后续发送先确认原负责人记录已前进，再按最新回合是否结束继续，不自动重发未知消息。这不修补桌面程序自身的会话缓存，也不保证平台一定创建可执行回合。

收到通知，先核对登记负责人、项目、任务、当前轮和结果指纹，再定点读取结果及当前主证据。过期、重复、已关闭或不归本人的结果不启动新的执行。当前老板问题完整保留；处理结果后继续当前请求，尾部简述实际处理内容，不用后台通知替换前台目标。桌面平台若未形成可执行回合，本机制不能保证自动分析已发生；自然进入的后续回合仅补查本人已登记CLI结果，不轮询。

使用同一入口执行`cli.status`或`cli.result`，input为`projectId / taskId / ownerThreadId`，读取结果再加`runNumber`。`task.json`绑定真实`sessionId`，每轮`runs/<N>/`保存输入、工作事件、标准错误、结果、通知和核验；运行状态不是新的业务状态。工作事件可查看CLI正在做什么，但不是内部推理，也不声称桌面右侧终端已经获得输入能力。

只有调用者依据当前产物和验收作出判断后才能保存核验：

```json
{"schemaVersion":1,"requestId":"review-goal-1","action":"cli.review","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<调用者>","runNumber":1,"resultSha256":"<本轮result.json的SHA256>","decision":"continue","evidenceLocator":"<当前主证据>","conclusion":"<实际缺口或验收结论>","reviewedAt":"<ISO时间>"}}
```

`decision`仅为`continue / accept / pause / close`。这是负责人的核验记录，不自行改变工作台。每轮原始核验不可改写；普通失败或部分完成选择continue，不把进程exitCode=0当成业务完成。真实暂停后恢复时，在同一轮补交`decision=continue`的核验，附原`review.json`的`supersedesReviewSha256`与当前授权的`authorizationLocator`；另存续做依据，原暂停记录保留。工作台原暂停任务仍由负责人按既有恢复路径处理。要继续原目标时：

```json
{"schemaVersion":1,"requestId":"cli-goal-run-2","action":"cli.resume","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<调用者>","expectedRunNumber":1,"expectedSessionId":"<保存的真实会话>","prompt":"<依据缺口的纠偏与剩余验收>"}}
```

只能续跑已保存的那个会话；不能使用`--last`、新会话或同时启动第二个进程绕过现场。原生窗口仍开着时，resume把新要求交回同一辅助进程和会话；窗口已正常退出时，从保存的sessionId重新连接，不丢上下文。若后台未接管、会话缺失或退出事实不明，先核对影响，不能自动重开。需要换档时，先核验本轮、保存 continue，再 detach 空闲窗口，确认退出后在 resume 中传 configuration，继续原 sessionId；不改共享配置、不在活跃轮偷偷换模型。能力不足可以升档，工作已转为明确重复操作可以降档；权限、认证或输入缺失不能靠换模型掩盖。不支持的强度明确报错，不悄悄忽略或换算成另一档。

用户可在原生窗口输入补充或纠偏。真实新turn记入同一任务的新运行轮次并通知原负责人；这不自动满足原验收、改写目标或代替PM验收。负责人已经accept/pause/close的目标不接收自动续做。窗口丢失但辅助进程仍在时，用`cli.open`（同一身份input）重新打开同一会话；`cli.detach`关闭视图连接，当前轮若正在执行则等它实际结束再退出。停止业务执行仍使用下一节的`cli.stop`，不是detach。

## 业务收口与停止

原Worker路径：CLI结果满足原任务后，Worker核验正式目标、权限及主证据，再按原Worker完成/暂停协议回PM。CLI中间轮不提前收口该任务。

直接CLI正式任务：只有CLI本轮已结束、当前结果稳定且调用者保存`decision=accept`的真实验收后，才用原runtime的`workbench.accept-cli`：

```json
{"schemaVersion":1,"requestId":"accept-cli-goal-2","action":"workbench.accept-cli","input":{"projectId":"<项目>","taskId":"<任务>","ownerThreadId":"<登记负责人>","operationId":"accept-cli-goal-2","expectedStatus":"进行中","runNumber":2,"resultSha256":"<当前result.json的SHA256>","affectsMainline":true,"pendingDependencies":[]}}
```

runtime从受管结果及核验读取正式证据和验收结论；一次事务完成验收、活动区回收、历史及视图，重放同一请求不重复归档。不能用原`workbench.accept`伪装Worker、用陈旧轮次验收或以CLI文本自行授权发布。真正的外部资源/取舍阻断才由负责人用`workbench.pause`并带`projectId / taskId / ownerThreadId`保留原因与恢复条件；普通失败继续原会话。

老板明确停止运行对象时，先读当前状态，用`cli.stop`带`projectId / taskId / ownerThreadId / stateSha256 / expectedSessionId / reason`，指纹为`task.json`解析对象经`JSON.stringify`后的SHA256。后台只停止本轮保存并核验启动时间的CLI进程；不能按名称全机杀进程。首次会话尚未绑定时提交的停止请求仍只作用于那一轮。停止请求不等于已经停止，状态不明不能启动第二个实例；CLI启动的外部服务或远端动作仍按业务自己的停止路径核对。后台失去控制时，`cli.recover`使用同样身份与指纹，分别核对管理进程、实际CLI及锁的保存PID与启动时间；PID被复用不操作新进程。确认原进程均已退出后，只修复已有稳定结果的状态索引，或保存unknown。实际CLI仍存活或启动后进程证明缺失时拒绝恢复，不把后台退出等同CLI退出，也不自动重启。

老板明确关闭整个CLI任务时，仍用原`workbench.close`；input带`projectId / taskId / ownerThreadId / operationId / expectedStatus / businessState=已关闭 / ownerDirective=explicit-owner-instruction / closedBy / closedAt / closureReason / taskLocator / authorizationLocator / stateSha256`。必须有稳定退出状态，无未结束的CLI进程；未启动的登记用`stateSha256=not-started`。关闭不是完成，不删业务现场、不生成或消费Worker pending。用户换目标不自动改写旧任务或让旧结果验收新目标。

## 支持边界

Codex交互模式通过官方app-server连接原生TUI，连接仅绑定127.0.0.1，使用每次辅助进程生成的本地认证token；token不放命令行、结果或发布包。远程WebSocket接口仍是官方实验特性，本产品只将它作为经过版本能力检查的本机可选分支，不宣称上游保证生产可用。协议依据：[OpenAI官方app-server说明](https://learn.chatgpt.com/docs/app-server)。

当前实现面向本机Windows/Linux原生CLI与可核验的Codex Desktop本机记录、官方消息工具入口；没有这些条件时明确报告不可用。远程跨主机、长期调度、常驻MCP服务、桌面终端输入控制和自动业务授权不在本机制内。模拟消息接口通过，只能证明程序时序，不能冒充真实Desktop自动唤醒、实际负责人分析或生产完成。

## 可选 ZCode 原生助手（试验适配）

需要可见 ZCode 会话协助开发、审查时，仍用上面的同一入口和 start / review / resume / result 协议，只换显式配置；默认 Codex 路径不变。当前支持 Windows、Node.js 24、社区 `zcode-app-cli 3.14.4-32` 的指定 TUI 内容。用户先拥有可用的独立 ZCode 启动器及第三方认证；BEYOND 不安装 ZCode、不拷贝密钥、不修改其默认模型或其他会话。

```json
{"schemaVersion":1,"provider":"zcode","runner":{"command":"<node.exe绝对路径>","args":["<已配置认证的ZCode启动器绝对路径>"]},"packageRoot":"<zcode-app-cli安装目录>","model":"<providerId/modelId>","mode":"interactive","ui":"window"}
```

- 启动器需透传参数与环境、连接当前终端，并在自己的原生 CLI 实际退出后退出。执行目录使用任务的 executionRoot；原生权限模式为 yolo，执行范围仍受原任务授权约束。
- 显示真正的 ZCode 终端，输入、工具过程和最终回答由原生界面呈现；不是把结果日志伪装成聊天。会话内可手动补充，同样计入本目标的新一轮；不允许受管会话悄悄改目标、跳转另一会话或更换模型。模型通过原生“仅本会话”接口选择，保存的默认配置不变。
- 指定 effort 时先从当前模型的原生选项核对，再通过仅本会话的 `/effort` 应用并回读；不照搬其他 CLI 的档位名称。选项不支持或回读不一致时，在派发业务提示前失败。
- 每轮等原生 submit 实际返回、结果稳定落盘，再复用既有通知原调用者的流程；调用者不陪跑。ZCode 自己不发桌面消息、不生成 Worker pending，也不自行认定目标完成。同一 sessionId 支持“审查 → 修复 → 复核”连续协作。
- 与 Codex 的可分离视图不同，这版 ZCode 窗口就是实际运行进程。cli.open 只报告已经打开的原窗口，不重复开进程；正常关闭后需明确 resume 保存的 sessionId。窗口意外退出记为 unknown，先核对结果再决定续做。cli.detach 在当前轮结束后关闭该窗口；cli.stop 请求中断当前轮。
- **支持限制**：上游没有把私有 TUI 实现承诺为稳定宿主接口。本适配只在任务目录生成局部副本，不改原安装；版本或内容不匹配就报告需重新验证，不自动升级、不静默退回日志模式。它不是通用的任意版本 ZCode 支持。依据：[上游项目](https://github.com/kingsword09/zcode-cli)、[宿主集成边界](https://github.com/kingsword09/zcode-cli/blob/main/docs/HOST_INTEGRATION.md)。

自动回归使用 `scripts/check-cli-zcode.mjs`，不调用付费模型；人工明确要求真实验证时，使用开发仓的 `scripts/probe-zcode-native.mjs --profile <配置> --allow-live-model`。该探针只创建临时计算器项目，验证原生可见会话三轮协作和独立测试；它不向真实桌面 PM 发消息，因此不能当成真实 PM 自动唤醒的通过证据。

## 可选 Claude Code 原生助手（试验适配）

Claude Code 使用同一 CLI 入口、结果核验和原会话续跑流程，不增加第二套任务状态或改变默认 Worker 回传。当前适配 Windows 原生 `claude.exe 2.1.294`；已有认证继续由 Claude 自己读取，不复制密钥、不修改其全局设置。配置示例：

```json
{"schemaVersion":1,"provider":"claude","runner":{"command":"<claude.exe绝对路径>","args":[]},"model":"<Claude端当前可用的模型>","permissionMode":"bypassPermissions","mode":"interactive","ui":"window"}
```

- 运行真实交互终端，不使用 `-p` 日志模式；固定绑定执行目录、模型和会话。窗口关闭后通过保存的 sessionId 恢复，不用 `--continue` 猜最近对话。手动追问纳入同一任务的新一轮，忙碌时拒绝并行插单。
- 完成信号来自 Claude 的 `Stop` / `StopFailure`，读取完整回答，不扫描屏幕或轮询聊天日志。还有后台工作或计划任务时不把 Stop 当成本轮稳定结果；API 失败、空回答及意外退出不会伪装完成。原生回答结束仍不等于业务验收，负责人必须核验实际产物。
- 仅通过本次启动的 `--settings` 加载任务私有 hooks，不安装或覆盖用户、项目的全局 hooks。收到结果后沿用既有的前台保护和负责人通知；Claude 不自行向 PM 发消息、不生成 Worker pending。
- `permissionMode` 必须显式选择，不继承桌面权限。上述免确认示例只用于用户已授权完全访问的 CLI；auto 仍会进行逐次判定，dontAsk 会拒绝需要批准的动作，二者不能等同完全访问。启动和恢复沿用同一明确权限；首次目录信任、系统 ACL、管理员或组织限制不能靠参数保证消失，失败需保留并通知负责人，不假装任务仍正常执行，也不伪造批准。
- 本版本通过 `--effort` 传入 low / medium / high / xhigh / max，并只为该子进程设置对应环境值，避免继承值覆盖本轮选择；不修改 Claude 全局设置。底层模型或服务端仍可能不支持、限制或忽略强度，不能仅凭参数存在宣称推理预算已经生效。依据：[Claude 原生参数](https://code.claude.com/docs/en/cli-reference)。
- `cli.open` 只报告已存在的原窗口；`cli.detach` 等当前回答结束后关闭，`cli.stop` 停止有进程证明的本次 Claude 进程并等实际退出后记录 stopped。CLI 在外部另起的业务服务不在该停止动作内。
- **支持限制**：生命周期 hooks 是[Claude官方能力](https://code.claude.com/docs/en/hooks)，但向可见终端注入消息使用本机已验证版本的消息管道，并非上游稳定公共接口。版本变化必须重新验证；不要自行加入会反复阻止 Stop、切换会话或另行调度任务的 hooks，并据此宣称该适配保证完成。启动未登记保留 unknown 证据，不自动重启另一会话。

隔离回归：`scripts/check-cli-claude.mjs`。明确授权真实模型后，可运行 `scripts/probe-visible-cli.mjs --profile <Claude配置> --allow-live-model --exercise-reopen`；需要沿用已经信任的演示目录时，增加 `--execution-parent <已信任演示目录>`，探针只在其中新建唯一测试子目录。它验证审查、修复、复核和同会话恢复，不验证真实桌面 PM 已被自动唤醒。

三个提供者的真实并发唤醒另用开发仓 `scripts/probe-cli-concurrent-wakeup.mjs`，显式传三个 profile、已信任的测试父目录及 `--allow-live-model`。dispatch 只派发，不读结果；负责人完成当前主工作并结束回合，由真实回调进入后核验、同会话换档续做，最后验收。它会调用付费模型，不能加入默认自动回归，也不能用人工 inspect 代替自动唤醒证据。
