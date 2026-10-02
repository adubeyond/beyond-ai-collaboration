# 可选CLI目标协作

只有老板或当前任务明确选择原生CLI执行时读取。本机制是可选分支，不替换默认桌面Worker、不新增身份Skill，也不要求普通BEYOND安装具备CLI或API认证。直接调用者仍对已批准业务目标负责；CLI负责执行，不能自行验收、创建桌面任务或改写授权。

## 两条路径

- `PM → Worker ↔ CLI → Worker → PM`：原Worker持有任务和CLI会话，负责核验、纠偏、同会话续做。CLI每轮只通知该Worker；Worker最终完成或真实暂停时仍按原身份入口enqueue、回源和输出final。不能由PM接管已经归原Worker的CLI辅助。
- `PM或Worker ↔ CLI`：当前调用者直接持有CLI目标、核验并继续同会话。PM可把明确的独立CLI结果登记为正式任务；没有原Worker时不编造Worker编号。已有Worker任务的CLI使用属于辅助，不另登记正式CLI目标。

调用者派发成功后结束本轮派发，不等业务完成、不轮询或长时间陪跑。当前还有老板请求则继续答完；CLI后台程序只在实际CLI退出、结果稳定落盘且本次派发的桌面对话回合结束后，尝试一次通知原调用者。它是每次派发的有限后台程序，不安装Hook、notify配置、常驻服务或第二套调度器。

## 配置与启动

使用已经单独配置第三方API的原生Codex CLI。认证留在该CLI专用`CODEX_HOME`，不能复用桌面登录目录；产品不读取密钥，不自动安装或改写认证。配置文件只引用原生命令、专用目录及实际模型：

```json
{"schemaVersion":1,"runner":{"command":"<原生可执行文件绝对路径>","args":["<必要启动脚本，可省略此元素>"]},"codexHome":"<CLI专用绝对目录>","model":"<第三方API实际支持的模型>"}
```

不得在该文件放密钥、认证参数或隐式`--last`。CLI使用自己的平台权限；第三方API能响应不等于具有命令、文件、网络或生产授权。专业方法与项目资料沿用原任务授权，CLI按当前问题读一个匹配Action Skill及相关事实，不全量加载桌面历史；它不以`identity-worker`身份直接回PM。

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

## 通知、核验与同会话循环

`CLI_RESULT_READY`携带项目、任务、轮次、状态、受管结果入口和指纹。它不同于Worker终态：不执行`worker-result.enqueue`，不创建Worker pending，不执行ack，不自动判定业务完成或暂停。消息送达与负责人已核验是两件事；发送超时只能记为未知，不能盲重发。通知不可用时结果保留，不能冒充自动处理成功。

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

只能续跑已保存的那个会话；不能使用`--last`、新会话或同时启动第二个进程绕过现场。若后台未接管、会话缺失或退出事实不明，先核对影响，不能自动重开。模型调整须按任务及第三方实际能力明确配置，不继承PM桌面模型。

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

当前实现面向本机Windows/Linux原生CLI与可核验的Codex Desktop本机记录、官方消息工具入口；没有这些条件时明确报告不可用。远程跨主机、长期调度、常驻MCP服务、桌面终端输入控制和自动业务授权不在本机制内。模拟消息接口通过，只能证明程序时序，不能冒充真实Desktop自动唤醒、实际负责人分析或生产完成。
