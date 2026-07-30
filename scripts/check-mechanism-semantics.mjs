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
  pm: path.join(deliveryRoot, "skills", "identity-pm", "SKILL.md"),
  dispatch: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "dispatch-and-init.md",
  ),
  closeout: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "lifecycle-and-closeout.md",
  ),
  coordination: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "coordination-and-review.md",
  ),
  worker: path.join(deliveryRoot, "skills", "identity-worker", "SKILL.md"),
  recovery: path.join(
    deliveryRoot,
    "skills",
    "identity-worker",
    "references",
    "lifecycle-and-recovery.md",
  ),
  protocol: path.join(
    deliveryRoot,
    "docs",
    "AI编程协同机制",
    "机制",
    "03-多智能体协同机制.md",
  ),
  workbench: path.join(
    deliveryRoot,
    "docs",
    "AI编程协同机制",
    "当前工作台.md",
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

check("root routes the shared protocol without making it a startup file", () => {
  assert.ok(
    includesAll(text.agents, [
      "`03-多智能体协同机制.md`不是默认启动文档",
      "真实多智能体关系",
    ]),
  );
});

check("PM and Worker define the four once-per-round terminal signals", () => {
  const terminal =
    "`paused / failed / candidate_completed / completed`是每执行回合唯一收口信号";
  assert.ok(text.pm.includes(terminal));
  assert.ok(text.worker.includes(terminal));
});

check("the shared protocol separates terminal return from aggregation", () => {
  assert.ok(
    includesAll(text.protocol, [
      "**聚合知会，不等待 PM**",
      "**终态回源，不等待消费回执**",
      "不进入普通聚合收件箱",
      "送达只证明事件可达，不等于 PM 已消费、裁决或采纳",
    ]),
  );
  assert.doesNotMatch(text.protocol, /聚合知会[^|]*普通终态/u);
});

check("PM coordination uses four event flows and keeps terminal separate", () => {
  assert.ok(
    includesAll(text.coordination, [
      "事件汇流采用四种处理方式",
      "**终态回源**",
      "不进入普通聚合收件箱",
      "终态投递始终服从任务冻结模式",
    ]),
  );
  assert.doesNotMatch(
    text.coordination,
    /聚合知情[^]*?`paused\/failed\/candidate_completed\/completed`/u,
  );
});

check("the workbench stores a cursor without defining another protocol", () => {
  assert.ok(
    includesAll(text.workbench, [
      "本表不重新定义事件分类或投递方式",
      "四类唯一终态按任务冻结的回源模式到达后再登记消费游标",
    ]),
  );
  assert.ok(!text.workbench.includes("非阻塞终态等待批量消费"));
});

check("all three terminal return modes are frozen before dispatch", () => {
  assert.ok(
    includesAll(text.dispatch, [
      "`定向终态消息 / 平台完成观察器 / 明确人工消费`",
      "完整终态正文所在的正式任务最终结果或持久终态入口",
      "消费责任、读取触发和消费游标/幂等依据",
      "只有前两种模式可以承诺自动回传",
    ]),
  );
});

check("Worker executes the frozen mode without silently changing it", () => {
  assert.ok(
    includesAll(text.recovery, [
      "冻结为`定向终态消息`",
      "冻结为`平台完成观察器`",
      "冻结为`明确人工消费`",
      "不因当前工具变化擅自改换冻结模式",
      "定向终态发送失败时保留同一事件 ID",
    ]),
  );
});

check("manual consumption has a durable location and idempotent consumer", () => {
  assert.ok(
    includesAll(text.closeout, [
      "人工消费只从任务契约登记的正式任务最终结果或持久终态入口读取",
      "责任、触发和游标/幂等依据",
      "不使用高频轮询",
    ]),
  );
});

check("delivery, consumption, and adjudication remain separate facts", () => {
  assert.ok(
    includesAll(text.closeout, [
      "终态消息成功投递只证明到达来源",
      "不证明 PM 已消费或裁决",
    ]),
  );
  assert.ok(
    text.protocol.includes(
      "送达只证明事件可达，不等于 PM 已消费、裁决或采纳",
    ),
  );
});

check("cancel and control conflicts remain immediate", () => {
  assert.ok(
    includesAll(text.protocol, [
      "`cancelled`",
      "`red/shared_conflict`",
      "**立即回调并停止受影响动作**",
    ]),
  );
  assert.ok(
    includesAll(text.coordination, [
      "`cancelled`",
      "`red/shared_conflict`",
      "**立即裁决**",
    ]),
  );
});

console.log(`机制语义检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
