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
const pmCoordination = read("模板交付包/skills/identity-pm/references/cross-task-coordination.md");
const pmDispatch = read("模板交付包/skills/identity-pm/references/dispatch-and-init.md");
const pmLifecycle = read("模板交付包/skills/identity-pm/references/lifecycle-and-closeout.md");
const workbench = read("模板交付包/docs/AI编程协同机制/当前工作台.md");
const gitCloseout = read("模板交付包/skills/task-ops/references/git-and-resource-closeout.md");

// S1：普通局部 BUG。
requireText("S1清晰请求不制造任务", agents, "清晰请求不先输出接手确认，不把初始化仪式当成答案，也不凭空制造正式任务");
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
requireText("普通过程不逐步回PM", pm, "不为普通任务逐动作授权、逐阶段续派或设置动作额度");
requireText("正式Worker使用用户可见任务", pm, "创建正式任务时使用平台的用户可见任务入口");
requireText("内部子智能体不冒充正式Worker", pm, "不用内部助手冒充");
requireText("安排其他人包含建任务意图", pm, "该请求已经包含建立用户可见任务的意图");
requireText("明确团队任务不二次确认", pm, "也不再追问是否创建");
requireText("任务包不是执行手册", pm, "任务包是业务契约，不是PM替Worker编写的执行手册");
requireText("任务包默认不编号", pm, "默认不编号、不另起章节");
requireText("任务包不重复系统通则", pm, "系统通则已经生效时不在每个任务中重述");
requireText("PM过程更新不逐步播报", pm, "连续内部步骤不逐条播报");
requireText("PM最终答复保持自包含", pm, "最终答复仍须自包含");
requireText("复杂派单在业务契约闭合后停止", pmDispatch, "PM在业务契约闭合后停止编译");
requireText("复杂任务不扩写章节", pmDispatch, "不因复杂就把字段扩成章节");
requireText("设计检查点不拆第二Worker", pm, "不得再建立一个实施 Worker");
requireText("检查点恢复原Worker", pmLifecycle, "用户确认后恢复原 Worker和现有现场");
requireText("候选讨论没有控制效力", pm, "讨论、建议、候选方案和 PM推断没有控制效力");
requireText("跨任务候选不撤销授权", pmCoordination, "用户确认前不撤销既有授权");
requireText("候选知会保持契约不变", pmCoordination, "候选、尚未生效、当前任务契约不变");
requireText("跨任务机制拒绝未确认候选控制", collaboration, "在确认前不能成为其他任务的新前置、暂停条件或授权变化");
requireText("工作台只保留单一里程碑", workbench, "一个当前业务里程碑");
requireText("工作台不复制任务内部计数", workbench, "路由数、批次、测试计数、命令和多轮尝试不转写到任务行");
requireText("完成任务及时退出高频表", pmLifecycle, "在本次收口或下一次工作台更新中移出高频任务区");
requireText("Worker只回直接PM", pm, "只把平台为该任务实际注入的直接来源 PM");
requireText("PM不下传祖先来源", pm, "不得继续写入 Worker任务包");
requireText("PM不填写回传ID", pm, "不在 Worker任务正文中填写任何 thread ID");
requireText("PM不否定平台回传", pm, "也不写“无需回传”");
requireText("正式任务显式启动Worker和方法", pm, "在新任务初始提示首行同时放`$identity-worker`和一个与当前主要问题匹配的起始 Action Skill");
requireText("起始方法不锁定Worker", pm, "Worker核对现场后仍可切换方法");
requireText("PM不展开方法步骤", pm, "PM不展开方法步骤，也不把起始方法变成第二个任务控制入口");
requireText("局部助手不启动Worker身份", workerCollaboration, "也不得调用`$identity-worker`");
requireText("子智能体只协助原Worker", worker, "子智能体不是新的正式任务或Worker");
requireText("未触及权限不检查", worker, "未触及的维度不检查、不补字段，也不形成暂停");
requireText("默认不用worktree", worker, "BEYOND 不创建或推荐 worktree");
requireText("同目录不等于冲突", pm, "同一目录本身不是冲突");
requireText("同目录边界不重叠可并行", worker, "共享对象不重叠且测试或运行副作用隔离时可以并行编辑和验证");
requireText("共享Git动作串行", worker, "共享 Git工作区的索引、HEAD或历史动作串行");
requireText("只读核对不建正式任务", pm, "只读核对、状态查询、局部判断和 PM能够当轮回答的问题不建立正式任务");
requireText("环境缺口暂停前查正式事实", worker, "相关运行手册和配置，并尝试不扩大风险的既有路径");

// 目标优先：方法按需，独立性和助手只显式/有收益触发，worktree只兼容既有现场。
requireText("根入口任务目标高于流程", agents, "任务目标高于方法流程");
requireText("Worker不按方法拆任务", worker, "不按 Skill、步骤或文件数量机械拆任务");
requireText("Worker首个专业动作加载方法", worker, "进入第一个专业动作前必须完整读取一个与主要问题匹配的 Action Skill");
requireText("Worker不用身份说明替代方法", worker, "不能用 Worker 通用说明代替专业方法，也不一次性预读全部 Skill");
requireText("简单单路径不启助手", worker, "简单、连续、单路径任务由Worker直接完成");
requireText("旧长任务包先收敛业务契约", worker, "旧任务包或上游说明过长时，先收敛为上述六个问题再执行");
requireText("已读方法入口不重复加载", worker, "已经完整读取且未变化的Skill或reference不重复读取");
requireText("根入口低频沟通基线", agents, "预计60秒内完成的简单任务只发一次开工说明和最终交付");
requireText("根入口禁止逐工具播报", agents, "定位、读取、编辑、测试、提交、复核及其准备不逐步播报");
requireText("根入口用户答复先说业务", agents, "面向用户的最终答复先用业务语言说明结果、现在能否使用、影响和下一步");
requireText("根入口只问结果时不展示技术细节", agents, "用户只问结果、进度或能否使用时，不主动展示英文标识、字段名、命令、哈希、分支和文件目录");
requireText("根入口用业务结论替代技术流水", agents, "用“相关测试已通过”“本地代码已完成”“尚未发布”等业务结论代替");
requireText("根入口按用户要求展开技术", agents, "用户明确要求代码、命令和技术证据时才展开");
requireText("Worker继承用户沟通边界", worker, "面向用户的最终交付遵循根入口的用户沟通边界");
requireText("PM收口继承用户沟通边界", pmLifecycle, "按根入口的用户沟通边界收口");
requireText("开发输出不覆盖用户沟通边界", dev, "不覆盖根入口的用户沟通边界");
requireText("测试输出不覆盖用户沟通边界", test, "不覆盖根入口的用户沟通边界");
requireText("运维输出不覆盖用户沟通边界", ops, "不覆盖根入口的用户沟通边界");
requireText("Worker继承根沟通基线", worker, "沟通频率遵循根入口的全局边界");
requireText("Worker回源只传控制面增量", worker, "给PM的回源消息只是控制面增量");
requireText("Worker工程详情留在证据入口", worker, "Worker任务和正式证据入口保存工程详情");
requireText("Worker完成回源保留主线影响", worker, "主线变化与唯一动作");
requireText("Worker回源默认一个主证据入口", worker, "一个主证据或正式落点");
requireText("Worker用户交付保持自包含", worker, "并仍须自包含");
requireText("PM沿主证据入口验收", pmLifecycle, "PM沿其主证据入口定点核验");
requireText("PM不因消息短退回", pmLifecycle, "消息短本身不是证据不足");
requireText("同类高成本动作只刷新易变事实", workerCapability, "后续同类动作复用已经核验的稳定事实，只刷新进程、锁、版本、数据量、服务状态等会变化");
requireText("开发不制造失败测试", dev, "不为流程预先制造失败测试");
requireText("开发方法没有固定过门顺序", dev, "不是必须依次通过的阶段门禁");
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
requireText("健康工作台优先于文档治理入口", agents, "先恢复当前主线、正式任务和下一步");
requireText("文档治理入口只在真实命中时读取", agents, "工作台缺失、仍为空模板、互相冲突，或当前需要处理事实归位、文档创建更新、入口纠偏和历史回收时");
requireText("00入口承接异常文档治理", documentEntry, "只有项目初始化、项目接手发现工作台缺失/冲突或需要处理事实归位、文档创建更新与历史回收");
requireText("升级只做一次兼容核对", agents, "该核对只属于初始化或升级，不进入普通任务热路径");
requireText("升级核对当前直接事实入口", agents, "事实索引及其声明为当前的直接入口");
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
