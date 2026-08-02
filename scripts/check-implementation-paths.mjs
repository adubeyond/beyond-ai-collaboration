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
const production = read("模板交付包/skills/task-ops/references/production-release-and-convergence.md");
const documentEntry = read("模板交付包/docs/AI编程协同机制/00-模板入口.md");
const collaboration = read("模板交付包/docs/AI编程协同机制/机制/03-跨任务协同与共享对象机制.md");
const workerCollaboration = read("模板交付包/skills/identity-worker/references/collaboration-and-rework.md");

// S1：普通局部 BUG。
requireText("S1清晰请求不制造任务", agents, "清晰请求不先输出接手确认，不把初始化仪式当成答案，也不凭空制造正式任务");
requireText("S1局部修改不读reference", dev, "清晰局部修改：沿现有组织直接处理，不读 reference");
requireText("S1必要测试不再申请授权", dev, "正式代码任务的验收本身包含必要测试");
requireText("S1普通失败原Worker闭环", worker, "普通测试失败、实现调整、格式化、lint、构建和复测由本 Worker闭环");
requireText("S1本地提交连续交付", dev, "任务自有本地提交属于连续交付");
requireText("S1本地提交不切运维", dev, "不为这一步切换或加载 `task-ops`");
requireText("S1运维不截获本地提交", ops, "普通代码任务自己的本地提交是开发连续交付，不进入本 Skill");

// S2：需要设计的新功能。
requireText("S2设计回原Worker", design, "结果回到同一个 Worker");
requireText("S2复用任务入口", complexDesign, "正式任务直接使用任务已经点名的项目/子项目文档入口和事实索引");
requireText("S2单一活动设计", design, "复杂设计必须使用一个明确的活动设计文档");
requireText("S2同Worker进入开发", complexDesign, "同一个 Worker切换到开发方法继续");
requireText("S2测试失败回原Worker", test, "同一个 Worker切换开发方法修复");

// S3：已授权生产发布。
requireText("S3相同授权不再等待PM", ops, "不等待 PM二次激活");
requireText("S3核验实际目标", ops, "必须重新确认本次目标环境与主机身份");
requireText("S3单一来源四项事实", production, "普通单一来源发布只核对四项");
forbidText("S3不再默认五锚点", production, "五锚点");
forbidText("S3不再默认任务起始基线", production, "任务起始基线 /");
requireText("S3执行者自行远程操作", ops, "不要求用户手工代操作，也不重复索要相同授权");
requireText("S3同任务长观察", ops, "原 Worker转`已暂停`并在同一任务恢复");

// 三场景共同约束。
requireText("普通过程不逐步回PM", pm, "不为普通任务逐动作授权、逐阶段续派或设置动作额度");
requireText("正式Worker使用用户可见任务", pm, "创建正式任务时使用平台的用户可见任务入口");
requireText("内部子智能体不冒充正式Worker", pm, "不用内部助手冒充");
requireText("安排其他人包含建任务意图", pm, "该请求已经包含建立用户可见任务的意图");
requireText("Worker只回直接PM", pm, "只把平台为该任务实际注入的直接来源 PM");
requireText("PM不下传祖先来源", pm, "不得继续写入 Worker任务包");
requireText("PM不填写回传ID", pm, "不在 Worker任务正文中填写任何 thread ID");
requireText("PM不否定平台回传", pm, "也不写“无需回传”");
requireText("正式任务显式启动Worker", pm, "把`$identity-worker`放在新任务初始提示的首行");
requireText("局部助手不启动Worker身份", workerCollaboration, "也不得调用`$identity-worker`");
requireText("子智能体只协助原Worker", worker, "内部子智能体只协助当前 Worker");
requireText("未触及权限不检查", worker, "未触及的维度不检查、不补字段，也不形成暂停");
requireText("默认不用worktree", worker, "BEYOND 不自动创建 worktree");
requireText("同目录不等于冲突", pm, "同一目录本身不是冲突");
requireText("同目录边界不重叠可并行", worker, "共享对象不重叠且测试或运行副作用隔离时可以并行编辑和验证");
requireText("共享Git动作串行", worker, "共享 Git工作区的索引、HEAD或历史动作串行");
requireText("只读核对不建正式任务", pm, "只读核对、状态查询、局部判断和 PM能够当轮回答的问题不建立正式任务");
requireText("环境缺口暂停前查正式事实", worker, "相关运行手册和配置，并尝试不扩大风险的既有路径");

// 冷启动与定位压缩不能改变实际责任。
requireText("健康工作台优先于文档治理入口", agents, "先恢复当前主线、正式任务和下一步");
requireText("文档治理入口只在真实命中时读取", agents, "工作台缺失、仍为空模板、互相冲突，或当前需要处理事实归位、文档创建更新、入口纠偏和历史回收时");
requireText("00入口承接异常文档治理", documentEntry, "只有项目初始化、项目接手发现工作台缺失/冲突或需要处理事实归位、文档创建更新与历史回收");
requireText("设计方法仍回原Worker", design, "正式结果回到同一个 Worker");
requireText("开发方法仍回原Worker", dev, "正式结果回到同一个 Worker");
requireText("测试方法仍回原Worker", test, "正式证据和裁决回到同一个 Worker");
requireText("运维方法仍回原Worker", ops, "正式结果回到同一个 Worker");
requireText("03退出返回根所有者", collaboration, "返回根[AGENTS.md规则所有者]");

if (errors.length > 0) {
  console.error(`实现路径验证失败：${errors.length} 项；通过 ${passed} 项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`实现路径验证通过：${passed} 项；S1/S2/S3 全部满足短路径规则`);
