import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillsRoot = path.join(repositoryRoot, "模板交付包", "skills");

const files = {
  design: path.join(skillsRoot, "task-design", "SKILL.md"),
  designAgent: path.join(skillsRoot, "task-design", "agents", "openai.yaml"),
  dev: path.join(skillsRoot, "task-dev", "SKILL.md"),
  devAgent: path.join(skillsRoot, "task-dev", "agents", "openai.yaml"),
  test: path.join(skillsRoot, "task-test", "SKILL.md"),
  testAgent: path.join(skillsRoot, "task-test", "agents", "openai.yaml"),
  ops: path.join(skillsRoot, "task-ops", "SKILL.md"),
  opsAgent: path.join(skillsRoot, "task-ops", "agents", "openai.yaml"),
  worker: path.join(skillsRoot, "identity-worker", "SKILL.md"),
  workerLifecycle: path.join(
    skillsRoot,
    "identity-worker",
    "references",
    "lifecycle-and-recovery.md",
  ),
  opsProduction: path.join(
    skillsRoot,
    "task-ops",
    "references",
    "production-release-and-convergence.md",
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

for (const [name, source] of [
  ["design", text.designAgent],
  ["dev", text.devAgent],
  ["test", text.testAgent],
  ["ops", text.opsAgent],
]) {
  check(`${name} agent prompt distinguishes formal and direct control`, () => {
    assert.ok(
      includesAll(source, [
        "正式 Worker 在任务内",
        "基础智能体处理直接、清晰请求",
        "先确认当前控制关系",
        "不存在正式 Worker 时由当前智能体直接交付用户",
        "不补造 Worker、PM、任务事件或终态回源",
      ]),
    );
    assert.doesNotMatch(source, /只是 Worker 在当前任务内选择的方法/);
  });
}

for (const [name, source] of [
  ["design", text.design],
  ["dev", text.dev],
  ["test", text.test],
  ["ops", text.ops],
]) {
  check(`${name} reference terminology follows the real control relation`, () => {
    assert.ok(
      includesAll(source, [
        "这些专业附录同时适用于正式任务和直接请求",
        "正式任务按文中的Worker关系执行",
        "直接请求由当前智能体承担询问、交付和后续动作",
        "不存在的PM、助手或任务关系不补造",
      ]),
    );
  });
}

check("design returns through the real caller", () => {
  assert.ok(
    includesAll(text.design, [
      "正式任务向原 Worker 返回",
      "直接请求由当前智能体把同一内容交付用户",
      "不制造任务回源",
    ]),
  );
});

check("development can continue directly only under direct authorization", () => {
  assert.ok(
    includesAll(text.dev, [
      "正式任务向原 Worker 返回",
      "直接请求由当前智能体把同一内容交付用户",
      "正式任务由同一 Worker、直接请求由当前智能体切回设计补齐",
      "直接请求由当前智能体在现有授权包含设计时切换设计方法",
      "直接请求只有用户已经明确授权测试",
    ]),
  );
});

check("test failure and next method stay with the real caller", () => {
  assert.ok(
    includesAll(text.test, [
      "正式任务的失败证据先返回原 Worker",
      "直接请求由当前智能体在现有授权内作出同样判断",
      "不补造 Worker 或返工任务",
      "由实际承接请求的智能体按协作规则使用一个局部测试助手",
      "实际承接请求的智能体才选择后续方法",
    ]),
  );
});

check("ops switches methods without inventing a control plane", () => {
  assert.ok(
    includesAll(text.ops, [
      "直接请求只有用户已经明确授权运维动作",
      "只有真实存在PM关系且影响跨任务",
      "正式任务中把证据返回Worker",
      "直接请求则由当前智能体按既有授权判断是否切换",
    ]),
  );
});

check("Worker owns contract-defined cross-round pause", () => {
  assert.ok(
    includesAll(text.worker, [
      "任务契约已经定义的观察/等待窗口确实超过当前执行回合",
      "暂停点、候选状态、已观察事实、下一触发、责任入口和失败升级均已持久化",
      "不能为方便、等待普通结果或释放资源自行制造暂停",
    ]),
  );
});

check("lifecycle package defines pause evidence and direct-task behavior", () => {
  assert.ok(
    includesAll(text.workerLifecycle, [
      "暂停只来自用户或PM的真实控制",
      "任务契约已经预先定义且确实跨越当前执行回合的观察/等待窗口",
      "候选状态、已经观察的时长与事实、下一时间或事件触发",
      "正式任务满足上述条件后发送一次`paused`并释放当前执行回合",
      "直接用户任务只向用户交付暂停现实、下一触发和恢复条件，不制造任务终态",
    ]),
  );
});

check("ops records observation while Worker owns lifecycle", () => {
  assert.ok(
    includesAll(text.opsProduction, [
      "状态只能保持`已发布待验证`或等价候选状态",
      "再把这些事实返回实际承接请求的智能体",
      "正式任务由原Worker按执行者主文件和异常生命周期作业包判断是否满足`paused`",
      "直接请求由当前智能体向用户交付暂停现实和恢复触发，不制造正式任务事件",
    ]),
  );
  assert.ok(!text.opsProduction.includes("然后由原 Worker持久化`paused`"));
});

console.log(`Action双入口与运维暂停语义检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
