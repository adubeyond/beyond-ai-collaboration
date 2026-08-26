import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
let passed = 0;

function read(relativePath) {
  const path = join(repositoryRoot, ...relativePath.split("/"));
  if (!existsSync(path)) {
    errors.push(`文件缺失：${relativePath}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireText(name, text, expected) {
  if (!text.includes(expected)) {
    errors.push(`${name}：缺少“${expected}”`);
    return;
  }
  passed += 1;
}

function forbidText(name, text, forbidden) {
  if (text.includes(forbidden)) {
    errors.push(`${name}：仍包含“${forbidden}”`);
    return;
  }
  passed += 1;
}

function requireCondition(name, condition, detail) {
  if (!condition) {
    errors.push(`${name}：${detail}`);
    return;
  }
  passed += 1;
}

function requireMissingFile(name, relativePath) {
  const path = join(repositoryRoot, ...relativePath.split("/"));
  if (existsSync(path)) {
    errors.push(`${name}：文件仍存在 ${relativePath}`);
    return;
  }
  passed += 1;
}

const agents = read("模板交付包/AGENTS.md");
const pm = read("模板交付包/skills/identity-pm/SKILL.md");
const worker = read("模板交付包/skills/identity-worker/SKILL.md");
const design = read("模板交付包/skills/task-design/SKILL.md");
const complexDesign = read("模板交付包/skills/task-design/references/complex-design-document-and-implementation.md");
const dev = read("模板交付包/skills/task-dev/SKILL.md");
const test = read("模板交付包/skills/task-test/SKILL.md");
const ops = read("模板交付包/skills/task-ops/SKILL.md");
const opsFacts = read("模板交付包/skills/task-ops/references/capability-and-runbook.md");
const production = read("模板交付包/skills/task-ops/references/production-release-and-convergence.md");
const documentEntry = read("模板交付包/docs/AI编程协同机制/00-模板入口.md");
const projectOverview = read("模板交付包/docs/AI编程协同机制/项目总览.md");
const projectFacts = read("模板交付包/docs/AI编程协同机制/项目事实/README.md");
const architecture = read("docs/系统架构与运行机制.md");
const collaboration = read("模板交付包/docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md");
const workerCollaboration = read("模板交付包/skills/identity-worker/references/collaboration-and-rework.md");
const workerCapability = read("模板交付包/skills/identity-worker/references/capability-correction-and-cost.md");
const installVerifier = read("模板交付包/scripts/verify-install-integrity.mjs");
const controlScript = read("模板交付包/scripts/beyond-control.mjs");
const controlRuntime = read("模板交付包/scripts/runtime/control-runtime.mjs");
const workbenchRuntime = read("模板交付包/scripts/runtime/workbench-transaction.mjs");
const projectIdentityRuntime = read("模板交付包/scripts/runtime/project-identity-provider.mjs");
const workerResultRuntime = read("模板交付包/scripts/runtime/worker-result-receipts.mjs");
const teamCollaboration = read("模板交付包/docs/AI编程协同机制/团队任务与协同.md");
const releaseManifest = read("模板交付包/beyond-release.json");
const pmCoordination = read("模板交付包/skills/identity-pm/references/cross-task-coordination.md");
const pmDispatch = read("模板交付包/skills/identity-pm/references/dispatch-and-init.md");
const pmLifecycle = read("模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md");
const workbench = read("模板交付包/docs/AI编程协同机制/当前工作台.md");
const gitCloseout = read("模板交付包/skills/task-ops/references/git-and-resource-closeout.md");
const quickStartZh = read("docs/快速开始.md");
const quickStartEn = read("docs/en/quick-start.md");
const installGuideZh = read("模板交付包/docs/安装升级与项目初始化指南.md");
const installGuideEn = read("模板交付包/docs/en/installation-upgrade-and-project-initialization.md");

// 默认运行路径不依赖Hook；升级只精确清理BEYOND旧护栏，不接管第三方Hook。
requireMissingFile("候选不交付Hook配置", "模板交付包/.codex/hooks.json");
requireMissingFile("候选不交付身份护栏", "模板交付包/.codex/beyond-runtime-guard.mjs");
requireText("PM身份来自显式入口", pm, "用户显式调用`$identity-pm`");
requireText("压缩恢复不改变PM身份", pm, "上下文压缩、恢复和“继续”不改变该身份");
forbidText("PM不再调用运行身份命令", pm, "runtime-identity");
forbidText("PM不再要求Hook探针", pm, "hook-probe");
requireText("安装脚本识别BEYOND旧处理器", controlScript, "value.includes(\"beyond-runtime-guard.mjs\")");
requireText("安装脚本只过滤BEYOND旧处理器", controlScript, "const keptHandlers = group.hooks.filter");
requireText("安装脚本保留无法识别的同名文件", controlScript, "preserved-unrecognized");
requireText("安装脚本清理旧运行身份状态", controlScript, "identity-sessions");
requireText("验真拒绝旧护栏脚本", installVerifier, "项目仍残留BEYOND身份护栏脚本");
requireText("验真拒绝旧Hook引用", installVerifier, "项目现有Hook配置仍引用BEYOND身份护栏");
forbidText("版本清单不登记运行Hook", releaseManifest, "runtimeHooks");
forbidText("版本清单不登记身份脚本", releaseManifest, "runtimeGuard");
requireText("版本清单完整登记确定性控制运行文件", releaseManifest, '"controlRuntimeFiles"');
requireText("安装验真逐文件对账控制运行模块", installVerifier, "项目映射的控制运行文件与当前候选不一致");
forbidText("中文快速开始不强制重启", quickStartZh, "验真通过后重启 Codex");
forbidText("英文快速开始不强制重启", quickStartEn, "install the six Skills from this repository and restart Codex");
forbidText("英文快速开始不宣称安装身份护栏", quickStartEn, "project-level `.codex` guard");
requireText("架构明确Hook不是安装前提", architecture, "BEYOND不把平台Hook作为身份或安装前提");
requireText("中文安装不要求Git项目", installGuideZh, "不得把`git rev-parse`成功作为项目根前提");
requireText("中文备份对账包含隐藏文件", installGuideZh, "Get-ChildItem -Force -Recurse -File");
requireText("英文安装不要求Git项目", installGuideEn, "never make a successful `git rev-parse` a prerequisite");
requireText("英文备份对账包含隐藏文件", installGuideEn, "Get-ChildItem -Force -Recurse -File");

// S1：普通局部 BUG。
requireText("S1清晰请求不制造任务", agents, "清晰请求不输出接手仪式，不凭空制造正式任务");
requireText("S1模糊动作请求先澄清再分流", agents, "只有动作意图和对象、没有可判定业务结果的请求不进入Action Skill");
requireText("S1模糊优化不触发开发Skill", dev, "只给出“优化、改进、处理”等动作意图和对象但没有可判定结果时不触发本 Skill");
requireText("单独接手不启动旧任务", agents, "单独接手项目只恢复控制面，不自动创建、恢复或启动业务任务");
requireText("接手并继续需要同轮明确指令", agents, "同一条用户指令已经明确要求推进某个结果");
requireText("S1局部修改不读reference", dev, "普通缺陷、清晰局部修改或已有明确验证入口：沿现有组织直接处理，不读 reference");
requireText("S1必要验证不再申请授权", dev, "正式代码任务的验收本身包含必要测试或等价验证");
requireText("S1普通失败原Worker闭环", worker, "普通测试失败、实现调整、格式化、lint、构建和复测由本 Worker闭环");
requireText("S1本地提交连续交付", dev, "任务自有本地提交属于连续交付");
requireText("S1本地提交不切运维", dev, "不为这一步切换或加载 `task-ops`");
requireText("S1运维不截获本地提交", ops, "普通代码任务自己的本地提交是开发连续交付，不进入本 Skill");

// S2：需要设计的新功能。
requireText("S2设计回原Worker", design, "结果回到同一个 Worker");
requireText("S2复用任务入口", complexDesign, "正式任务直接使用任务已经点名的项目/子项目文档入口和事实索引");
requireText("S2单一活动设计", design, "复杂设计必须使用一个明确的活动设计文档");
requireText("S2调查证据不冒充实施路径", design, "只是证据");
requireText("S2设计目录不承载下游证据", complexDesign, "不作为后续开发、测试、发布或运行证据的通用工作区");
requireText("S2跨任务只传最小设计摘要", complexDesign, "不复制设计正文");
requireText("S2同Worker进入开发", complexDesign, "同一个 Worker切换到开发方法继续");
requireText("S2测试失败回原Worker", test, "同一个 Worker切换开发方法修复");

// S3：已授权生产发布。
requireText("S3相同授权不再等待PM", ops, "不等待 PM二次激活");
requireText("运维项目路由先读根入口和事实索引", ops, "先读取当前项目根入口，再按其中的规则所有者找到项目事实索引指定的唯一 Git/PR 或运行手册正文");
requireText("Git收口复用项目唯一正式入口", gitCloseout, "从当前项目根入口进入项目事实索引，读取其指定的唯一 Git/PR 正文和受管脚本");
requireText("Git同名本地副本不冒充正式入口", gitCloseout, "未跟踪文件、stash、备份、临时修订和其他分支副本");
requireText("Git局部入口漂移不阻断整项任务", gitCloseout, "局部漂移只隔离该副本");
requireText("required CI正常推进保持进行中", gitCloseout, "仍有明确责任实例、状态入口或正常推进信号时保持任务`进行中`");
requireText("PM不把正常CI等待登记为暂停", pmLifecycle, "required CI 正在排队或运行");
requireText("服务器运维复用项目唯一正式入口", opsFacts, "先读取当前项目根入口，再按其中的规则所有者进入项目事实索引");
requireText("S3首次核验实际目标", ops, "连接目标时现场确认主机身份和实际运行落点");
requireText("S3单一来源四项事实", production, "普通单一来源发布先核对四个身份事实");
requireText("S3一次建立生产上下文", production, "形成一份生产上下文");
requireText("S3后续只刷新变化项", ops, "才刷新受影响项");
requireText("S3连续发布不重复放行", ops, "不逐步输出`可以继续`、不回PM、不等待用户重复放行");
forbidText("S3不再默认五锚点", production, "五锚点");
forbidText("S3不再默认任务起始基线", production, "任务起始基线 /");
requireText("S3执行者自行远程操作", ops, "不要求用户手工代操作，也不重复索要相同授权");
requireText("S3同任务长观察", ops, "原 Worker转`已暂停`并在同一任务恢复");
requireText("S3 SSH冲突必须读取运行事实", ops, "SSH入口/凭据来源存在冲突或认证异常");
requireText("S3 SSH冲突必须先读取运行事实reference", ops, "在处理该分支前必须完整读取[运行事实与部署手册]");
requireText("S3 SSH具体方法只有一个所有者", ops, "主入口不保存具体解析方法");
requireText("S3服务器使用规范别名", ops, "环境角色 + 配置中准确的规范别名 + 已核验主机身份");
requireText("S3密码提示不等于缺少密码", opsFacts, "错误别名回退到默认账号、默认密钥或密码提示，不构成“项目没有密码”的证据");
requireText("S3先展开SSH配置", opsFacts, "先用`ssh -G <别名>`展开实际主机、账号、`IdentityFile`");
requireText("S3配置已有凭据不问用户", opsFacts, "才询问缺少的凭据来源或授权");

// 三场景共同约束。
requireText("普通过程不逐步回PM", pm, "不为普通任务逐动作授权、逐阶段续派、设置动作额度或编写方法清单");
requireText("正式Worker使用用户可见任务", pm, "全新用户可见项目任务");
requireText("内部子智能体不冒充正式Worker", pm, "内部子智能体只帮助启动它的Worker");
requireText("安排其他人包含建任务意图", pm, "要求团队完成已明确或已批准的独立业务结果");
requireText("明确团队任务不二次确认", pm, "不重复询问已经给出的目标和授权");
requireText("任务包不是执行手册", pm, "任务包是业务契约，不是PM替Worker编写的执行手册");
requireText("任务包不是固定表单", pm, "普通任务包不是表单，通常只有两到四个短段");
requireText("任务包不重复系统通则", pm, "系统通则已经生效时不在每个任务中重述");
requireText("普通任务包保持两到四个短段", pm, "通常只有两到四个短段");
requireText("任务包不复制通用禁止项", pm, "不要展开调查步骤、实现方法、测试组合、证据目录或通用禁止项");
requireText("PM过程沟通继承根入口", pm, "工具过程沟通继承根入口");
requireText("PM最终答复保持自包含", pm, "最终答复保持自包含");
requireText("安装PM从项目根映射团队入口", pm, "完整读取当前项目根`AGENTS.md`映射的团队入口");
forbidText("安装PM不使用安装目录相对团队链接", pm, "../../docs/AI编程协同机制/团队任务与协同.md");
requireText("安装PM从项目根映射跨任务入口", pm, "先读项目根映射的跨任务机制");
requireText("安装Worker从项目根映射跨任务入口", worker, "当前项目根`AGENTS.md`在“规则所有者”中映射的跨任务协同与共享对象机制");
requireText("安装设计reference从项目根映射文档入口", complexDesign, "当前项目根`AGENTS.md`在“规则所有者”中映射的项目文档入口");
forbidText("安装Skills不保留源码树项目文档相对链接", `${pm}\n${worker}\n${workerCollaboration}\n${complexDesign}`, "../docs/AI编程协同机制");
requireText("业务项目按融合标记定位控制脚本", teamCollaboration, "`BEYOND-CONTROL-ROOT`定位同一控制仓脚本");
requireText("入口融合改写控制脚本路径", controlScript, "source.replace(/`scripts\\//g");
requireText("安装验真反向归一控制脚本路径", installVerifier, '["docs", "scripts", "local", "projects"]');
requireText("安装验真检查项目总览Worker策略", installVerifier, "validateWorkerPolicy(overview");
requireText("复杂派单在业务契约闭合后停止", pmDispatch, "PM在业务契约闭合后停止编译");
requireText("复杂任务不扩写章节", pmDispatch, "不因复杂就把字段扩成章节");
requireText("设计检查点不拆第二Worker", pm, "不得再建立一个实施Worker");
requireText("检查点恢复原Worker", pmLifecycle, "用户确认后恢复原 Worker和现有现场");
requireText("候选讨论没有控制效力", pm, "讨论、建议、候选方案和PM推断没有控制效力");
requireText("具体项目问题不得泛化回答", pm, "不把具体问题泛化成通用说明");
requireText("跨任务候选不撤销授权", pmCoordination, "用户确认前不撤销既有授权");
requireText("候选知会保持契约不变", pmCoordination, "候选、尚未生效、当前任务契约不变");
requireText("跨任务机制拒绝未确认候选控制", collaboration, "在确认前不能成为其他任务的新前置、暂停条件或授权变化");
requireText("工作台只保留单一里程碑", workbench, "一个当前业务里程碑");
requireText("工作台不复制任务内部计数", workbench, "路由数、批次、测试计数、命令和多轮尝试不转写到任务行");
requireText("完成任务及时退出高频表", pmLifecycle, "由`workbench.accept`从活动区移入月度历史");
requireText("Worker终态保持自包含", worker, "完整自包含final草稿");
requireText("PM不下传祖先来源", pm, "不下传自己的上游来源");
requireText("PM不填写回传ID", pm, "不填写thread ID");
requireText("PM不否定平台回传", pm, "不写“无需回传”");
requireText("正式任务只显式启动Worker", pm, "初始提示首行只放`$identity-worker`");
requireText("PM不预选Action Skill", pm, "PM不预选Action Skill");
requireText("正式任务必须是全新项目任务", pm, "全新用户可见项目任务");
requireText("项目身份走确定性入口", pm, "`project.resolve`");
requireText("项目身份非绿不降级", pm, "结果不是`verified`时按真实原因停止，不降级成projectless");
requireText("项目身份实现四级裁决", projectIdentityRuntime, "verified: {");
requireText("项目身份冲突阻止建任务", projectIdentityRuntime, "createWorker: false");
requireText("正式Worker固定local环境", pm, "`environment.type=local`");
requireText("创建时不请求worktree", pm, "不使用fork、内部助手或worktree");
requireText("PM按工作性质形成确定类别", pm, "ordinary-engineering");
requireText("PM通过唯一固定动作解析Worker策略", pm, "worker-policy --action resolve");
requireText("PM不按风险名词升级模型", pmDispatch, "不按任务包中出现的风险名词升级");
requireText("PM拿不准时使用常规工程类别", pmDispatch, "拿不准时先用`ordinary-engineering`");
requireText("PM保留用户明确的当轮临时Worker模型选择", pmDispatch, "当前PM对话中老板明确指定的临时参数");
requireText("未批准项目策略保留平台默认", pmDispatch, "才覆盖平台默认");
requireText("项目策略只影响新建正式Worker", pmDispatch, "仅适用于新建正式Worker");
requireText("PM模型不受Worker策略影响", pmDispatch, "当前PM本身不变");
requireText("模型参数不进入业务任务包", pmDispatch, "模型参数不写进业务任务包");
requireText("Worker回调只负责唤醒扫描", pm, "Worker回调只表示需要扫描");
requireText("Worker冻结同一份正式结果", worker, "同一份final作为本轮最后一个动作输出并结束");
requireText("正式任务包携带回执控制标识", pm, "控制标识：projectId=<当前正式项目编号>；taskId=<本结果唯一任务编号>");
requireText("Worker先保存短期终态回执", worker, "执行一次`worker-result.enqueue`");
requireText("回执不是第二业务真值", worker, "不是第二种业务真值、消息历史或长期证据");
requireText("Worker回源目标取平台来源编号", worker, "回源目标只取当前平台任务包装提供的`source_thread_id`");
requireText("Worker不把自身编号当回源目标", worker, "当前Worker `threadId`不是回源目标");
requireText("Worker发现延迟回源工具", worker, "从`ALL_TOOLS`发现规范工具`codex_app__send_message_to_thread`");
requireText("顶层工具缺失不等于能力缺失", worker, "顶层未显示不等于工具不存在");
requireText("Worker回源参数固定为threadId和prompt", worker, "当前标准调用固定只传`threadId + prompt`");
requireText("Worker不附加可选宿主参数", worker, "不附加可选`hostId`、模型或推理参数");
requireText("所有终态使用平台原生唤醒", worker, "直接向唯一来源调用一次");
requireText("Worker不读取PM忙闲", worker, "不读取或判断来源PM忙闲");
requireText("Worker不等待PM回合", worker, "不调用`wait_threads`");
requireText("异常终态不绕过回传", worker, "所有真实终态都进入同一个收口");
requireText("回传工具是最后一次工具调用", worker, "回源工具必须是本轮最后一次工具调用");
requireText("回传后禁止继续业务动作", worker, "回源工具返回后不得继续推理、发送过程消息或调用任何工具");
requireText("回调不替代业务验收", pm, "不直接等于业务验收或线程已经结束");
requireText("正常业务默认权益不制造新授权", pm, "普通默认权益和默认配置不产生第二次授权");
requireText("普通开发解析为Terra高推理", controlScript, '"ordinary-engineering": { model: "gpt-5.6-terra", thinking: "high" }');
requireText("大量结构化核对解析为Luna高推理", controlScript, '"bulk-structured": { model: "gpt-5.6-luna", thinking: "high" }');
requireText("复杂高风险解析为Sol超高推理", controlScript, '"complex-high-risk": { model: "gpt-5.6-sol", thinking: "xhigh" }');
requireText("项目总览唯一承载Worker策略", projectOverview, "Worker运行策略");
requireText("项目总览唯一承载初始化进度", projectOverview, "项目初始化");
requireText("固定脚本提供可恢复初始化动作", controlScript, "function initialization()");
requireText("最低接入返回唯一下一问", controlScript, "现在完整初始化，或先开始使用、后续按需补齐");
requireText("初始化完成拒绝遗漏分组", controlScript, "仍有未处理初始化分组");
requireText("PM从固定状态恢复初始化", pmDispatch, "initialization --action show --project-id <当前项目>");
requireText("PM主入口显式路由继续初始化", pm, "首次接入、升级、复杂派单、模型策略或高风险动作");
requireText("PM完整初始化后瘦身根入口", pmDispatch, "根`AGENTS.md`只剩稳定边界和入口");
requireText("根覆盖区不承载模型选择", agents, "动态任务、模型选择、服务器秘密和完整运行状态不得写入这里");
requireText("可复现命令入口优先于网页操作", agents, "Git 优先使用 Git 或远端平台 CLI");
requireText("网页操作只在必要时进入", agents, "不把本可自动完成的操作转成网页登录和人工点击");
requireText("未完成阶段final不是终态", pm, "明确未完成的阶段final不是终态");
requireText("PM只恢复未完成阶段", pm, "PM只恢复原Worker继续");
requireText("原验收缺启动发布不拆任务", pm, "补齐验收继续使用原Worker");
requireText("创建成功必须返回正式线程", pm, "返回`threadId + hostId`才登记唯一Worker");
requireText("排队句柄不冒充Worker", pmDispatch, "只返回`clientThreadId`表示仍在排队");
requireText("创建错误不换路由补建", pmDispatch, "创建失败只报告一次，不改用fork、projectless、内部助手或其他目录补建");
requireText("标题只重命名一次", pmDispatch, "最多重命名标题一次，失败不重建任务");
requireText("PM派发成功后不读取Worker确认", pm, "不再调用`wait_threads`或读取Worker确认派发");
requireText("PM派发后立即退出", pm, "立即结束PM当前回合");
requireText("PM不等待和轮询", pmDispatch, "不等待或转播过程");
requireText("根入口或Skills替换后重启验真", pmDispatch, "重启Codex并从新进程验真");
requireText("新回执不恢复旧投递栈", pmLifecycle, "不引入Hook、notify适配器、额外Codex CLI或后台进程");
requireText("正式任务禁止fork承载", pm, "不使用fork、内部助手或worktree");
requireText("正式任务禁止projectless降级", pm, "不降级成projectless");
requireText("错误项目任务先停止再纠正", worker, "在任何业务读取、网络、写入或运行操作前停止错误路由");
requireText("Worker以final作为最后动作", worker, "只把已冻结的同一份final作为本轮最后一个动作输出并结束");
requireText("Worker回源前结束业务工具", worker, "最后一次业务工具调用已经结束");
requireText("PM拒绝提前验收", pmLifecycle, "仍在运行且没有可读final");
requireText("PM回调竞态只做一次有界等待", pmLifecycle, "只对该来源调用一次`wait_threads(timeoutMs=30000)`");
requireText("PM回调等待禁止循环", pmLifecycle, "不得循环");
requireText("PM结束无final转真实暂停", pmLifecycle, "执行线程未形成正式结果");
requireText("Worker异常终态共用收口", worker, "不得从异常分支直接跳到final");
requireText("Worker终态只尝试一次唤醒", worker, "不循环、不重试、不改投其他ID");
requireText("Worker回执只做短期控制快照", worker, "短期控制快照");
requireText("Worker终态异常不改投", worker, "不改投其他ID");
requireText("旧上下文凭据不自动授权", workerCapability, "凭据不自动成为当前任务授权");
requireText("Worker字段映射不倒置", worker, "按主证据原方向写清，不能倒置");
requireText("Worker用户交付隐藏非决定性工程明细", worker, "面向用户的final不复述测试命令与数量、提交哈希、分支名或内部字段");
requireText("PM回调触发全量扫尾", pm, "任何回调都按收口reference先读取当前项目全部待处理终态回执，再扫描工作台登记的全部Worker");
requireText("PM结果读取不后台轮询", pmLifecycle, "不得高频轮询或用补读冒充唤醒主通道");
requireText("PM自然回合补读活动任务pending", pmLifecycle, "非回调触发的自然PM回合开始时");
requireText("PM自然回合空列表走最短路径", pmLifecycle, "列表为空时立即继续老板当前目标，不读取Worker");
requireText("PM自然回合不扫描无关Worker", pmLifecycle, "不扫描无关Worker");
requireText("PM遗留回执只做幂等补ack", pmLifecycle, "工作台事务已经幂等成功时才补一次`worker-result.ack`");
requireText("PM当前用户问题优先", pm, "当前用户问题始终优先");
requireText("PM沿正式final与证据核验", pm, "final指向的一手证据是否直接覆盖验收");
requireText("PM不以逐字一致制造重复终态", pm, "不要求措辞逐字一致");
requireText("PM只在实质矛盾时退回原Worker", pmLifecycle, "两者存在实质矛盾时保持未验收并退回原Worker");
requireText("Worker回源固定使用prompt字段", worker, '"prompt":"当前Worker正在提交终态');
requireText("Worker回源明确禁止message字段", worker, "不得写成`message`");
forbidText("PM不再要求正文指纹逐字一致", pmLifecycle, "正文指纹一致");
forbidText("Worker主入口不再要求写收件箱", worker, "inbox --action enqueue");
forbidText("PM主入口不再每回合读取收件箱", pm, "每个用户发起的 PM 新回合都先调用一次固定脚本`inbox");
forbidText("固定脚本不再提供结果收件箱", controlScript, "function inbox()");
forbidText("固定脚本不再复制终态到local inbox", controlScript, 'join(controlRoot, "local", "inbox", "pending", projectId)');
requireText("统一机器入口接入总脚本", controlScript, 'executeRuntimeRequest(request, { controlRoot })');
requireText("统一机器入口使用版本化请求", controlRuntime, "request.schemaVersion !== 1");
requireText("统一机器入口支持老工作台迁移", controlRuntime, "'workbench.migrate'");
requireText("统一机器入口支持终态回执入队", controlRuntime, "'worker-result.enqueue'");
requireText("统一机器入口支持终态回执扫描", controlRuntime, "'worker-result.list'");
requireText("统一机器入口支持终态回执删除", controlRuntime, "'worker-result.ack'");
requireText("终态回执正文消费后物理删除", workerResultRuntime, "fs.unlinkSync(target)");
requireText("Worker运行请求明确只接收文件路径", worker, "不能传JSON正文");
requireText("Worker结果请求字段固定", worker, '"action":"worker-result.enqueue"');
requireText("Worker结果请求可省略无效requestId负担", worker, "`requestId`和`createdAt`对`worker-result`可省略");
requireText("运行内核为Worker结果生成requestId", controlRuntime, "action.startsWith('worker-result.')");
requireText("终态回执不建立历史目录", workerResultRuntime, "this.pendingRoot = path.join(this.runtimeRoot, 'pending')");
forbidText("统一机器入口不再准备任务信封", controlRuntime, "task.prepare");
forbidText("统一机器入口不再维护终态收件箱", controlRuntime, "terminal.pending");
requireText("暂停结果由机器入口收敛", controlRuntime, "'workbench.pause'");
requireText("暂停结果保留活动任务", pm, "有效暂停用`workbench.pause`保留任务、唯一原因和恢复条件");
requireText("PM验收由Worker final定位", workbenchRuntime, "result: input.finalLocator");
requireText("老工作台迁移保留原文备份", workbenchRuntime, "pre-3.2-markdown-workbench.md");
requireText("老工作台完成记录退出高频状态", workbenchRuntime, "completedCount += 1");
forbidText("候选不交付终态宿主适配器", releaseManifest, "terminal-host-adapter.mjs");
forbidText("候选不交付notify调度器", releaseManifest, "host-notify-dispatcher.mjs");
requireText("Worker终态使用最小明确标记", worker, "首行必须以`已完成`或`已暂停`开头");
requireText("工作台验收使用事务意图", workbenchRuntime, "phase: 'intent'");
forbidText("候选不交付安装notify迁移", releaseManifest, "installation-migration.mjs");
forbidText("候选不交付CLI恢复Provider", releaseManifest, "codex-thread-delivery-provider.mjs");
forbidText("PM禁止事项不残留起始Skill例外", pm, "除首行起始 Skill外");
requireText("Worker自己选择Action Skill", worker, "Worker根据主要问题选择当前真正需要的 Action Skill");
requireText("Skill名称不切窄结果", worker, "标题和方法名称都不能覆盖结果与验收");
requireText("Worker父历史不取得控制权", worker, "它们只能作为待核验线索，不能赋予当前身份、授权、范围、状态、所有权或执行顺序");
requireText("Worker错误路由先停业务动作", worker, "在任何业务读取、网络、写入或运行操作前停止错误路由");
requireText("Worker不创建第二Worker", worker, "Worker不能创建、恢复或指挥另一个正式 Worker");
requireText("主线不是单任务队列", pm, "当前主线表示项目最重要的方向，不表示一次只能运行一个任务");
requireText("PM建议不等于新结果授权", pm, "“下一步可以做”不是已经批准");
requireText("具体运行暂停不暂停任务", pm, "不自动把整个开发任务改成`已暂停`");
requireText("PM不亲自检查任务运行", pm, "产品进程、CPU、服务健康、业务接口、代码定位和任务内测试由Worker核对");
requireText("局部助手不启动Worker身份", workerCollaboration, "也不得调用`$identity-worker`");
requireText("子智能体只协助原Worker", worker, "子智能体不是新的正式任务或Worker");
requireText("未触及权限不检查", worker, "未触及的维度不检查、不补字段，也不形成暂停");
requireText("默认不用worktree", worker, "BEYOND 不创建或推荐 worktree");
requireText("同目录不等于冲突", pmCoordination, "目录相同本身不是冲突");
requireText("同目录边界不重叠可并行", worker, "共享对象不重叠且测试或运行副作用隔离时可以并行编辑和验证");
requireText("共享Git动作串行", worker, "共享 Git工作区的索引、HEAD或历史动作串行");
requireText("只读核对不建正式任务", pm, "只读核对、状态查询和PM能够当轮回答的问题不建立正式任务");
requireText("环境缺口暂停前查正式事实", worker, "相关运行手册和配置，并尝试不扩大风险的既有路径");

// 目标优先：方法按需，独立性和助手只显式/有收益触发，worktree只兼容既有现场。
requireText("根入口任务目标高于流程", agents, "任务目标高于方法流程");
requireText("最新用户目标压过旧临时策略", agents, "用户最新明确的目标、边界、检查点和不做事项决定方向");
requireText("老板当前指令高于BEYOND默认规则", agents, "不得拿BEYOND自己设计的规则反过来拒绝项目所有者");
requireText("旧硬性措辞不覆盖当前指令", agents, "即使旧规则写成`禁止`或`不得`");
requireText("一次指令不自动改写长期规则", agents, "本次指令只授权点名对象与动作，不自动改写长期规则");
requireText("指定凭据路径构成精确写入授权", agents, "该指令构成本次精确写入授权");
requireText("PM保留老板特殊授权", pm, "PM必须在任务包的`特殊授权`中保留其业务含义");
requireText("PM不让老板重复授权", pm, "要求老板向Worker重复授权");
requireText("Worker最新授权压过旧项目偏好", worker, "Worker直接按最新指令执行");
requireText("Worker不以旧硬规则拒绝", worker, "不拿旧有`禁止`或`不得`再次拒绝");
requireText("Worker不让老板手工代写凭据", worker, "Worker不得要求老板手工代写");
requireText("运维不以CLI优先否决指定方法", ops, "不能用CLI优先或默认凭据建议否决老板当前指定的方法");
requireText("根入口事实冲突先停止派生动作", agents, "先停止由该判断推导的写入、依赖安装和外部动作");
requireText("根入口恢复事实反驳", agents, "明确指出冲突、说明依据并给出可执行替代");
requireText("根入口事实冲突知情后再继续", agents, "只有用户知晓冲突后仍明确要求一个独立成立的结果时才继续");
requireText("只问一个改变结果的问题", agents, "才问一个关键问题");
requireText("根入口禁止无主文件和文档", agents, "没有明确消费者、长期用途、唯一入口和回收方式时");
requireText("工作区顶层禁止任务产物扩散", agents, "不在工作区根目录或正式项目父目录随手建立测试项目、临时clone、候选、备份、证据或安装验证目录");
requireText("短期现场进入系统临时目录", agents, "短期现场使用操作系统临时目录并在任务结束时清理");
requireText("正式产物回到现有所有者", agents, "需要保留的成果进入当前项目已有正式位置或已登记的统一产物入口");
requireText("文档入口拒绝过程材料自动建档", documentEntry, "不会因为名称正式就自动成为项目文档");
forbidText("根入口不复制Worker回源工具", agents, "send_message_to_thread");
forbidText("根入口不复制PM等待算法", agents, "wait_threads");
forbidText("根入口不复制初始化脚本步骤", agents, "inspect-project");
requireCondition("根入口保持轻量", agents.replace(/\r\n/g, "\n").split("\n").length <= 105, "AGENTS.md超过105行");

// R2：PM主入口守住目标和任务边界，低频算法由对应reference拥有。
requireText("PM继承老板最新目标", pm, "老板最新明确的目标、边界、检查点和不做事项决定当前方向");
requireText("PM短提示继承项目上下文", pm, "短提示词继续继承当前项目事实和最近已经确认的目标");
requireText("PM不把完整目标缩成易交付局部", pm, "把完整目标缩成更容易交付的局部结果");
requireText("PM区分现场调查和老板取舍", pm, "Worker能从项目事实和现场调查的细节");
requireText("PM只问一个方向问题", pm, "一次只问一个会改变方向的问题");
requireText("PM首问不捆绑项目调查", pm, "环境、复现、日志和实现细节随后从项目事实调查，不捆成首轮问卷");
requireText("PM任务标题和方法不得缩窄验收", pm, "任务标题、模型类别、Action Skill名称和PM的实现猜测都不能覆盖或缩窄结果与验收");
requireText("PM任务包每段保持短句", pm, "每段通常一到两句");
requireText("PM同一结果检查点返工复用原Worker", pm, "同一结果的检查点、返工和补齐验收继续使用原Worker");
requireText("PM主线不是单任务队列", pm, "当前主线表示项目最重要的方向，不表示一次只能运行一个任务");
forbidText("PM主入口不复制回调竞态算法", pm, "wait_threads(timeoutMs=30000)");
requireText("PM回调竞态算法归收口reference", pmLifecycle, "wait_threads(timeoutMs=30000)");
forbidText("PM主入口不复制初始化状态机", pm, "initialization --action");
forbidText("PM主入口不复制Git操作清单", pm, "merge / rebase");
requireCondition("PM主入口保持控制面短核心", pm.replace(/\r\n/g, "\n").split("\n").length <= 115 && pm.length <= 5500, "identity-pm主入口超过R2短核心上限");
requireText("Worker不按方法拆任务", worker, "不按 Skill、步骤或文件数量机械拆任务");
requireText("Worker首个专业动作加载方法", worker, "进入第一个专业动作前必须完整读取一个与主要问题匹配的 Action Skill");
requireText("Worker不用身份说明替代方法", worker, "不能用 Worker 通用说明代替专业方法，也不一次性预读全部 Skill");
requireText("正式任务只读一个起始方法", agents, "完整读取一个起始Action Skill");
requireText("局部开发不并读测试方法", dev, "清晰局部改动可以由开发方法直接运行现有测试并交付");
requireText("真实测试专业问题才切方法", dev, "需要测试专业判断、复杂覆盖、跨层联调或明确独立性时");
requireText("局部开发附带现有测试不触发测试方法", test, "清晰局部开发任务附带运行现有测试时由 task-dev 直接完成，不单独触发本 Skill");
requireText("标准调用失败只试一次定点等价路径", agents, "至多做一次不改变结果与风险的定点等价尝试");
requireText("标准调用失败不遍历替代资源", agents, "不遍历全机、缓存、其他安装器、模型工具或网络搜索");
requireText("简单单路径不启助手", worker, "简单、连续、单路径任务由Worker直接完成");
requireText("旧长任务包先收敛业务契约", worker, "旧任务包或上游说明过长时，先收敛为上述六个问题再执行");
requireText("已读方法入口不重复加载", worker, "已经完整读取且未变化的Skill或reference不重复读取");
requireText("根入口低频沟通基线", agents, "预计60秒内完成的简单任务默认只发开工说明和最终交付");
requireText("根入口禁止逐工具播报", agents, "定位、读取、编辑、测试、提交和复核不逐步播报");
requireText("开工后60秒内只允许判断变化播报", agents, "开工后60秒内，只有结论、安全边界或所需用户决定确实变化时才补充");
requireText("同轮完整文件不重复读取", agents, "同一轮已完整读取且未变化的文件不得重复读取");
requireText("Skill和reference只合并播报一次", agents, "Skill主文件与按需references的读取合并为一次方法加载");
requireText("继续不授权持久自动化", agents, "不自动授权定时器、周期唤醒、心跳、长期监控或其他持久控制对象");
requireText("内部checkpoint不向用户输出", agents, "上下文压缩、恢复和内部checkpoint只用于继续工作，不向用户原样输出");
requireText("PM单行工作台更新只开工和最终", pm, "只读取并更新工作台中一处已授权事实时，只发开工说明和最终结果");
requireText("Worker终态只放一个主证据", worker, "一个主证据或正式落点");
requireText("Worker终态保留裁决主事实", worker, "一个决定裁决的业务主事实");
requireText("根入口用户答复先说业务", agents, "面向用户先用业务语言说明结果、现在能否使用、影响和下一步");
requireText("根入口技术细节按判断需要展开", agents, "技术细节只在会改变判断或用户明确要求时展开");
requireText("Worker继承用户沟通边界", worker, "面向用户的最终交付遵循根入口的用户沟通边界");
requireText("PM收口继承用户沟通边界", pmLifecycle, "按根入口的用户沟通边界收口");
requireText("开发输出不覆盖用户沟通边界", dev, "不覆盖根入口的用户沟通边界");
requireText("测试输出不覆盖用户沟通边界", test, "不覆盖根入口的用户沟通边界");
requireText("运维输出不覆盖用户沟通边界", ops, "不覆盖根入口的用户沟通边界");
requireText("Worker继承根沟通基线", worker, "沟通频率遵循根入口的全局边界");
requireText("Worker终态不复制成长消息", worker, "不复制成长消息");
requireText("Worker工程详情留在证据入口", worker, "Worker任务和正式证据入口保存工程详情");
requireText("Worker完成终态保留主线影响", worker, "主线变化与唯一下一动作");
requireText("Worker回源默认一个主证据入口", worker, "一个主证据或正式落点");
requireText("Worker用户交付保持自包含", worker, "并仍须自包含");
requireText("PM沿主证据入口验收", pmLifecycle, "PM沿其主证据定点核验");
requireText("PM不因final简短退回", pmLifecycle, "final简短本身不是证据不足");
requireText("同类高成本动作只刷新易变事实", workerCapability, "后续同类动作复用已经核验的稳定事实，只刷新进程、锁、版本、数据量、服务状态等会变化");
requireText("开发不制造失败测试", dev, "不为流程预先制造失败测试");
requireText("开发方法没有固定过门顺序", dev, "不是必须依次通过的阶段门禁");
requireText("新增依赖失败后保留可逆改动并停止", dev, "保留当前已授权的可逆本地改动并直接说明未验证缺口");
requireText("新增依赖失败后不搜索或重复测试", dev, "不继续搜索依赖版本或替代来源，也不重复运行已经确定因依赖缺失而无法启动的测试");
requireText("Worker在方案扩大时原任务内重判", worker, "在原任务内重新陈述业务结果，并比较限定修复与长期通用机制");
requireText("范围重判不制造新控制流", worker, "不是暂停、回PM、拆任务或建立新Worker的触发器");
requireText("设计分开历史修复与未来机制", design, "有限且归属已经确认的历史数据修复，与避免未来复发的产品机制分别判断");
requireText("设计分开判断不强制拆任务", design, "分别判断不等于强制拆任务");
requireText("开发复用服从当前结果", dev, "复用不是目标");
requireText("通用扩展只在当前结果内", dev, "只有通用能力本身属于当前结果时才扩展");
requireText("清晰局部修复不强制切测试Skill", dev, "清晰局部改动可以由开发方法直接运行现有测试并交付");
requireText("热修基线必须匹配正式目标", dev, "或从目标到当前包含未授权的其他变化时，不把当前整包冒充可发布候选");
requireText("共享改动核对直接消费者", dev, "定点核对直接调用方、共同制品和必要迁移");
requireText("外部契约先取一手样本", dev, "先取得一个当前样本、schema或等价一手证据");
requireText("提交前核对完整变更集", dev, "任务完整 diff、未跟踪文件和实际暂存内容");
requireText("详细交付说明基线关系", read("模板交付包/skills/task-dev/references/implementation-delivery-and-failure.md"), "源码/目标基线关系、完整变更集、直接消费者");
requireText("独立测试只显式触发", test, "没有用户、项目规则或验收标准明确提出独立性时");
requireText("同一Worker测试不冒充独立", test, "同一 Worker切换到`task-test`是专业测试，不得称为独立测试");
requireText("测试保留完整分母", test, "只统计成功记录或只看已进入checkpoint的对象不能代表整体通过");
requireText("离线测试不冒充外部边界", test, "离线fixture和Mock只证明本地逻辑");
requireText("局部候选不冒充全局门禁", test, "不能把仍为非绿的全局门禁写成通过");
requireText("测试走通用户操作链", test, "单接口成功、单按钮可见、页面无报错或技术断言全绿，不能替代用户真正完成目标");
requireText("未执行用户链不扫描实现", test, "点名验收事实已经列出用户动作并明确这些动作尚未执行时，直接按该清单说明缺口");
requireText("测试不运行无关绿色命令", test, "与当前对象和验收没有可说明的绑定关系时，先排除而不是为了取得一个退出码去运行");
requireText("测试不运行命令证明无关", test, "禁止再运行它来证明“不相关”");
requireText("决定性失败证据停止后续调用", test, "这是证据裁决的停止条件，不是建议");
requireText("决定性失败证据直接裁决", test, "停止后续工具调用，立即给出不通过或不能判断及准确缺口");
requireText("决定性失败证据不扩张", test, "其他情况下不得扫描项目、搜索替代测试、读取无关实现");
requireText("不能判断不自动暂停", test, "不自动把业务任务改成`已暂停`");
forbidText("测试不推断独立审查", test, "独立证据收益高于协调成本");
requireText("助手只在真并行收益时使用", workerCollaboration, "可以与Worker当前动作真正并行");
requireText("普通助手无需重复批准", workerCollaboration, "不需要PM或用户为普通局部助手另行批准");
requireText("独立验证可由项目预登记", test, "项目规则可以预先登记认证、支付、数据迁移、核心契约或生产发布等对象必须独立验证");
requireText("PM协调不内置reviewer", pmCoordination, "不增加 reviewer身份、专属状态、自动触发条件或审查生命周期");
forbidText("PM协调不按风险自动审查", pmCoordination, "核心链路、共享契约、生产数据或发布变更确实需要独立责任");
requireText("既有worktree仅兼容", gitCloseout, "只有用户或平台已经提供 worktree时才处理这个现场");
forbidText("不再提供worktree创建清单", gitCloseout, "创建前必须明确并核对");

// 冷启动与定位压缩不能改变实际责任。
requireText("健康工作台优先于文档治理入口", agents, "先读取`local/当前工作台.md`恢复当前主线、正式任务和下一步");
requireText("文档治理入口只在真实命中时读取", agents, "工作台缺失、为空、冲突，或当前确实需要处理事实归位、文档创建更新、入口纠偏和历史回收时");
requireText("00入口承接异常文档治理", documentEntry, "只有项目初始化、项目接手发现工作台缺失/冲突或需要处理事实归位、文档创建更新与历史回收");
requireText("初始化不进入普通任务热路径", agents, "不进入普通任务热路径");
requireText("升级先核对当前直接事实", agents, "初始化优先复用现有`AGENTS.md`、代码、Git和Markdown事实");
requireText("项目入口携带运行版本", agents, "BEYOND-RUNTIME-VERSION: 3.2.4");
requireText("项目覆盖有专用边界", agents, "BEGIN BEYOND PROJECT OVERRIDES");
requireText("安装逐文件对账六个Skill", installVerifier, "安装Skill内容不一致");
requireText("安装核对项目完整运行内核", installVerifier, "项目入口的BEYOND运行内核与控制仓候选不一致");
requireText("安装清单声明当前版本", releaseManifest, '"releaseVersion": "3.2.4"');
requireText("个人路径不读取团队共享区", agents, "普通项目接手、正式Worker任务、Action Skill切换和个人任务不读取共享区");
requireText("团队协同不替代正式Worker", agents, "不替代当前成员自己的正式Worker");
requireText("PM初始化与协同权限严格限域", pmDispatch, "两者都不扩张到业务源码、测试、仓库配置、成员权限、环境、数据或发布");
requireText("PM冷启动补齐默认称呼信号", pm, "这只补齐冷启动，不复制其他根入口规则");
requireText("跨任务规则变化真实读取两层入口", pm, "需要安排关系时再完整读取[跨任务协调]");
requireText("项目登记推送使用专用范围", pmDispatch, "`project-registration`范围精确提交这三份固定基础文件");
requireText("remote登记剥离HTTP凭据", controlScript, "url.username = \"\"");
requireText("归档编号拒绝路径分隔符", controlScript, "归档编号无效");
requireText("控制仓拒绝自我融合", controlScript, "控制仓不能把自身登记或融合为业务项目");
requireText("项目内控制仓是默认路径", agents, "当前项目根下的`beyond-control/`");
requireText("项目内控制仓与业务Git隔离", controlScript, "ensureProjectControlIsolation");
requireText("工作台支持只读汇总", controlScript, 'workbench --action list');
requireText("工作台只收拢已完成任务", controlScript, "只有已完成任务可以移出高频区");
requireText("工作台收拢先备份本机状态", controlScript, 'backupLocal("workbench-archive")');
requireText("PM而非脚本判断完成", pmLifecycle, "事务脚本不替PM判断完成");
requireText("工作台自动化不接管验收", workbench, "脚本不替PM判断验收，也不移动进行中或已暂停任务");
requireText("完成后正常收口不是暂停", worker, "任务停止只有两类边界：满足第7节完成条件后正常收口");
requireText("团队路径先读规则再调脚本", pm, "完整读取当前项目根`AGENTS.md`映射的团队入口，再使用同一入口指定的固定脚本");
requireText("兼容核对包含嵌套AGENTS", documentEntry, "根与嵌套 `AGENTS.md`只保留对应目录的稳定边界、特殊风险和事实入口");
requireText("兼容核对收敛环境入口冲突", documentEntry, "同一环境指向不同主机、SSH别名或凭据来源");
requireText("旧工作台激活门禁退出项目入口", documentEntry, "不得要求“工作台先激活”“PM先派单”");
requireText("普通任务不重做文档迁移", documentEntry, "普通任务直接使用任务点名的项目入口，不重复审查整套文档体系");
requireText("项目总览不复制Skill规则", projectOverview, "本文件不得复制这些机制规则");
requireText("项目事实不是第二套规则", projectFacts, "本索引只组织项目特有事实，不成为第二套运行规则");
requireText("产品架构明确Skill文档组合", architecture, "BEYOND的实际能力来自组合而不是纯Skill");
requireText("设计方法仍回原Worker", design, "正式结果回到同一个 Worker");
requireText("开发方法仍回原Worker", dev, "正式结果回到同一个 Worker");
requireText("测试方法仍回原Worker", test, "正式证据和裁决回到同一个 Worker");
requireText("测试模板不建初始化门禁", read("模板交付包/docs/AI编程协同机制/模板/测试与验收基线模板.md"), "缺少当前动作必需项时先定点调查或补齐");
const environmentTemplate = read("模板交付包/docs/AI编程协同机制/模板/运行环境与服务器信息模板.md");
requireText("服务器模板记录规范连接入口", environmentTemplate, "规范连接入口 / SSH别名");
requireText("服务器模板区分地址观测", environmentTemplate, "最近解析地址（观测值）");
requireText("服务器模板记录主机身份", environmentTemplate, "已核验主机身份");
requireText("开发不默认绕过提交钩子", dev, "不得因无关文件阻塞就默认使用`--no-verify`、临时克隆或另一条分支");
const productionConvergence = read("模板交付包/skills/task-ops/references/production-release-and-convergence.md");
requireText("运维允许受控一次性生产数据修复", ops, "有限历史数据可以选择受控一次性修复");
requireText("生产数据修复不降低安全边界", ops, "对象少、归属口头确认或用户希望尽快处理都不能降低生产数据边界");
requireText("一次性修复不强制扩展产品代码", productionConvergence, "一次性修复不要求先扩展通用产品代码");
requireText("一次性修复先做只读发现", productionConvergence, "先执行只读发现或等价预演");
requireText("生产候选包含数据库配置依赖", productionConvergence, "把对应迁移/版本账、运行配置和必需依赖状态纳入同一生产上下文");
requireText("生产健康不替代真实业务", productionConvergence, "HTTP 200 只能证明对应健康事实，不能替代登录、下单、查询、写入");
requireText("用户未验证时不宣称生产完成", productionConvergence, "在收到真实成功证据前不得宣布任务完成、用户可用或生产收敛");
requireText("服务器模板不把裸IP升级为入口", environmentTemplate, "不把裸`账号@IP`、相似别名或历史地址登记成第二个正式入口");
requireText("运维方法仍回原Worker", ops, "正式结果回到同一个 Worker");
requireText("03退出返回根所有者", collaboration, "返回根[AGENTS.md规则所有者]");

for (const removedPath of [
  "模板交付包/skills/task-dev/references/implementation-debugging-and-repair.md",
  "模板交付包/skills/identity-pm/references/cross-task-coordination-and-review.md",
  "模板交付包/skills/task-ops/references/git-worktree-and-resource-closeout.md",
]) {
  if (existsSync(join(repositoryRoot, ...removedPath.split("/")))) {
    errors.push(`旧流程 reference 仍存在：${removedPath}`);
  } else {
    passed += 1;
  }
}

if (errors.length > 0) {
  console.error(`实现路径验证失败：${errors.length} 项；通过 ${passed} 项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`实现路径验证通过：${passed} 项；S1/S2/S3 全部满足短路径规则`);
