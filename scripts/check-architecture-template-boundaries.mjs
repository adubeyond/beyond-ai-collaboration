import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deliveryRoot = path.join(repositoryRoot, "模板交付包");
const mechanismRoot = path.join(
  deliveryRoot,
  "docs",
  "AI编程协同机制",
);

const files = {
  architecture: path.join(repositoryRoot, "docs", "系统架构与运行机制.md"),
  readme: path.join(deliveryRoot, "README.md"),
  entry: path.join(mechanismRoot, "00-模板入口.md"),
  factIndex: path.join(mechanismRoot, "项目事实", "README.md"),
  pm: path.join(deliveryRoot, "skills", "identity-pm", "SKILL.md"),
  worker: path.join(
    deliveryRoot,
    "skills",
    "identity-worker",
    "SKILL.md",
  ),
  releaseTemplate: path.join(
    mechanismRoot,
    "模板",
    "发布与回滚模板.md",
  ),
};

const text = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [
    key,
    readFileSync(file, "utf8"),
  ]),
);
const passed = [];

function check(name, fn) {
  fn();
  passed.push(name);
}

function includesAll(source, fragments) {
  return fragments.every((fragment) => source.includes(fragment));
}

check("public architecture exposes both real request paths", () => {
  assert.ok(
    includesAll(text.architecture, [
      "清晰直接请求",
      "当前基础智能体",
      "项目接手或受管任务",
      "$identity-pm",
      "$identity-worker",
      "不生成正式任务事件",
    ]),
  );
});

check("Action Skills remain methods and return to the real controller", () => {
  assert.ok(
    includesAll(text.architecture, [
      "动作 Skill 是当前基础智能体或正式 Worker 选择的方法",
      "不是独立控制者",
      "返回实际控制者重新判断",
      "正式任务回原 Worker",
    ]),
  );
  assert.ok(!text.architecture.includes('VERDICT -->|"普通失败"| DEV'));
});

check("red is not presented as a terminal or automatic pause", () => {
  assert.ok(
    includesAll(text.architecture, [
      "红灯不是业务终态",
      "不自动把整个任务改成`已暂停`",
      "也不自动释放正式 Worker",
    ]),
  );
  assert.ok(!text.architecture.includes("进行中 --> 已暂停: 红灯"));
});

check("public lifecycle points to exact rule owners", () => {
  assert.ok(
    includesAll(text.architecture, [
      "本节只解释概念链，不复制精确状态值、事件值或迁移表",
      "[根 AGENTS.md]",
      "[执行者主入口]",
      "[PM 主入口]",
      "[03-多智能体协同机制]",
    ]),
  );
});

check("release template is record-only and owns no lifecycle", () => {
  assert.ok(
    includesAll(text.releaseTemplate, [
      "只提供单次发布与回滚记录格式",
      "不定义发布授权、Worker 生命周期、PM 控制关系或事件投递",
      "[运维动作入口](../../../skills/task-ops/SKILL.md)",
      "[执行者入口](../../../skills/identity-worker/SKILL.md)",
      "本表只登记已观察事实",
      "不由模板制造控制关系、写入权或事件",
    ]),
  );
  assert.ok(
    !text.releaseTemplate.includes(
      "原 Worker应持久化暂停点并释放当前实例",
    ),
  );
});

check("PM core numbering and project-fact ownership are singular", () => {
  const headings = [...text.pm.matchAll(/^## (\d+)\. /gmu)].map(
    (match) => Number(match[1]),
  );
  assert.deepEqual(headings, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(text.pm.includes("### 7.1 核心正式任务路径"));
  assert.ok(
    includesAll(text.pm, [
      "[项目事实索引第3—5节]",
      "知道标准路径不产生写权限",
      "不建立平行真值",
    ]),
  );
  assert.ok(!text.pm.includes("事实文件写入授权不自动包含"));
});

check("formal Worker cannot infer control-document write access", () => {
  assert.ok(
    includesAll(text.worker, [
      "正式 Worker 默认不修改`当前工作台`、`项目总览`或其他任务的任务主面",
      "不能推导这些控制文档可写",
      "唯一规则所有者和当前任务的准确路径授权同时明确允许",
    ]),
  );
});

check("README routes while entry and fact index retain their domains", () => {
  assert.ok(
    includesAll(text.readme, [
      "不建立第二套启动链",
      "最小项目文档读序、冲突纠偏和历史边界只由该入口定义",
      "清晰直接请求和平台正式任务按根入口各自的定点路径处理",
    ]),
  );
  assert.ok(
    includesAll(text.entry, [
      "提供最小项目文档链",
      "处理文档缺失与事实冲突",
      "约束项目文档的创建与回收",
    ]),
  );
  assert.ok(
    includesAll(text.factIndex, [
      "## 3. 首次创建",
      "## 4. 文件内最小契约",
      "## 5. 登记、更新与回收",
    ]),
  );
});

console.log(`架构、模板与身份边界检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
