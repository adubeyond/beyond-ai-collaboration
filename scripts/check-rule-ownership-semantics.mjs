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
  pm: path.join(deliveryRoot, "skills", "identity-pm", "SKILL.md"),
  dispatch: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "dispatch-and-init.md",
  ),
  design: path.join(deliveryRoot, "skills", "task-design", "SKILL.md"),
  designDelivery: path.join(
    deliveryRoot,
    "skills",
    "task-design",
    "references",
    "contracts-delivery-and-handoff.md",
  ),
  designTemplate: path.join(
    mechanismRoot,
    "模板",
    "复杂业务设计文档模板.md",
  ),
  taskTemplate: path.join(mechanismRoot, "模板", "任务卡模板.md"),
  releaseTemplate: path.join(
    mechanismRoot,
    "模板",
    "发布与回滚模板.md",
  ),
  incidentTemplate: path.join(
    mechanismRoot,
    "模板",
    "运维巡检与故障处理模板.md",
  ),
  handoffTemplate: path.join(
    mechanismRoot,
    "模板",
    "智能体交接包模板.md",
  ),
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

check("root declares one owner for every mechanism layer", () => {
  assert.ok(
    includesAll(text.agents, [
      "### 2.1 规则所有者",
      "项目文档链、缺失处理、事实纠偏、数据与文件归位",
      "项目事实文件的首次创建与维护契约",
      "PM 或执行者的控制权、回复和生命周期",
      "真实多智能体关系中的共享对象、任务接力、公共事件和冲突恢复接口",
      "设计、开发、测试和运维方法",
      "文档正文格式",
    ]),
  );
});

check("document entry owns paths and lifecycle only", () => {
  assert.ok(
    includesAll(text.entry, [
      "本文只负责四件事",
      "提供最小项目文档链",
      "处理文档缺失与事实冲突",
      "确定项目事实的唯一落点",
      "约束项目文档的创建与回收",
    ]),
  );
});

check("README remains navigation rather than governance", () => {
  assert.ok(
    includesAll(text.readme, [
      "README 只提供入口，不另行定义控制、协作或生命周期规则",
      "项目文档的创建、活动期、归位和回收以",
      "项目事实文件的首次创建和维护以",
      "`模板/`只提供正文格式",
    ]),
  );
  assert.doesNotMatch(
    text.readme,
    /PM 是控制面|后台助手不是身份入口|新增文档必须/u,
  );
});

check("PM registers design identity but does not own its filesystem policy", () => {
  assert.ok(
    includesAll(text.pm, [
      "登记唯一活动文档、版本、写入授权、当前消费者和计划归档位置",
      "准确路径、活动期与回收规则以",
      "本 Skill不重复定义",
    ]),
  );
  assert.ok(
    text.dispatch.includes(
      "按[项目文档入口](../../../docs/AI编程协同机制/00-模板入口.md)登记",
    ),
  );
});

check("design method delegates lifecycle to the document owner", () => {
  assert.ok(
    includesAll(text.design, [
      "唯一文档、版本、活动期和归档规则以",
      "第4项只负责设计内容、交付和接力方法",
    ]),
  );
  assert.ok(
    includesAll(text.designDelivery, [
      "由[项目文档入口]",
      "本作业包只规定设计正文",
      "本作业包不另建第二套门禁",
    ]),
  );
});

check("non-owner design paths contain no hard-coded lifecycle directories", () => {
  for (const source of [
    text.pm,
    text.dispatch,
    text.design,
    text.designDelivery,
    text.workbench,
  ]) {
    assert.ok(!source.includes("记录/任务明细"));
    assert.ok(!source.includes("记录/历史任务回收"));
  }
});

check("templates declare format-only status and link the owner", () => {
  assert.ok(
    includesAll(text.designTemplate, [
      "只提供正文格式",
      "不定义路径、授权或生命周期",
      "[项目文档入口](../00-模板入口.md)",
    ]),
  );
  for (const source of [
    text.taskTemplate,
    text.releaseTemplate,
    text.incidentTemplate,
    text.handoffTemplate,
  ]) {
    assert.ok(source.includes("[项目文档入口](../00-模板入口.md)"));
  }
});

check("templates no longer hard-code the history directory", () => {
  for (const source of [
    text.designTemplate,
    text.taskTemplate,
    text.releaseTemplate,
    text.incidentTemplate,
    text.handoffTemplate,
  ]) {
    assert.ok(!source.includes("记录/历史任务回收"));
  }
});

check("workbench stores snapshots and references protocol owners", () => {
  assert.ok(
    includesAll(text.workbench, [
      "本文件是项目当前动态事实的最小快照",
      "本表不重新定义事件分类或投递方式",
      "任务文档的停止追加、归位和回收按",
    ]),
  );
});

check("PM core is shorter without losing its control interface", () => {
  const lines = text.pm.split(/\r?\n/u).length;
  assert.ok(lines <= 210, `PM core has ${lines} lines`);
  assert.ok(
    includesAll(text.pm, [
      "活动项目模型",
      "唯一任务控制实例",
      "终态回源模式",
      "红灯",
      "一手证据",
    ]),
  );
});

console.log(`规则所有权与文档定位检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
