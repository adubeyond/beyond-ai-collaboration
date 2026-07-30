import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deliveryRoot = path.join(repositoryRoot, "模板交付包");
const mechanismRoot = path.join(deliveryRoot, "docs", "AI编程协同机制");

const files = {
  agents: path.join(deliveryRoot, "AGENTS.md"),
  readme: path.join(deliveryRoot, "README.md"),
  entry: path.join(mechanismRoot, "00-模板入口.md"),
  workbench: path.join(mechanismRoot, "当前工作台.md"),
  protocol: path.join(
    mechanismRoot,
    "机制",
    "03-多智能体协同机制.md",
  ),
  pm: path.join(deliveryRoot, "skills", "identity-pm", "SKILL.md"),
  pmDispatch: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "dispatch-and-init.md",
  ),
  pmLifecycle: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "lifecycle-and-closeout.md",
  ),
  worker: path.join(deliveryRoot, "skills", "identity-worker", "SKILL.md"),
  workerLifecycle: path.join(
    deliveryRoot,
    "skills",
    "identity-worker",
    "references",
    "lifecycle-and-recovery.md",
  ),
  design: path.join(deliveryRoot, "skills", "task-design", "SKILL.md"),
  dev: path.join(deliveryRoot, "skills", "task-dev", "SKILL.md"),
  test: path.join(deliveryRoot, "skills", "task-test", "SKILL.md"),
  ops: path.join(deliveryRoot, "skills", "task-ops", "SKILL.md"),
  architecture: path.join(repositoryRoot, "docs", "系统架构与运行机制.md"),
};

const text = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, readFileSync(file, "utf8")]),
);
const passed = [];

function check(name, fn) {
  fn();
  passed.push(name);
}

function includesAll(source, fragments) {
  return fragments.every((fragment) => source.includes(fragment));
}

check("pure-model or explicit skip remains the highest routing choice", () => {
  assert.ok(
    includesAll(text.agents, [
      "用户明确要求普通回答、纯分析",
      "直接走清晰请求",
      "不加载身份或动作 Skill",
    ]),
  );
});

check("clear read stays light while first clear write checks ownership once", () => {
  assert.ok(
    includesAll(text.agents, [
      "只读、解释、设计候选和不产生项目写入的清晰请求不读取当前工作台",
      "首次写入采用本机制",
      "这是一次写入隔离检查",
      "不进入项目接手链",
      "所有权检查被平台拒绝或仍无法排除重叠时",
      "不得调用写入工具，也不得运行针对拟议改动的构建、测试或运行时验证",
    ]),
  );
});

check("project takeover reads entry and workbench before stable background", () => {
  assert.ok(
    includesAll(text.agents, [
      "进入[项目文档入口]",
      "首个工具批次只能定点读取文档入口和当前工作台正文",
      "才按文档入口逐项补读",
    ]),
  );
  assert.ok(
    includesAll(text.entry, [
      "先恢复当前主线、任务边界、活动状态、证据和下一步",
      "只有当前工作台不足以说明稳定目标",
      "再补读",
    ]),
  );
});

check("formal execution enters Worker before any action method", () => {
  assert.ok(
    includesAll(text.agents, [
      "正式任务默认使用`identity-worker`",
      "才由同一执行者按当前主要矛盾读取当前动作需要的 Skill",
      "任务包装点名 Action Skill不能替代执行者身份",
    ]),
  );
});

check("one primary action owns release-readiness requests", () => {
  assert.ok(
    includesAll(text.agents, [
      "动作方法初始只选择最贴近当前主要矛盾的一种",
      "用户要判断能否发布、上线、切换环境或回滚时选择运维",
      "已有测试结论只是运维输入",
      "不能因为一句话同时出现“检查、验证、测试、发布”等词就并行加载多种 Action Skill",
    ]),
  );
  assert.ok(
    includesAll(text.test, [
      "“能否发布、上线前检查、生产切换或回滚”按根路由进入 task-ops",
      "已有测试证据只是运维输入",
    ]),
  );
  assert.ok(
    includesAll(text.ops, [
      "当前主要目标是运维、部署、判断能否发布、上线前检查、生产切换、回滚",
      "不为此另起 task-test",
    ]),
  );
});

check("PM controls the mainline without becoming a stage executor", () => {
  assert.ok(
    includesAll(text.pm, [
      "PM 只做控制面",
      "不执行实现、完整测试、发布、Git 写操作",
      "指定唯一任务控制实例",
      "依据一手证据裁决",
      "当前实例只用本身份规则编译任务、门禁和证据要求",
      "不直接运行项目实现、构建、测试或环境命令",
      "不读取对应Action Skill正文",
      "由原Worker接单后读取方法正文",
    ]),
  );
  assert.ok(
    includesAll(text.agents, [
      "当前对话已经建立PM身份时",
      "不在当前PM实例加载对应Action Skill",
      "只有Worker完成接单核验并真实进入该动作后才读取方法正文",
    ]),
  );
});

check("Worker retains one result across method changes and user corrections", () => {
  assert.ok(
    includesAll(text.worker, [
      "无论切换多少方法或经历多少普通失败，你都保有当前任务的控制权和收口责任",
      "用户在当前任务对话中下达指令、回答问题或纠正方向时",
      "用户不需要回到PM重复指令",
    ]),
  );
});

check("design is a method and returns a usable implementation contract", () => {
  assert.ok(
    includesAll(text.design, [
      "不建立新智能体，不改变身份、任务 ID、控制权或授权",
      "做成什么",
      "实现路径",
      "测试路径",
      "发布路径",
      "向原 Worker 返回",
    ]),
  );
});

check("development reuses current contracts and never claims independent test", () => {
  assert.ok(
    includesAll(text.dev, [
      "不建立新智能体，不改变身份、任务 ID、控制权或授权",
      "先检查目标附近的现有模块、公共能力、依赖、调用方式和测试",
      "不复制业务规则，也不为假想未来提前抽象",
      "不把自测、构建或静态检查写成独立测试通过",
      "向原 Worker 返回",
    ]),
  );
});

check("test uses three verdicts and returns failures to the same Worker", () => {
  assert.ok(
    includesAll(text.test, [
      "裁决固定为`通过 / 不通过 / 不能判断`",
      "失败证据先返回原 Worker",
      "不要求 PM 逐轮代派",
      "测试通过也不产生发布、生产或用户可用结论",
    ]),
  );
});

check("ops starts from stable server facts and separates runtime truth", () => {
  assert.ok(
    includesAll(text.ops, [
      "唯一运维事实地基",
      "`运行环境与服务器信息`回答“在哪里”",
      "不可变制品身份与可变运行真值分开",
      "运维方法不发送任务终态、不替PM更新工作台",
      "发布预检只消费已经存在的候选、测试、环境、当前运行版本和回滚证据",
      "不再扫描源码、读取测试正文、重跑测试",
    ]),
  );
});

check("platform policy rejection stops equivalent command retries", () => {
  assert.ok(
    includesAll(text.agents, [
      "平台已经明确拒绝某类命令、工具或权限后",
      "没有新增能力、授权或环境证据时立即按当前证据裁决",
      "不用等价命令、换壳工具、路径改写或重复探测重试",
      "同一验证分支一次只提交一条最接近验收的命令并等待结果",
    ]),
  );
  assert.ok(
    text.test.includes(
      "不换成等价命令、命令壳或运行时探测继续重试",
    ),
  );
  assert.ok(
    text.ops.includes(
      "不用等价测试命令、运行时探测或命令壳继续试探",
    ),
  );
  assert.ok(
    text.worker.includes(
      "仅核对开发条件、入口或计划且当前段未授权执行时，只读现有事实",
    ),
  );
  assert.ok(
    text.dev.includes(
      "需要验证时预先选定一条最接近验收的命令",
    ),
  );
});

check("ordinary failure returns to the actual controller before PM escalation", () => {
  assert.ok(
    includesAll(text.test, [
      "正式任务的失败证据先返回原 Worker",
      "由它决定切开发、切设计、处理环境或停止",
      "直接请求由当前智能体在现有授权内作出同样判断",
      "修复后，正式任务由 Worker、直接请求由当前智能体核对新版本",
    ]),
  );
  assert.ok(
    text.worker.includes(
      "普通构建或测试失败、边界内实现调整和必要回测由你在原任务中解决",
    ),
  );
});

check("multi-agent protocol is conditional and does not replace identities", () => {
  assert.ok(
    includesAll(text.agents, [
      "`03-多智能体协同机制.md`不是默认启动文档",
      "真实多智能体关系",
    ]),
  );
  assert.ok(
    includesAll(text.protocol, [
      "读取本文不会建立身份、创建任务、增加实例或扩大授权",
      "具体规则仍回到唯一所有者",
      "同一 Worker 连续设计、开发、测试、运维",
    ]),
  );
});

check("terminal return, consumption and adjudication are separate", () => {
  assert.ok(
    includesAll(text.protocol, [
      "终态回源，不等待消费回执",
      "送达只证明事件可达，不等于 PM 已消费、裁决或采纳",
    ]),
  );
  assert.ok(
    includesAll(text.pmLifecycle, [
      "终态消息成功投递只证明到达来源",
      "不证明 PM 已消费或裁决",
    ]),
  );
});

check("loss recovery cannot be guessed or used to steal control", () => {
  assert.ok(
    includesAll(text.pmLifecycle, [
      "不是沉默、固定超时或一次消息失败的别名",
      "只有以下事实同时成立时才登记`失联`",
      "只有平台或实际运行证据证明旧实例不能继续产生副作用",
    ]),
  );
  assert.ok(
    includesAll(text.workerLifecycle, [
      "Worker不能判定自己失联",
      "不把“看起来没响应”解释成替补授权",
    ]),
  );
});

check("document lifecycle has one owner and templates have none", () => {
  assert.ok(
    includesAll(text.agents, [
      "项目文档链、缺失处理、事实纠偏、数据与文件归位",
      "文档正文格式",
      "模板不拥有项目事实或治理规则",
    ]),
  );
  assert.ok(
    text.entry.includes(
      "约束项目文档的创建与回收",
    ),
  );
});

check("public architecture matches the actual read paths", () => {
  assert.ok(
    includesAll(text.architecture, [
      "根原则、请求分流、规则所有者和全局实践闭环",
      "最小项目文档链、缺失与冲突处理、事实归位、文档创建和回收",
      "按00先读当前工作台",
      "仅在缺口出现时补项目总览",
      "真正首次写入采用本机制的项目时",
    ]),
  );
  assert.ok(!text.architecture.includes("读取项目总览＋当前工作台"));
  assert.ok(!text.architecture.includes("文档路由、身份与动作路由"));
});

console.log(`全系统真实读取路径检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
