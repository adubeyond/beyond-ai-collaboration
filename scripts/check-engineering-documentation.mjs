// Static content/navigation regression only; not a model or business-delivery eval.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const product = join(root, "模板交付包");
const docs = join(product, "docs", "AI编程协同机制");
const read = (path) => readFileSync(path, "utf8");
const entry = join(docs, "00-模板入口.md");
const guide = join(docs, "工程资料指南.md");
const facts = join(docs, "项目事实", "README.md");
const templates = [
  "产品设计与契约基线模板.md", "技术架构与核心代码逻辑模板.md",
  "数据与接口设计模板.md", "工程开发基线模板.md", "专题实现与开发指南模板.md",
  "阶段方案与关键决策模板.md", "测试与验收基线模板.md",
  "运行环境与服务器信息模板.md", "部署发布运行手册模板.md", "安全与凭据索引模板.md",
].map((name) => join(docs, "模板", name));

// The delivered documentation uses inline links. Keep this independent from the
// initialization validator, so a generator/parser regression cannot validate itself.
function localLinks(file) {
  const prose = read(file).replace(/```[^\n]*\n[\s\S]*?```/g, "")
    .replace(/<!--[^]*?-->/g, "");
  return [...prose.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)]
    .map((m) => m[1].replace(/^<|>$/g, "").split(/\s+["']/)[0])
    .filter((href) => !/^[a-z]+:/i.test(href))
    .map((href) => {
      const [path, anchor] = href.split("#");
      return { path: path ? resolve(dirname(file), decodeURIComponent(path)) : file,
        anchor: anchor ? decodeURIComponent(anchor) : null };
    });
}

function headingIds(text) {
  const seen = new Map();
  return [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
    const slug = match[1].replace(/\s+#+\s*$/, "").toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const suffix = seen.get(slug) ?? 0;
    seen.set(slug, suffix + 1);
    return suffix ? `${slug}-${suffix}` : slug;
  });
}

function reachable(start, target) {
  const queue = [start], visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file) || !existsSync(file) || !file.endsWith(".md")) continue;
    if (file === target) return true;
    visited.add(file);
    queue.push(...localLinks(file).map((link) => link.path));
  }
  return false;
}

test("根入口、项目文档入口和事实索引能到达工程正文格式", () => {
  for (const start of [join(product, "AGENTS.md"), entry, facts]) {
    assert.ok(reachable(start, guide), `${start} -> 工程资料指南`);
    for (const template of templates) assert.ok(reachable(start, template), `${start} -> ${template}`);
  }
});

test("相关正文的本地链接和标题锚点实际可读，不用路径字样充数", () => {
  const files = [entry, guide, facts, join(docs, "项目总览.md"), ...templates];
  for (const file of files) {
    assert.ok(statSync(file).isFile(), file);
    for (const target of localLinks(file)) {
      assert.ok(existsSync(target.path), `${file} -> ${target.path}`);
      assert.ok(statSync(target.path).isFile(), target.path);
      if (target.anchor) assert.ok(headingIds(read(target.path)).includes(target.anchor),
        `${file} -> ${target.path}#${target.anchor}`);
    }
  }
});

test("工程主题覆盖业务、交互、架构、数据、实现、阶段、测试和运行", () => {
  const text = read(guide);
  for (const topic of ["项目全貌", "需求与业务流程", "产品交互与视觉", "架构与核心逻辑",
    "数据与接口", "工程环境与开发", "阶段方案与关键决策", "测试与验收", "运行与交付", "安全与权限"]) {
    assert.ok(text.includes(`| ${topic} |`), topic);
  }
  for (const concern of ["业务单位", "转换规则", "验证示例", "性能", "容量", "可靠性", "取舍"]) {
    assert.ok(text.includes(concern), concern);
  }
});

test("专题格式的关键工程章节均有正文", () => {
  const coverage = {
    "产品设计与契约基线模板.md": ["业务对象、规则与功能范围", "页面与用户流程", "页面内容与字段责任", "交互、视觉与非功能约束", "验收基线"],
    "技术架构与核心代码逻辑模板.md": ["系统上下文与模块边界", "结构选择与约束", "核心链路", "核心代码逻辑", "数据与状态"],
    "数据与接口设计模板.md": ["业务对象与数据模型", "字段定义、来源与责任", "物理存储与一致性", "输入与输出", "状态、错误与副作用", "兼容与消费者影响", "从契约到验证"],
    "工程开发基线模板.md": ["一项功能落到哪些代码", "扩展与接入位置", "依赖、构建、运行与自测", "可复用示例与常见故障"],
    "专题实现与开发指南模板.md": ["一次实际处理怎样完成", "关键规则、算法与理由", "样例与可验证断言", "复用位置和最小改动面", "接入一种受支持的变化", "调试与验证入口", "常见问题与定位线索"],
    "阶段方案与关键决策模板.md": ["目标、已定方案与当前实现", "阶段路径与依赖", "重要决定与替代关系", "未实施范围与风险", "验证与实施反馈"],
  };
  for (const [name, topics] of Object.entries(coverage)) {
    const text = read(join(docs, "模板", name));
    for (const topic of topics) {
      const section = text.match(new RegExp(`^#{2,3} [^\\n]*${topic}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, "m"));
      assert.ok(section?.[1].trim(), `${name}: ${topic} has a body`);
    }
  }
});

test("已定目标、尚未实现方案、实现事实和活动任务有独立承载", () => {
  const text = read(guide);
  for (const kind of ["| 已确认目标 |", "| 已定方案 / 阶段安排 |", "| 当前实现事实 |"])
    assert.ok(text.includes(kind), kind);
  assert.ok(read(entry).includes("尚未实现的有效阶段设计不是过期任务记录"));
  assert.ok(read(facts).includes("阶段目标、实施依赖和决定理由保留在原方案"));
});

test("接入保留已有正文，不强制填满全部项目资料；业务确认归设计所有者", () => {
  const text = read(guide);
  for (const boundary of ["不是每个项目必须创建的文件清单", "已有项目升级不需要重新初始化所有正文",
    "不以补齐全套资料为开工条件", "没有新知识就不写", "相关性不自动扩大写权限",
    "不新增回传、唤醒、等待、验收或暂停规则"]) assert.ok(text.includes(boundary), boundary);
  assert.ok(text.includes("业务任务的需求确认、技术设计、多模型审查及变更重新确认由`task-design`唯一规定"));
  assert.ok(text.includes("不强制另建PRD、技术设计、实施报告三份文件"));
});

test("PM全局读取与执行者按需下钻继续使用原身份入口", () => {
  const pm = read(join(product, "skills", "identity-pm", "SKILL.md"));
  const worker = read(join(product, "skills", "identity-worker", "SKILL.md"));
  const maintenance = read(join(product, "skills", "identity-worker", "references", "capability-correction-and-cost.md"));
  assert.ok(pm.includes("索引登记的全部当前主事实正文"));
  assert.ok(pm.includes("精确当前所有者"));
  assert.ok(worker.includes("沿已知相关入口补读"));
  assert.ok(maintenance.includes("写入授权"));
  assert.ok(read(guide).includes("PM 点名不是资料白名单"));
});
