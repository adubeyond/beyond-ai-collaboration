// Static documentation structure and bounded contract regression only.
// This does not prove model reading, task continuation, or business delivery.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const product = join(root, "模板交付包");
const docs = join(product, "docs", "AI编程协同机制");
const paths = {
  root: join(product, "AGENTS.md"),
  entry: join(docs, "00-模板入口.md"),
  guide: join(docs, "工程资料指南.md"),
  facts: join(docs, "项目事实", "README.md"),
  product: join(docs, "模板", "产品设计与契约基线模板.md"),
  architecture: join(docs, "模板", "技术架构与核心代码逻辑模板.md"),
  testing: join(docs, "模板", "测试与验收基线模板.md"),
  task: join(docs, "模板", "任务卡模板.md"),
  designSkill: join(product, "skills", "task-design", "SKILL.md"),
  design: join(product, "skills", "task-design", "references", "complex-design-document-and-implementation.md"),
  pm: join(product, "skills", "identity-pm", "SKILL.md"),
  dispatch: join(product, "skills", "identity-pm", "references", "dispatch-and-init.md"),
  dev: join(product, "skills", "task-dev", "SKILL.md"),
  delivery: join(product, "skills", "task-dev", "references", "implementation-delivery-and-failure.md"),
  test: join(product, "skills", "task-test", "SKILL.md"),
  coverage: join(product, "skills", "task-test", "references", "coverage-attribution-and-verdict.md"),
};
const snapshot = new Map(Object.values(paths).map((path) => [path, readFileSync(path, "utf8")]));
const label = (path) => relative(root, path).split(sep).join("/");
const read = (files, path) => files.get(path) ?? readFileSync(path, "utf8");

// The product currently uses inline Markdown links and ATX headings. Ignore
// examples/comments: a pathname or a heading inside a code block is not a route.
function prose(text) {
  let fence = null;
  return text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((line) => {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function localLinks(file, text) {
  return [...prose(text).matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)]
    .map((match) => match[1].trim().replace(/\s+["'][^\n]*$/, "").replace(/^<|>$/g, ""))
    .filter((href) => href && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("//"))
    .map((href) => {
      const hash = href.indexOf("#");
      const path = hash < 0 ? href : href.slice(0, hash);
      const anchor = hash < 0 ? null : decodeURIComponent(href.slice(hash + 1));
      return { path: path ? resolve(dirname(file), decodeURIComponent(path)) : file, anchor };
    });
}

function headingIds(text) {
  const seen = new Map();
  return [...prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
    const base = match[1].replace(/\s+#+\s*$/, "").toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}

function validateLinks(files, sources) {
  for (const source of sources) {
    for (const target of localLinks(source, read(files, source))) {
      assert.ok(existsSync(target.path) && statSync(target.path).isFile(),
        `missing-link: ${label(source)} -> ${label(target.path)}`);
      if (target.anchor) assert.ok(headingIds(read(files, target.path)).includes(target.anchor),
        `missing-anchor: ${label(source)} -> ${label(target.path)}#${target.anchor}`);
    }
  }
}

function hasRoute(files, start, target) {
  const queue = [start], visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current) || !files.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    queue.push(...localLinks(current, files.get(current)).map((link) => link.path));
  }
  return false;
}

function requireLink(files, source, target, code) {
  assert.ok(localLinks(source, read(files, source)).some((link) => link.path === target),
    `${code}: ${label(source)} -> ${label(target)}`);
}

function validateEngineeringRoutes(files) {
  requireLink(files, paths.entry, paths.guide, "entry-guide");
  requireLink(files, paths.facts, paths.guide, "facts-guide");
  for (const target of [paths.product, paths.architecture, paths.testing]) {
    requireLink(files, paths.guide, target, "engineering-owner");
    for (const start of [paths.root, paths.entry, paths.facts]) {
      assert.ok(hasRoute(files, start, target), `unreachable: ${label(start)} -> ${label(target)}`);
    }
  }
}

function changed(files, path, transform) {
  const copy = new Map(files);
  const before = read(files, path), after = transform(before);
  assert.notEqual(after, before, `mutation must change ${label(path)}`);
  copy.set(path, after);
  return copy;
}

function paragraph(files, path, subject) {
  const match = read(files, path).split(/\r?\n\s*\r?\n/).find((part) => subject.test(part));
  assert.ok(match, `missing-rule: ${label(path)} ${subject}`);
  return match;
}

function replaceParagraph(files, path, subject, replacement) {
  const original = paragraph(files, path, subject);
  return changed(files, path, (text) => text.replace(original, replacement));
}

function validateOwnership(files) {
  const rows = prose(read(files, paths.entry)).split("\n").filter((line) => /^\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const task = rows.find(([topic]) => /当前任务|本轮任务/.test(topic) && /进展|反馈|纠偏/.test(topic));
  const engineering = rows.find(([topic]) => /需求.*设计/.test(topic));
  assert.ok(task && engineering, "ownership-rows: task and engineering must have separate owners");
  const primary = (cell) => cell.split(/[；;]/)[0];
  assert.match(primary(task[1]), /任务线程|任务对话/, "task-owner");
  assert.match(primary(engineering[1]), /工程文档|正式正文|项目.*文档/, "engineering-owner");
  assert.doesNotMatch(primary(engineering[1]), /任务卡|任务线程|工作台/, "engineering-owner");
}

// These are deliberately small, bounded prose-contract checks, not a general
// Chinese semantic validator. Keep subject and consequence together, allow
// equivalent phrasing, and test wrong consequences rather than word counts.
const reuseSubject = /已有.*(?:正文|文档)/;
const retentionSubject = /^任务(?:完成|结束|取消|关闭)/;
const scopeSubject = /^(?:Worker|执行者).*(?:局部|补修)/;

function validateReuse(files) {
  const rule = paragraph(files, paths.facts, reuseSubject);
  assert.match(rule, /原(?:位|位置|路径)|原有(?:位置|入口)/, "reuse-existing-owner");
  assert.match(rule, /登记|复用|保留/, "reuse-existing-owner");
  assert.match(rule, /(?:不|无需|无须).{0,8}复制/, "reuse-no-second-copy");
}

function validateRetention(files) {
  const rule = paragraph(files, paths.design, retentionSubject);
  assert.match(rule, /(?:不等于|不意味着|不使|不能决定).{0,35}(?:失效|归档|回收)/,
    "retention-not-task-lifetime");
  assert.match(rule, /(?:仍有效|尚未失效|未被替代)[^\n]*(?:保持|保留|继续)/,
    "retention-valid-content");
}

function validateScope(files) {
  const rule = paragraph(files, paths.dispatch, scopeSubject);
  assert.match(rule, /(?:不能|不得|不应|不可).{0,20}(?:缩|替代|取代).{0,35}(?:局部|补修)/,
    "scope-no-shrinking");
  assert.match(rule, /(?:子任务|独立任务).{0,20}(?:已完成|完成).{0,35}(?:范围|边界)/,
    "scope-independent-result");
  assert.match(rule, /(?:不|不得|不可).{0,15}(?:追加|扩|无限)/, "scope-no-expansion");
}

test("真实文档入口可达工程正文；任务卡不能取代工程所有者", () => {
  validateEngineeringRoutes(snapshot);
  requireLink(snapshot, paths.pm, paths.dispatch, "pm-dispatch");
  requireLink(snapshot, paths.designSkill, paths.design, "design-owner");
  requireLink(snapshot, paths.dev, paths.delivery, "dev-delivery");
  requireLink(snapshot, paths.test, paths.coverage, "test-coverage");
});

test("相关文档的本地链接和标题锚点真实存在", () => {
  validateLinks(snapshot, Object.values(paths));
});

test("目录布局由一个指南章节承载，两个实际入口引用同一可读锚点", () => {
  const anchors = (source) => localLinks(source, read(snapshot, source))
    .filter((link) => link.path === paths.guide && link.anchor).map((link) => link.anchor);
  const entryAnchors = anchors(paths.entry), factsAnchors = anchors(paths.facts);
  assert.ok(entryAnchors.some((anchor) => factsAnchors.includes(anchor)),
    "directory-owner: entry and facts index must share a guide section, not duplicate trees");
});

test("任务与工程正文分别归属，复用原文，保留有效设计并守住本轮范围", () => {
  validateOwnership(snapshot);
  validateReuse(snapshot);
  validateRetention(snapshot);
  validateScope(snapshot);
});

test("负例：把正式链接改成代码路径，不算接通阅读路径", () => {
  const broken = changed(snapshot, paths.entry, (text) =>
    text.replace(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g, (link) =>
      localLinks(paths.entry, link)[0]?.path === paths.guide ? "`工程资料指南.md`" : link));
  assert.throws(() => validateEngineeringRoutes(broken), /entry-guide/);
});

test("负例：产品需求入口误指任务卡，即使文件存在也不能通过", () => {
  const broken = changed(snapshot, paths.guide, (text) =>
    text.replaceAll("模板/产品设计与契约基线模板.md", "模板/任务卡模板.md"));
  validateLinks(broken, [paths.guide]);
  assert.throws(() => validateEngineeringRoutes(broken), /engineering-owner/);
});

test("负例：目标文件存在不能掩盖失效锚点", () => {
  const broken = changed(snapshot, paths.entry, (text) =>
    `${text}\n[坏锚点](工程资料指南.md#不存在的工程资料章节-0f57)\n`);
  assert.throws(() => validateLinks(broken, [paths.entry]), /missing-anchor/);
});

test("负例：长期需求设计交给任务卡，即使其他导航完好也要失败", () => {
  const broken = changed(snapshot, paths.entry, (text) => text.replace(
    /^(\|[^|]*需求[^|]*设计[^|]*\|)[^|]+/m, "$1 当前任务卡；任务结束后回收 "));
  assert.throws(() => validateOwnership(broken), /engineering-owner/);
});

test("负例：已有正文仍强制复制，不能冒充复用", () => {
  const broken = replaceParagraph(snapshot, paths.facts, reuseSubject,
    "项目已有可信的设计文档时，也必须复制到新目录并以副本作为正文。");
  assert.throws(() => validateReuse(broken), /reuse-/);
});

test("负例：任务一结束就归档有效需求设计，不能冒充历史回收", () => {
  const broken = replaceParagraph(snapshot, paths.design, retentionSubject,
    "任务结束后，所有模块需求与设计立即归档；即使内容仍有效也不再保留。");
  assert.throws(() => validateRetention(broken), /retention-not-task-lifetime/);
});

test("负例：最新补修清单不能替代原任务结果", () => {
  const broken = replaceParagraph(snapshot, paths.dispatch, scopeSubject,
    "Worker交付局部结果时，仅按最新补修清单验收，原任务剩余结果不再考虑。");
  assert.throws(() => validateScope(broken), /scope-no-shrinking/);
});

test("反向负例：已完成的获准子任务不能被扩大成模块全部工作", () => {
  const broken = replaceParagraph(snapshot, paths.dispatch, scopeSubject,
    "Worker交付局部结果后，不能把原目标缩成一次局部补修；独立任务完成后按原范围判断，但必须追加所有模块工作。");
  assert.throws(() => validateScope(broken), /scope-no-expansion/);
});

test("等义改写仍通过：关系断言不绑定原句、标题序号或字数", () => {
  let equivalent = replaceParagraph(snapshot, paths.facts, reuseSubject,
    "已有可靠工程正文应保留原位置并登记索引，无需复制。");
  equivalent = replaceParagraph(equivalent, paths.design, retentionSubject,
    "任务结束不意味着工程需求与设计失效；尚未失效的方案应保留原位。");
  equivalent = replaceParagraph(equivalent, paths.dispatch, scopeSubject,
    "执行者交付局部结果后，不得把完整目标缩成补修清单；原获准独立任务完成后按原范围验收，不得追加模块其他工作。");
  validateReuse(equivalent);
  validateRetention(equivalent);
  validateScope(equivalent);
});

test("解析边界：示例和注释不能制造链接或锚点；中文锚点支持重复标题", () => {
  const example = "# 工程资料\n# 工程资料\n```md\n# 示例标题\n[示例](missing.md)\n```\n"
    + "~~~md\n[另一示例](also-missing.md)\n~~~\n<!-- [隐藏](hidden.md) -->\n"
    + "[正文](#%E5%B7%A5%E7%A8%8B%E8%B5%84%E6%96%99-1)\n";
  assert.deepEqual(headingIds(example), ["工程资料", "工程资料-1"]);
  assert.deepEqual(localLinks(paths.guide, example), [{ path: paths.guide, anchor: "工程资料-1" }]);
});
