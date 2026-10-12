// Narrow real-entry regressions for project facts navigation. No model/callback tests.
// Usage: node scripts/check-initialization-markdown-regressions.mjs --product-root <complete-product> [--keep-scratch]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--product-root");
if (rootIndex < 0 || !args[rootIndex + 1] || args[rootIndex + 1].startsWith("--")) {
  throw new Error("Pass --product-root explicitly; do not substitute a stale source tree for the reviewed candidate.");
}
const productRoot = realpathSync(resolve(args[rootIndex + 1]));
const sourceScript = join(productRoot, "scripts", "beyond-control.mjs");
assert.ok(lstatSync(sourceScript).isFile(), "complete product script must exist");
const sourceSha256 = createHash("sha256").update(readFileSync(sourceScript)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "beyond-markdown-entry-regression-"));
const scratchIdentity = realpathSync(scratch);
const project = join(scratch, "project");
const controlRoot = join(project, "beyond-control");
const results = [];
const excludedTopLevels = new Set([".git", "local", "projects", "shared"]);

function command(commandArgs) {
  const result = spawnSync(process.execPath, [join(controlRoot, "scripts", "beyond-control.mjs"), ...commandArgs], {
    cwd: project, encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function successful(commandArgs) {
  const result = command(commandArgs);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function check(name, action) {
  try {
    const detail = action();
    results.push({ name, passed: true, ...detail });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

function hrefFrom(file, target) {
  return relative(dirname(file), target).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
}

let fatal = null;
try {
  cpSync(productRoot, controlRoot, {
    recursive: true,
    filter: (source) => {
      const nested = relative(productRoot, source).split(/[\\/]/);
      return !excludedTopLevels.has(nested[0]);
    },
  });
  const template = join(controlRoot, "docs", "AI编程协同机制", "项目事实", "README.md");
  const generationTargets = ["full-architecture", "collapsed-architecture", "shortcut-architecture"].map((id) => ({
    id, target: join(controlRoot, "docs", "markdown-regression-fixtures", `${id}.md`),
  }));
  mkdirSync(dirname(generationTargets[0].target), { recursive: true });
  for (const { target } of generationTargets) {
    writeFileSync(target, "# Original source\n\n## Current contract\n\nVerified fixture fact.\n");
  }
  const generationLinks = [
    "[Full architecture][full-architecture]",
    "[collapsed-architecture][]",
    "[shortcut-architecture]",
  ];
  const definitions = generationTargets.map(({ id, target }) => `[${id}]: ${hrefFrom(template, target)}#current-contract`);
  writeFileSync(template, `${readFileSync(template, "utf8")}\n## Isolated reference-style fixtures\n\n${generationLinks.join("\n\n")}\n\n${definitions.join("\n")}\n`);

  const registration = successful(["register-project", "--project-root", project]);
  const projectId = registration.project.projectId;
  successful(["initialization", "--action", "choose", "--project-id", projectId, "--mode", "on-demand", "--approved-by", "isolated Markdown entry regression"]);
  const facts = join(controlRoot, "projects", projectId, "项目事实", "README.md");
  const overview = join(controlRoot, "projects", projectId, "项目总览.md");
  const generated = readFileSync(facts, "utf8");
  const architecture = join(project, "architecture.md");
  writeFileSync(architecture, "# Architecture\n\n## Current contract\n\nCurrent verified architecture.\n");

  function record(target = architecture) {
    return command(["initialization", "--action", "record", "--project-id", projectId,
      "--group", "architecture", "--decision", "register", "--entry", target]);
  }

  // Independent check of these deliberately simple fixture definitions, not the product parser.
  for (const { id, target } of generationTargets) {
    check(`generated index relocates ${id} reference without changing its owner`, () => {
      const match = generated.match(new RegExp(`^\\[${id}\\]:[ \\t]+(<[^>]+>|\\S+)`, "m"));
      assert.ok(match, `generated definition [${id}] missing`);
      const destination = match[1].replace(/^<|>$/g, "");
      const [file, anchor] = destination.split("#");
      assert.equal(resolve(dirname(facts), decodeURIComponent(file)), resolve(target), "generated reference must retain the same source document");
      assert.equal(anchor, "current-contract");
      const result = record(target);
      assert.equal(result.exitCode, 0, result.stderr);
      return { exitCode: result.exitCode };
    });
  }

  const href = hrefFrom(facts, architecture);
  const inline = `[Architecture](${href}#current-contract)`;
  const reference = `[Architecture][arch]\n\n[arch]: ${href}#current-contract`;
  const scenarios = [
    ["inline navigation positive control", inline, true],
    ["full reference navigation", reference, true],
    ["collapsed reference navigation", `[Architecture][]\n\n[Architecture]: ${href}#current-contract`, true],
    ["shortcut reference navigation", `[Architecture]\n\n[Architecture]: ${href}#current-contract`, true],
    ["reference-style image is not navigation", `![Architecture][arch]\n\n[arch]: ${href}#current-contract`, false],
    ["duplicate definitions retain the first valid owner", `[Architecture][arch]\n\n[arch]: ${href}#current-contract\n[arch]: missing-architecture.md`, true],
    ["later duplicate cannot repair the first broken owner", `[Architecture][arch]\n\n[arch]: missing-architecture.md\n[arch]: ${href}#current-contract`, false],
    ["undefined explicit reference cannot fall back to a visible label", `[Architecture][missing]\n\n[Architecture]: ${href}#current-contract`, false],
    ["ordinary blockquote navigation remains valid", `> ${inline}`, true],
    ["ordinary backtick fence is not navigation", `\x60\x60\x60md\n${inline}\n\x60\x60\x60`, false],
    ["quoted text inside an outer fence does not end the outer example", `\x60\x60\x60md\n> quoted example\n${inline}\n\x60\x60\x60`, false],
    ["quoted fence marker inside an outer fence does not close it", `\x60\x60\x60md\n> \x60\x60\x60\n${inline}\n\x60\x60\x60`, false],
    ["ordinary tilde fence is not navigation", `~~~md\n${inline}\n~~~`, false],
    ["list-contained fence is not navigation", `- Example\n\n    \x60\x60\x60md\n    ${inline}\n    \x60\x60\x60`, false],
    ["blockquote-contained fence is not navigation", `> \x60\x60\x60md\n> ${inline}\n> \x60\x60\x60`, false],
    ["blockquote-contained tilde fence is not navigation", `> ~~~md\n> ${inline}\n> ~~~`, false],
    ["HTML pre example is not navigation", `<pre>\n${inline}\n</pre>`, false],
    ["HTML pre/code example is not navigation", `<pre><code>\n${inline}\n</code></pre>`, false],
    ["reference definition in a fence cannot register an outer link", `[Architecture][arch]\n\n\x60\x60\x60md\n[arch]: ${href}\n\x60\x60\x60`, false],
    ["reference use in a fence cannot register an outer definition", `\x60\x60\x60md\n[Architecture][arch]\n\x60\x60\x60\n\n[arch]: ${href}`, false],
    ["unused reference definition is not navigation", `[arch]: ${href}`, false],
    ["unresolved reference is rejected", "[Architecture][missing]", false],
    ["broken reference target is rejected", "[Architecture][arch]\n\n[arch]: missing-architecture.md", false],
    ["wrong reference anchor is rejected", `[Architecture][arch]\n\n[arch]: ${href}#missing-section`, false],
    ["wrong inline anchor is rejected", `[Architecture](${href}#missing-section)`, false],
    ["hidden bad anchor does not poison real navigation", `> \x60\x60\x60md\n> [Example](${href}#missing-section)\n> \x60\x60\x60\n\n${inline}`, true],
    ["leaving a quote-contained fence preserves later real navigation", `> \x60\x60\x60md\n> [Example](${href}#missing-section)\n\n${inline}`, true],
  ];
  for (const [name, body, accepted] of scenarios) {
    check(name, () => {
      const content = `# Facts\n\n${body}\n`;
      writeFileSync(facts, content);
      const beforeOverview = readFileSync(overview);
      const result = record();
      assert.equal(result.exitCode, accepted ? 0 : 2, result.stderr || `unexpected acceptance: ${name}`);
      assert.equal(readFileSync(facts, "utf8"), content, "record must not rewrite the index");
      if (!accepted) assert.ok(beforeOverview.equals(readFileSync(overview)), "rejection must not mutate initialization state");
      return { exitCode: result.exitCode };
    });
  }

  // Existing-project registration is not a request to regenerate its facts index.
  check("re-registration preserves the existing reference-style index", () => {
    writeFileSync(facts, `# Existing facts\n\n${reference}\n`);
    const beforeFacts = readFileSync(facts);
    const beforeOverview = readFileSync(overview);
    successful(["register-project", "--project-root", project]);
    assert.ok(beforeFacts.equals(readFileSync(facts)), "existing index must remain byte-identical");
    assert.ok(beforeOverview.equals(readFileSync(overview)), "existing initialization state must remain byte-identical");
  });
} catch (error) {
  fatal = error.message;
} finally {
  if (!args.includes("--keep-scratch")) {
    if (realpathSync(scratch) !== scratchIdentity || dirname(scratchIdentity) !== realpathSync(tmpdir())
      || !basename(scratchIdentity).startsWith("beyond-markdown-entry-regression-")) {
      throw new Error("Refusing cleanup outside the exact generated scratch directory.");
    }
    rmSync(scratchIdentity, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({
  verdict: !fatal && failed.length === 0 ? "passed" : "failed",
  productRoot, sourceSha256, cases: results.length, passed: results.length - failed.length,
  failed: failed.length, fatal, scratchRetained: args.includes("--keep-scratch") ? scratch : null, results,
}, null, 2));
if (fatal || failed.length) process.exitCode = 1;
