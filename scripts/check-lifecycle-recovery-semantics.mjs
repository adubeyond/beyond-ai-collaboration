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
  pm: path.join(deliveryRoot, "skills", "identity-pm", "SKILL.md"),
  closeout: path.join(
    deliveryRoot,
    "skills",
    "identity-pm",
    "references",
    "lifecycle-and-closeout.md",
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

check("business, instance, and consumed state remain separate", () => {
  assert.ok(
    includesAll(text.closeout, [
      "**业务状态**",
      "**实例状态**",
      "**PM 已消费控制快照**",
      "`待领取 / 执行中 / 等待事件 / 待回收 / 已关闭 / 失联`",
    ]),
  );
});

check("silence and fixed timeout do not prove loss", () => {
  assert.ok(
    includesAll(text.closeout, [
      "正式任务控制实例的`失联`需要外部控制证据",
      "不是沉默、固定超时或一次消息失败的别名",
      "暂时无新消息、超过预计时长",
      "都不充分",
    ]),
  );
  assert.ok(
    includesAll(text.recovery, [
      "正式任务控制实例无消息、等待超出预期、消息发送失败",
      "都不能让 Worker 宣布原正式实例`失联`",
    ]),
  );
});

check("only an external control path can trigger a bounded loss audit", () => {
  assert.ok(
    includesAll(text.closeout, [
      "平台生命周期/完成观察器",
      "活动PM",
      "发起一次有界正式控制实例失联核对",
      "PM不为发现失联持续轮询",
    ]),
  );
  assert.ok(text.recovery.includes("Worker不能判定自己失联"));
});

check("Worker still controls loss and replacement of its local helper", () => {
  assert.ok(
    includesAll(text.closeout, [
      "Worker控制的局部助手不是正式任务控制实例",
      "由原Worker按协作作业包核验",
      "不把助手失效升级成PM对正式Worker的失联裁决",
    ]),
  );
  assert.ok(
    includesAll(text.recovery, [
      "当前Worker自己控制的局部助手失效时",
      "[协作与返工作业包](collaboration-and-rework.md)",
      "这不产生新的正式任务控制实例",
    ]),
  );
});

check("loss requires missing control, no terminal, and evidence", () => {
  assert.ok(
    includesAll(text.closeout, [
      "异常终止、已不存在、不可恢复",
      "没有与当前任务、版本和执行回合匹配的有效终态或正式控制移交",
      "核对证据带实际来源、发生时间、平台或运行事实",
    ]),
  );
});

check("unknown liveness blocks overlap without inventing loss", () => {
  assert.ok(
    includesAll(text.closeout, [
      "无法判断是否仍在运行",
      "`待补证据`作为证据条件",
      "停止可能与旧实例重叠的写入或共享动作",
    ]),
  );
});

check("replacement waits for old-side shutdown and workspace transfer", () => {
  assert.ok(
    includesAll(text.closeout, [
      "旧实例不能继续产生副作用",
      "唯一工作区已经隔离、关闭或明确移交",
      "沿用业务任务ID、递增执行回合",
      "不创建并发替补",
    ]),
  );
});

check("a replacement refreshes facts and preserves old evidence", () => {
  assert.ok(
    includesAll(text.closeout, [
      "重新核对当前契约、授权、易变事实和未完成动作",
      "不复用旧事件ID",
    ]),
  );
});

check("blocking claim waits once and exits without fake state", () => {
  assert.ok(
    includesAll(text.recovery, [
      "只做一次平台有界等待",
      "有界等待结束仍无结果",
      "停止新增副作用",
      "不冒充`已关闭`或`失联`",
      "不重复发送同一领取事件",
    ]),
  );
});

check("PM loss requires platform or user recovery", () => {
  assert.ok(
    includesAll(text.closeout, [
      "活动PM不能证明自己已经失联",
      "只能由平台或用户从控制面外部恢复或建立替代PM",
      "Worker、Action Skill或协作实例都不能因PM无响应而晋升为PM",
    ]),
  );
  assert.ok(text.pm.includes("同一项目同一主线只能有一个活动的 PM 写控制者"));
});

check("shared protocol and workbench do not become second lifecycle owners", () => {
  assert.ok(text.protocol.includes("一个业务任务同一时刻只能有一个任务控制实例"));
  assert.ok(
    includesAll(text.workbench, [
      "本文件是项目当前动态事实的最小快照",
      "身份内部的控制权与生命周期由对应身份 Skill 负责",
    ]),
  );
  assert.ok(!text.protocol.includes("固定超时"));
  assert.ok(!text.workbench.includes("失联判定"));
});

console.log(`失联与恢复语义检查通过：${passed.length}/${passed.length}`);
for (const name of passed) {
  console.log(`PASS ${name}`);
}
