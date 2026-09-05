# 暂停、恢复与收口

处理登记Worker回传（含执行回合结束后的非终态进展）、待处理回执、证据退回、控制Worker冲突或线程恢复时读取。Worker仍在当前执行回合内的普通进展、普通失败和方法切换不单独触发读取。

任务状态始终只有`进行中 / 已暂停 / 已完成 / 已关闭`。`已关闭`只表示老板明确决定不再追求该任务结果，不是Worker终态，也不冒充完成。测试结果、当前动作、消息类型、PM是否已经查看和 Worker是否在线都不是新的任务状态。

新任务仍由一次原生回调唤醒PM，用户可见Worker final仍保存正式交付；固定`worker-result`只保存同一份冻结final的短期待处理快照，用来补齐平台恢复回合可能出现的空响应或控制面不可读。它不保存过程消息、不形成历史、不轮询，也不引入Hook、notify适配器、额外Codex CLI或后台进程。

所有`worker-result`固定调用都让`runtime --request`读取JSON请求文件，不把JSON正文当路径传入。文件外层固定为`{"schemaVersion":1,"action":"worker-result.enqueue|list|ack","input":{…}}`；`enqueue`的input使用`projectId / taskId / sourceThreadId / businessState / finalText`及任务包确有的`projectRoute`，`list`至少用`projectId`限定当前项目，`ack`固定带`projectId / taskId / receiptId`。字段名不使用`operation / status / final`等猜测别名；这三类动作的`requestId`可省略并由运行内核生成。

唤醒只表示PM应扫描，不证明Worker已经结束，也不能因为Worker仍显示运行就把回调判成无效。收到任一登记Worker回调后，先通过固定`runtime`入口执行一次`worker-result.list`读取当前项目全部待处理回执；再按`projectId + taskId + sourceThreadId`匹配当前PM和工作台活动任务，附带`workerThreadId`时再核对该字段。活动任务与结构化匹配回执是处理路径的主依据；终态或进展回调文字只做一致性核对，`running / idle`只参与后述可见性竞态处理，不负责判定回调类型。不能只处理回调来源，也不扫描无关Worker。

回调来源没有匹配回执时只定点读取原Worker一次。平台final以`进行中`开头就按非终态进展处理：保持活动任务为`进行中`，不执行`accept / pause / ack`，无需老板决定时最多向同一Worker发送一次继续或纠偏。平台final是新任务终态却说明`worker-result.enqueue`失败时，同样保持任务且退回原Worker补交合规终态；没有可读final时保持原状态，不等待、不猜测。没有回执的新任务不得沿用原生final绕过终态协议；没有回执的旧任务仍只按原生final兼容处理。同一次列表中的其他匹配终态照常核对，不能因唤醒来源本身没有回执而遗漏。

存在匹配活动任务的回执时，对其登记Worker先定点读取一次。平台final可读时以它为正式真值，只要求业务状态以及结果、提交、发布和生产事实不与回执冲突；措辞、格式或详略不同本身不阻止验收。第一次定点读取仍无平台final且Worker仍显示运行时，只允许调用一次最长30秒的`wait_threads`，随后只再定点读取一次；不得循环、第二次等待、继续轮询或要求Worker仅为平台可见性重发final。第二次仍无final就保持任务和回执原样，不执行`accept / pause / ack`。Worker已经结束而final仍不可读时，回执只能恢复同一份冻结正文，不能单独证明业务完成：活动任务、唯一Worker、来源身份、正式目标和独立主证据仍须闭合；只有回执而没有独立验收证据时保持任务和回执原样。回调文字、回执与平台final两者存在实质矛盾时保持未验收并退回原Worker。

跨根、多仓或既有worktree的新任务若由原Worker报告任务包缺少`projectRoute`，这是派单纠正，不是业务暂停或终态。PM保持同一活动任务为`进行中`，重新执行`project.resolve`取得当前verified route，并把完整`projectRoute`只发送给同一原Worker后结束该纠正动作，不等待其结果，继续老板当前请求及本轮其他已到达回调；不得执行`workbench.pause / workbench.accept / worker-result.ack`，不得用无回执原生final收口，也不得创建替代Worker。无法取得verified route时才把这一真实控制阻断报告老板，不让Worker先做业务动作或猜测路径。

每份回执只有`pending`一种控制状态。同一`receiptId`只处理一次；同一`projectId + taskId`的新终态会替换尚未消费的旧终态，不同项目的同名任务彼此隔离，旧`receiptId`不能删除新回执。PM用该`receiptId`派生稳定`operationId`提交`workbench.pause`或`workbench.accept`，成功后才执行一次带`projectId + taskId + receiptId`的`worker-result.ack`删除正文；若在状态提交后、删除前中断，下次以同一`operationId`取得幂等结果后再删。工作台提交或删除失败时保留回执，下次只重试未完成的固定动作。回执不是长期final入口，工作台仍指向正式Worker任务和一手证据。

`worker-result.list`出现已经退出活动区、状态看似已经提交或所有者关系异常的回执时，才通过固定runtime再执行一次只读`workbench.inspect`，不得日常重复调用；最小请求为`{"schemaVersion":1,"action":"workbench.inspect","input":{"projectId":"…"}}`，可再用`taskId`定点过滤。它只把每份pending分成三类：`review-active-task`表示仍需按本节核对正式final和主证据；`ack-committed-receipt`表示同一`receiptId`派生的工作台事务已经完成，只有工作台事务已经幂等成功时才补一次`worker-result.ack`；`preserve-conflict`表示状态、事务或所有者证据不能闭合，必须保留并报告。该动作不写工作台、不改回执、不执行验收、暂停、关闭或ack，也不能替代平台final和主证据；PM不得凭分类结果跳过正常验收。

原生回调仍是主触发。平台把一条或多条回调及其他`<codex_delegation>`注入PM正在回答老板请求的同一turn时，它们只是按到达顺序追加的并发控制输入，不构成新的老板目标或替换指令；PM在现有安全工具边界逐项执行上述收件箱检查，已注入当前turn的回调不得仅因Worker仍在运行而推迟到老板催促，但也不得丢弃、重启、截断或改写已经开始处理的请求。处理后继续原请求剩余动作；最终答复必须先给出老板该请求全部事项的完整结果或准确未完成说明，再在尾部用一段合并摘要列出本回合实际处理的每个后台任务、终态和收口结果。后一条回调不能覆盖前一条，重复回调只做幂等核对，未实际处理的回调不得写成已经收口。平台若没有为final之后到达的回调形成可执行PM回合，Skill不能伪造已经自动处理；下一个非回调触发的自然PM回合再按下述补读恢复。

非回调触发的自然PM回合开始时，只要工作台还有`进行中`或`已暂停`任务，PM就通过固定`runtime`入口补读一次当前项目pending；列表为空时立即继续老板当前目标，不读取Worker。存在回执时只核对与活动任务匹配的唯一Worker，不扫描无关Worker；若列表含已退出活动区或状态关系异常的回执，再按上段执行一次`workbench.inspect`。最终答复先回答老板当前问题，与其无关的收口只在尾部简要知会。只有分类为`ack-committed-receipt`才补一次精确`worker-result.ack`；其他已退出活动区或冲突回执保留并说明，不重新执行`workbench.accept`或`workbench.pause`。该补读只恢复已保存结果，不代替原生回调；不得高频轮询或用补读冒充唤醒主通道，不循环、不等待，也不建立Hook、notify、守护进程或第二套调度器。

## 1. 处理暂停

从Worker唤醒发现待处理暂停后，先按工作台定位唯一Worker并读取回执；平台final可读时再核对状态和关键事实，PM回合扫尾只作缺失回调时的补漏：

- 来源是否是任务台登记的唯一 Worker；
- 当前是否确实命中一种真实暂停原因；
- 已完成内容、现场、受影响动作和恢复条件是否清楚；
- 不受影响的安全动作是否还能继续。

项目事实尚未补齐、普通测试失败、工作台未同步、Skill切换、本地提交和等待 PM确认普通步骤，不构成有效暂停。原范围内仍能调查、修复或补证据时，让原 Worker继续，不向用户制造新授权点。

required CI 正在排队或运行、审查请求已经进入项目既有流程、保护分支尚在等待正常检查，本身也不构成有效暂停。PM先核对是否仍有责任实例、可读状态和下一触发；这些事实存在时任务保持`进行中`，只在流程客观失去执行或恢复入口且剩余验收全部被阻断时接受外部资源暂停。

用户只要求停止某个运行对象、危险动作或资源占用时，不据此暂停整个业务任务；开发、文档或其他不受影响的安全动作继续。用户批评 PM行为、询问“为什么还在执行”或使用了指向不清的“停一下”时，PM不得自行扩张为停止 Worker；先纠正自身行为，确需改变任务状态时再确认对象。

有效暂停用`workbench.pause`一次提交`已暂停 + 唯一原因 + 恢复条件 + 正式Worker入口`，成功后删除对应回执，原任务继续留在活动区。用户可以直接在原 Worker 对话补充决定、资源或任务内授权并继续，不必回 PM重复审批；变化影响主线、其他任务、共享对象或高风险边界时，Worker再向 PM返回最小摘要。

## 2. 处理完成

用户要求先查看设计、方案或阶段结果再继续，而最终业务结果仍包含实现、测试或交付时，这只是原任务的检查点：任务保持`进行中`，当前动作登记为等待用户确认，不按设计完成收口。用户确认后恢复原 Worker和现有现场；只有原线程客观不可恢复，或后续结果属于另一个正式项目中的独立业务结果时，才建立新的 Worker。

从Worker唤醒发现待处理完成后，先按工作台定位唯一Worker并读取回执；平台final可读时再核对状态和关键事实，然后定点核对主证据；PM回合扫尾只作缺失回调时的补漏：

- 成果是否已经进入约定项目、Git、文档或运行目标；
- 当前一手证据是否直接覆盖任务验收；
- Git、服务、数据、环境和发布现实是否与结论一致；
- 是否把代码完成、测试通过或候选制品误写成已经发布、用户可用；
- 是否存在会改变验收的未披露风险。

Worker final只承载业务结论和主证据入口，PM沿其主证据定点核验上述项目；不要求Worker把命令、测试矩阵、样本、哈希和文件目录重新复制进 final。主证据入口无法支撑验收或关键影响未说明时才退回补证，final简短本身不是证据不足。

证据闭合时用`workbench.accept`一次提交验收与收敛，成功后删除对应回执。普通完成结果需要出现在工作台“近期主线结果”时，`affectsMainline`必须为`true`；只有明确只归档历史、无需进入近期主线结果的旧结果才使用`false`，不能把它理解为“没有风险”或“尚未发布”。证据不足但可以在原范围内补齐时保持`进行中`，让原Worker补证或修复；只有需要新的业务决定、高风险授权、共享冲突处理或必要外部资源时才转`已暂停`。

`workbench.accept`沿用固定`runtime --request <JSON请求文件>`入口。正常验收请求直接使用下面的结构；`requestId`与`operationId`都从当前回执`receiptId`派生稳定编号，`worker / expectedStatus / finalLocator / evidenceLocator`来自当前活动任务、正式final和主证据，不为构造请求读取runtime源码或猜测字段：

```json
{
  "schemaVersion": 1,
  "requestId": "accept-<receiptId>",
  "action": "workbench.accept",
  "input": {
    "projectId": "<当前正式项目编号>",
    "operationId": "accept-<receiptId>",
    "taskId": "<精确任务编号>",
    "worker": "<登记Worker>",
    "expectedStatus": "进行中",
    "businessState": "已完成",
    "acceptedBy": "<当前PM编号>",
    "acceptance": "accepted",
    "acceptedAt": "<当前ISO时间>",
    "finalLocator": "<正式Worker final入口>",
    "evidenceLocator": "<主证据入口>",
    "conclusion": "<验收结论>",
    "completedAt": "<Worker完成ISO时间>",
    "affectsMainline": true,
    "pendingDependencies": []
  }
}
```

任务从`已暂停`恢复后完成时，`expectedStatus`使用工作台当前真实状态`已暂停`；其余字段不改名。固定入口返回校验错误时保持任务和回执原样，只纠正当前请求，不手工改表、不另建状态事务。

PM处理完成结果只更新任务状态和验收结论，不建立“候选完成、待采纳、验证中、已消费”等额外业务状态。

## 3. 处理老板主动关闭

只有老板明确点名任务并要求“关闭、取消、不做了”，明确说明由另一任务替代，或在重复任务中明确保留哪一个时，才能使用`workbench.close`。PM不得从Worker沉默、任务闲置、普通失败、超时、失联、缺少final或主线变化推断关闭，也不得把应当暂停、返工、验收或恢复的任务改写为关闭。

关闭前必须核对精确`taskId`、登记Worker已经不在运行、当前项目中该任务没有pending回执，并保存老板明确指令的可追溯入口和一条关闭原因。存在pending时先按原终态协议处理，不能ack后强行关闭；Worker仍运行时先停止或等待已授权动作安全结束，不能只改工作台制造双写现场。满足条件后用一次`workbench.close`把任务移出活动区并写入月度历史，状态固定为`已关闭`。关闭不调用`workbench.accept`，不生成或消费Worker回执，也不进入近期主线结果。

`workbench.close`沿用固定`runtime --request <JSON请求文件>`入口。老板本轮明确要求关闭就是`ownerDirective`的来源；请求必须原样包含`"ownerDirective": "explicit-owner-instruction"`，不得省略、改写，也不能用`authorizationLocator`代替。构造请求时把三个字段严格分开：`ownerDirective`只能写固定哨兵`explicit-owner-instruction`，老板的关闭原因写入`closureReason`，老板本次明确指令的入口写入`authorizationLocator`，三者不得互换。普通任务的`requestId`与`operationId`都固定为`close-<taskId>`；编号只能使用ASCII字母、数字、点、下划线和短横线，首字符必须是字母或数字，总长不超过200，不能把冒号、时间戳时区或授权入口拼进编号。极长`taskId`导致超长时，改用`close-`加`taskId + authorizationLocator`的SHA-256十六进制摘要。`expectedStatus`必须等于工作台当前状态，`worker / taskLocator`来自该任务现有登记，`closedBy`使用当前PM的可追溯编号，`closedAt`使用当前有效ISO时间：

```json
{
  "schemaVersion": 1,
  "requestId": "close-<taskId>",
  "action": "workbench.close",
  "input": {
    "projectId": "<当前正式项目编号>",
    "operationId": "close-<taskId>",
    "taskId": "<精确任务编号>",
    "worker": "<登记Worker>",
    "expectedStatus": "<进行中或已暂停>",
    "businessState": "已关闭",
    "ownerDirective": "explicit-owner-instruction",
    "workerStopped": true,
    "closedBy": "<当前PM编号>",
    "closureReason": "<老板明确关闭原因>",
    "taskLocator": "<现有正式任务入口>",
    "authorizationLocator": "<老板本次明确指令入口>",
    "closedAt": "<当前ISO时间>"
  }
}
```

字段已经由本契约固定时，PM不得为构造关闭请求读取`control-runtime.mjs`、`workbench-transaction.mjs`或其他runtime实现源码；固定入口返回校验错误时按错误保持任务原状态并报告，不猜测别名或改走手工写入。

`workbench.close`只关闭BEYOND控制面任务记录。它不删除或恢复业务文件、代码、分支、提交、stash、服务、数据、任务线程或其他外部对象；这些对象需要各自明确授权和正式入口。关闭失败时保持原任务状态，不手工修改工作台或历史。

## 4. 重复、冲突与线程恢复

同一`receiptId`或Worker final入口已经写入工作台时只处理一次，不重复改变状态、回复消费消息或启动任务。两个来源声称控制同一任务时，只停止可能重叠的写入，由 PM根据平台真实任务、工作目录和当前现场确认唯一 Worker；其他安全工作继续。

`失联`不是业务状态。本轮已经结束本身不构成失联；有效`进行中`final按前述进展路径处理，不因缺少暂停或完成final改为暂停。只有平台一手证据另行确认线程确实无法继续或不可访问、已阻断剩余任务，并且没有有效暂停或完成final时，才用`workbench.pause`一次把业务任务记为`已暂停`，原因写“执行线程未形成正式结果”，恢复优先使用原Worker。沉默、超过预计时间或一次读取/消息失败都不能证明失联，PM也不持续轮询。

恢复优先使用原正式任务线程和现有 Git/运行现场，不重新接手、不重建任务包、不从头调查。PM向原Worker发送恢复输入时，只传当前发送工具声明的必填字段；当前标准调用只使用`threadId + prompt`，不得附加可选`hostId`、模型或推理参数。发送成功后结束该恢复动作，不读取或等待刚恢复的Worker；继续老板当前请求及本轮其他已到达回调，没有剩余事项才结束PM回合。新终态由回执与原生回调返回。原线程客观不可恢复时，才建立替代 Worker，并明确正式工作目录、最新 Git和运行事实、已完成内容、剩余验收以及旧实例不会继续写入的依据。

## 5. 对用户收口

按根入口的用户沟通边界收口，说明当前真实结果、是否已经交付或发布、未覆盖范围和必要下一步。PM不把内部状态码、消息协议和长证据清单直接倾倒给用户。

普通技术成果由 PM依据证据验收；生产数据、不可逆操作、真实费用、重大业务取舍和用户明确保留的事项仍由用户决定。

完成任务确认结果可从任务线程、Git或正式记录找到，并且不再影响当前主线、共享对象或后续接力时，由`workbench.accept`从活动区移入月度历史并只保留近期主线结果。事务脚本不替PM判断完成；仍被当前主线消费时只保留结果入口和影响，不保留完成过程。稳定事实写回原所有者，长过程进入已有历史入口；不为“已看到”唤醒已经结束的Worker。
