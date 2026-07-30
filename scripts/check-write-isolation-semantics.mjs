import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deliveryRoot = path.join(repositoryRoot, "模板交付包");

const files = {
  agents: path.join(deliveryRoot, "AGENTS.md"),
  dev: path.join(deliveryRoot, "skills", "task-dev", "SKILL.md"),
  dispatch: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "dispatch-and-init.md",
  ),
  workbench: path.join(
    deliveryRoot,
    "docs",
    "AI编程协同机制",
    "当前工作台.md",
  ),
  protocol: path.join(
    deliveryRoot,
    "docs",
    "AI编程协同机制",
    "机制",
    "03-多智能体协同机制.md",
  ),
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

check("read-only clear requests stay on the light path", () => {
  assert.ok(
    includesAll(text.agents, [
      "只读、解释、设计候选和不产生项目写入的清晰请求不读取当前工作台",
      "默认不展开当前工作台、项目总览、历史、全仓资料",
    ]),
  );
});

check("first direct write performs one ownership check without takeover", () => {
  assert.ok(
    includesAll(text.agents, [
      "首次写入采用本机制",
      "只把该文件的活动任务表当作写入所有权线索",
      "这是一次写入隔离检查",
      "不建立PM或Worker身份",
      "不进入项目接手链",
      "不沿工作台链接扩读",
    ]),
  );
});

check("non-overlapping writes continue and overlapping writes return to owner", () => {
  assert.ok(
    includesAll(text.agents, [
      "没有显示其他写入者时继续",
      "明确重叠时回到已有任务实例或由PM协调",
      "不能由清晰请求静默抢占",
    ]),
  );
});

check("stale workbench is a clue rather than absolute runtime truth", () => {
  assert.ok(
    includesAll(text.agents, [
      "工作台缺失、过期或不足以判断时",
      "更近的平台任务与实际工作区事实",
      "只停止仍无法排除重叠的目标写入",
      "不扩大为全项目扫描",
    ]),
  );
  assert.ok(text.workbench.includes("它不是实时运行现场"));
});

check("mixed takeover and modification still takes the project path", () => {
  assert.ok(
    includesAll(text.agents, [
      "同一输入同时满足多类时，采用序号在前的路径",
      "**项目接手**",
      "即使同时提出了清晰问题，也先恢复该项目的当前事实",
    ]),
  );
});

check("development applies the root ownership probe without duplicating it", () => {
  assert.ok(
    includesAll(text.dev, [
      "不强制补工作台任务行",
      "执行根`AGENTS.md`规定的一次最小写入所有权检查",
      "不把清晰请求升级成项目接手",
    ]),
  );
  assert.ok(!text.dev.includes("活动任务表中与目标有关的控制实例"));
});

check("workbench exposes the minimum ownership fields", () => {
  assert.ok(
    includesAll(text.workbench, [
      "任务控制实例",
      "唯一任务主面",
      "读写边界",
      "活动任务",
    ]),
  );
});

check("shared protocol still forbids concurrent ownership", () => {
  assert.ok(
    includesAll(text.protocol, [
      "一个业务任务同一时刻只能有一个任务控制实例",
      "先确定唯一写入者或互不重叠的写入边界",
      "未闭合前不得并发写入",
    ]),
  );
});

check("dirty starting state requires explicit user or task intent", () => {
  assert.ok(
    includesAll(text.dispatch, [
      "只有用户或正式任务事实明确要求",
      "才把该现场指定为任务 starting state",
      "不得为方便继承聊天上下文、复用本机改动或节省初始化而擅自复制 dirty 现场",
      "未明确要求时使用平台或项目正式基线",
    ]),
  );
});

check("public architecture describes the same direct-write guard", () => {
  assert.ok(
    includesAll(text.architecture, [
      "不等于可以抢占已有任务",
      "真正首次写入采用本机制的项目时",
      "无冲突时直接完成",
      "目标已经属于活动任务时回到原任务",
    ]),
  );
});

console.log(`清晰写入与任务起点检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
