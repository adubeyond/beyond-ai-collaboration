# PM结果回传路径演变记录

> 本文件只保存历史证据，不是当前运行规则。当前唯一执行规则以交付包内的[Worker身份规则](../模板交付包/skills/identity-worker/SKILL.md)和[PM暂停、恢复与收口](../模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md)为准；历史探针、旧裁决和曾用算法不得作为任务执行依据。

## 1. 旧方案

3.1.x曾用本机结果收件箱避免Worker消息打断PM。随后3.2早期候选又试验了notify适配器、终态回执、CLI恢复和WindowsApps镜像。这些路径都复制了平台已经保存的Worker final，并扩大了安装、升级和故障面。

## 2. 真实探针结论

- PM空闲时，原生定向消息会启动独立回合；
- PM忙碌时直接发送可能注入当前回合并被主回答覆盖；
- Worker等待PM当前回合结束后再发送，原回答保持完整；
- 多个Worker同时看到PM空闲并发送时，消息可能合并进一个PM回合；
- 当时的探针曾用全量Worker复读验证合并回调场景；这只是旧实验条件，不是当前PM收口算法。

## 3. 当前规则所有者

Worker终态顺序只由[Worker身份规则](../模板交付包/skills/identity-worker/SKILL.md)拥有；PM对pending、活动任务、Worker final、工作台事务和回执消费的匹配与收口顺序只由[PM暂停、恢复与收口](../模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md)拥有。本文件后续日期章节仅用于解释问题如何被发现和为何改变，不复制或覆盖当前算法。

## 4. 2026-08-19 新系统复现与修正

万事通在重装后的纯净Codex环境中再次复现：Worker因本地工具启动失败直接输出`已暂停`，没有执行平台回传；PM直到老板再次发消息后才发现。恢复同一Worker并明确要求使用`send_message_to_thread`后，平台消息成功唤醒空闲PM。这证明安装版本与消息通道正常，短路发生在Worker异常终态绕过回传步骤。

R1先把异常终态并入统一收口，但仍要求Worker判断PM忙闲并等待。真机中正常完成的A任务在PM忙碌时没有发起`send_message_to_thread`，直到后续任务回调才被扫描发现；这证明忙闲判断与等待本身仍是可被模型跳过的分支，R1不通过。

随后进行单变量实验：Worker等待12秒后不读取PM状态、不等待，直接发送`DIRECT_SEND_PROBE_R1`。消息在PM生成长回答期间成功送达，但平台将它安排到完整回答的边界后处理，`DIRECT_PM_ANSWER_COMPLETE_R1`未被截断。由此形成R2唯一顺序：稳定现场并形成final草稿，但不输出 → 无条件调用一次平台`send_message_to_thread` → 最后输出Worker final。正常完成、工具失败、权限失败、缺失输出和环境异常共用这条收口路径；发送失败仍以Worker final保底，不恢复Hook、CLI、notify适配器或自建结果信箱。

旧实现只作为历史失败证据，不再是安装内容或运行入口。

## 5. 2026-08-21 回调早于 final 的竞态

万事通真实任务中，Worker于18:11:55成功唤醒PM，PM于18:12:02扫描时Worker仍在运行，Worker直到18:12:08才保存final。PM没有执行回合结束前补查，工作台继续停留在`进行中`。前两次成功任务的回调至final间隔约7秒，PM实际扫描时final恰好已经落定，因此旧测试被运行时序掩盖。

当时的修正保持Worker收口顺序不变，不恢复信箱、Hook、CLI或第二次回调，并用有界等待与一次性复读验证回调早于final的竞态。这里记录的是2026-08-21实验设计；当前等待、读取和匹配范围仍只以PM收口唯一规则所有者为准。

本地确定性回归已覆盖上述时序，10/10通过。隔离提示词用例确认只等待回调来源、不等待其他Worker、等待后只重扫一次。真实Codex Desktop基础闭环中，完成Worker和暂停Worker各回调一次、各形成一份final、各验收一次，回调后均无工具调用；本轮两份final在PM作出等待判断前已经落定，因此该现场只证明基础闭环，30秒竞态仍以确定性回归为证据，不把未命中的概率现场写成已命中。

## 6. 2026-08-22 延迟工具发现缺口

R5异机正式任务中，PM通过`codex_app__create_thread`创建了用户可见Worker，Worker完成代码、4项测试和本地提交后输出final，但没有回源。只读取证确认：任务包装已经提供来源PM的`source_thread_id`；`codex_app__send_message_to_thread`也存在于`ALL_TOOLS`，但没有在Worker顶层工具声明中直接显示。Worker只检查了顶层工具，错误地把“未直接显示”判断成“工具不可用”。

同一Worker随后通过`ALL_TOOLS`发现延迟工具，并以原`source_thread_id`执行一次原生回传；PM被成功唤醒，读取原Worker final后只验收、归档一次。由此裁决：不恢复Hook、信箱、CLI或轮询；Worker回源目标只认平台任务包装的`source_thread_id`，顶层未显示回源工具时必须从`ALL_TOOLS`发现`codex_app__send_message_to_thread`并通过工具编排入口调用。创建接口返回的Worker `threadId`不能冒充来源PM，来源缺失或矛盾时仍按真实回源缺口收口。

## 7. 2026-08-23 暂停恢复回合不可读

R6真机测试证明新Worker正常完成、真实暂停、忙碌PM和并行收口均可用；但PM向已暂停原Worker发送恢复输入后，平台出现两类独立故障：附带可选`hostId`时新turn以`items=[]`空响应结束；只发送`threadId + prompt`时Worker界面可见新final，PM的`read_thread`和即时快照仍返回空。旧测试只覆盖了首次暂停和重新扫描已结束final，没有覆盖“同一暂停Worker进入第二turn并回传第二终态”。

R7不改变已通过的原生回调路径，只补一个项目内短期pending：正式任务包携带`projectId + taskId`；Worker在回调前通过现有`runtime`写入同一份冻结final；PM按任务标识消费，工作台事务成功后立即删除。恢复发送只传当前工具必填字段，当前标准为`threadId + prompt`，不附加可选`hostId`、模型或推理参数。该机制没有常驻进程、Hook、notify分支、额外CLI、轮询、消息历史或长期正文归档。
