import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv.indexOf("--product-root");
if (argument >= 0 && !process.argv[argument + 1]) throw new Error("--product-root requires a complete product directory");
const productRoot = resolve(argument < 0 ? join(repositoryRoot, "模板交付包") : process.argv[argument + 1]);
const productScript = join(productRoot, "scripts", "beyond-control.mjs");
if (!fs.existsSync(productScript)) throw new Error(`Product entry not found: ${productScript}`);
const productHash = createHash("sha256").update(fs.readFileSync(productScript)).digest("hex");
const scratch = fs.mkdtempSync(join(tmpdir(), "beyond-project-preimages-"));
const preload = join(scratch, "fault-preload.mjs");
const errors = [];
let passed = 0;

// Only child processes are instrumented. Product files and the caller's fs API stay unchanged.
fs.writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
const original = Object.fromEntries(["cpSync", "copyFileSync", "writeFileSync", "readFileSync", "readdirSync"].map(name => [name, fs[name]]));
const fault = process.env.BEYOND_PREIMAGE_FAULT || "";
const local = resolve(process.env.BEYOND_PREIMAGE_LOCAL);
const cache = resolve(local, "test-cache");
const key = value => typeof value === "string" ? resolve(value).replace(/\\\\/g, "/").toLowerCase() : "";
const localKey = key(local);
const cacheKey = key(cache);
const fail = code => { process.stderr.write("PREIMAGE-FAULT:" + code + "\\n"); throw Object.assign(new Error("injected " + code), { code }); };
const guard = value => {
  const path = key(value);
  if (process.env.BEYOND_PREIMAGE_GUARD === "yes" && (path === cacheKey || path.startsWith(cacheKey + "/"))) fail("UNRELATED_CACHE_READ");
};
fs.cpSync = (source, destination, ...rest) => {
  guard(source);
  if (process.env.BEYOND_PREIMAGE_GUARD === "yes" && key(source) === localKey) fail("WHOLE_LOCAL_COPY");
  const output = key(destination);
  if (output.includes("-project-preimage-") && fault === "copy-enospc") fail("ENOSPC");
  if (output.includes("-project-preimage-") && output.includes("/control/local/") && fault === "copy-eacces") fail("EACCES");
  return original.cpSync(source, destination, ...rest);
};
fs.copyFileSync = (source, destination, ...rest) => {
  guard(source);
  const output = key(destination);
  if (fault === "compat-copy" && output.includes("/local/backups/project-entry/") && output.endsWith("-project-hooks.json")) fail("COMPAT_COPY_EACCES");
  return original.copyFileSync(source, destination, ...rest);
};
fs.writeFileSync = (file, ...rest) => {
  if (fault === "manifest-write" && key(file).endsWith("/project-preimage.json")) fail("MANIFEST_ENOSPC");
  return original.writeFileSync(file, ...rest);
};
for (const name of ["readFileSync", "readdirSync"]) fs[name] = (file, ...rest) => { guard(file); return original[name](file, ...rest); };
syncBuiltinESMExports();
`, "utf8");

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `: ${detail}` : ""}`);
}
function scenario(name, action) {
  try { action(); }
  catch (error) { errors.push(`${name}: ${error.stack ?? error.message}`); }
}
function write(file, content) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function normalized(file) { return resolve(file).replace(/\\/g, "/").toLowerCase(); }
function children(root) { return fs.existsSync(root) ? fs.readdirSync(root).sort() : []; }
function digestTree(root, excluded = []) {
  const result = {};
  if (!fs.existsSync(root)) return { ".": "absent" };
  const excludes = excluded.map(normalized);
  function visit(file) {
    if (excludes.some(exclude => normalized(file) === exclude)) return;
    const info = fs.lstatSync(file);
    const key = relative(root, file).replace(/\\/g, "/") || ".";
    if (info.isSymbolicLink()) result[key] = `link:${fs.readlinkSync(file)}`;
    else if (info.isDirectory()) {
      result[key] = "directory";
      for (const child of children(file)) visit(join(file, child));
    } else result[key] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  visit(root);
  return result;
}
function formalState(fixture) {
  return digestTree(fixture.project, [join(fixture.project, ".beyond-local-backups"), join(fixture.control, "local", "backups")]);
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function command(fixture, args, { fault = "", guard = true } = {}) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(fixture.control, "scripts", "beyond-control.mjs"), ...args], {
    cwd: fixture.control, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, BEYOND_PREIMAGE_FAULT: fault, BEYOND_PREIMAGE_GUARD: guard ? "yes" : "no", BEYOND_PREIMAGE_LOCAL: join(fixture.control, "local") },
  });
}
function successful(fixture, args, options) {
  const result = command(fixture, args, options);
  if (result.status !== 0 || result.error) throw new Error(`${args[0]} failed (${result.status}): ${result.error ?? result.stderr ?? result.stdout}`);
  return result;
}
function install(fixture, options = {}) {
  return command(fixture, ["install-project-entry", "--project-root", fixture.project, "--confirm-fusion", "yes", ...(fixture.legacy ? ["--adopt-legacy-workbench", "yes"] : [])], options);
}
function hooks(native) {
  return JSON.stringify({ keep: "native-setting", hooks: { SessionStart: [{ hooks: [
    ...(native ? [{ type: "command", command: "node .codex/native.mjs" }] : []),
    { type: "command", command: "node .codex/beyond-runtime-guard.mjs" },
  ] }] } });
}
function fixture(name, legacy = false) {
  const project = join(scratch, name, "project");
  const control = join(project, "beyond-control");
  fs.cpSync(productRoot, control, { recursive: true });
  const git = spawnSync("git", ["init", project], { encoding: "utf8", windowsHide: true });
  if (git.status !== 0) throw new Error(`Fixture git init failed: ${git.stderr}`);
  write(join(project, "AGENTS.md"), "# Native project entry\r\n\r\nKeep the original rule.\r\n");
  write(join(project, ".gitignore"), "/project-only-cache/\n");
  write(join(control, ".gitignore"), "/control-only-cache/\n");
  write(join(control, "local", "当前工作台.md"), fs.readFileSync(join(control, "docs", "AI编程协同机制", "当前工作台.md"), "utf8"));
  for (const [root, native] of [[project, true], [control, false]]) {
    write(join(root, ".codex", "hooks.json"), hooks(native));
    write(join(root, ".codex", "beyond-runtime-guard.mjs"), "// BEYOND_RUNTIME_IDENTITY fixture\n");
  }
  for (const path of ["identity-sessions/old.json", "hook-probes/old.json", "hook-observed.json"]) {
    write(join(control, "local", "runtime", path), JSON.stringify({ retainedPreimage: path }));
  }
  write(join(control, "local", "test-cache", "do-not-copy.txt"), "Unrelated task cache must not be visited.\n");
  if (legacy) write(join(project, "docs", "AI编程协同机制", "当前工作台.md"), `# 当前工作台
### 1.2 正式任务表
| 任务 / 业务结果 | 负责人 / 正式 thread | 状态 | 当前进度 | 暂停原因与恢复条件 | 正式结果 / 证据入口 | 更新时间 |
| --- | --- | --- | --- | --- | --- | --- |
| 旧活动任务 | Worker-legacy-active | 进行中 | 原进度 | 无 | 无 | 2026-08-01 |
| 旧完成任务 | Worker-legacy-complete | 已完成 | 已完成 | 无 | old-evidence | 2026-08-01 |
`);
  const item = { project, control, legacy, snapshots: join(project, ".beyond-local-backups", "beyond-control") };
  item.id = JSON.parse(successful(item, ["inspect-project", "--project-root", project]).stdout).projectId;
  item.registration = join(control, "local", "projects", `${item.id}.md`);
  item.cloneField = 'execution_clone_manifests_json: ["isolated-clones/manifest.json"]';
  write(item.registration, `---\nid: ${item.id}\nname: fixture\npath: ${project.replace(/\\/g, "/")}\nremote: \n${item.cloneField}\n---\n\n# Old registration\n`);
  write(join(control, "shared", "projects", `${item.id}.md`), `---\nid: ${item.id}\nname: fixture\nremote: \n---\n\n# Existing shared registration\n`);
  item.overview = join(control, "projects", item.id, "项目总览.md");
  item.facts = join(control, "projects", item.id, "项目事实", "README.md");
  write(item.overview, "# Existing business overview\n\nBusiness boundary must survive.\n");
  write(item.facts, "# Existing facts index\n\nKeep the established engineering entry.\n");
  if (legacy) write(join(control, "local", "history", "legacy", `${item.id}-workbench.md`), "# Prior legacy history, preserve its preimage.\n");
  return item;
}
scenario("normal and repeated installation", () => {
  const item = fixture("normal");
  const originals = new Map([
    join(item.project, "AGENTS.md"), join(item.project, ".gitignore"), join(item.control, ".gitignore"),
    item.registration, join(item.control, "shared", "projects", `${item.id}.md`), item.overview, item.facts,
    ...[item.project, item.control].flatMap(root => [join(root, ".codex", "hooks.json"), join(root, ".codex", "beyond-runtime-guard.mjs")]),
    ...["identity-sessions", "hook-probes", "hook-observed.json"].map(path => join(item.control, "local", "runtime", path)),
    join(item.control, "local", "当前工作台.md"),
  ].map(file => [file, digestTree(file)]));
  const originalFacts = fs.readFileSync(item.facts, "utf8");
  const result = install(item);
  check("installation succeeds without reading or copying unrelated local cache", result.status === 0, result.stderr);
  if (result.status !== 0) return;
  const installed = JSON.parse(result.stdout);
  // Existence was captured before deletion; compare source identity separately from current state.
  const manifest = JSON.parse(fs.readFileSync(join(installed.preimage, "project-preimage.json"), "utf8"));
  check("snapshot explicitly identifies project-preimage and project", manifest.kind === "project-preimage" && manifest.projectId === item.id && Array.isArray(manifest.objects));
  for (const [file, expected] of originals) {
    const object = manifest.objects.find(entry => normalized(entry.path) === normalized(file));
    check(`complete original retained: ${relative(item.project, file)}`, object?.existed === true && same(expected, digestTree(join(installed.preimage, object.saved))));
  }
  check("new machine state absence is recorded", manifest.objects.some(object => object.saved === "control/local/runtime/workbench/workbench-state.json" && object.existed === false));
  check("exactly one external snapshot for first install", children(item.snapshots).length === 1 && basename(installed.preimage).includes("-project-preimage-entry"));
  check("unrelated cache is not copied into exact snapshot", !Object.keys(digestTree(installed.preimage)).some(path => path.includes("test-cache")));
  check("clone manifest metadata survives install", fs.readFileSync(item.registration, "utf8").includes(item.cloneField));
  check("existing business overview and facts index survive", fs.readFileSync(item.overview, "utf8").includes("Business boundary must survive.") && fs.readFileSync(item.facts, "utf8") === originalFacts);
  check("legacy cleanup happens only after preserving originals", ["identity-sessions", "hook-probes", "hook-observed.json"].every(path => !fs.existsSync(join(item.control, "local", "runtime", path))) && !fs.existsSync(join(item.project, ".codex", "beyond-runtime-guard.mjs")));
  const projectHooks = fs.readFileSync(join(item.project, ".codex", "hooks.json"), "utf8");
  check("native hook survives legacy handler cleanup", projectHooks.includes("native.mjs") && !projectHooks.includes("beyond-runtime-guard.mjs"));
  const second = install(item);
  check("repeated install succeeds", second.status === 0, second.stderr);
  check("repeat adds one exact snapshot and no whole-local snapshots", children(item.snapshots).length === 2 && children(item.snapshots).every(name => name.includes("-project-preimage-entry")));
  const beforeRestore = formalState(item);
  const beforeSnapshots = children(item.snapshots);
  const refused = command(item, ["restore-local", "--snapshot", installed.preimage, "--confirm-restore", "yes"]);
  check("complete preimage is not accepted as a full local restore", refused.status !== 0 && refused.stderr.includes("不能作为整个local快照恢复"));
  check("rejected complete-preimage restore makes no changes", same(beforeRestore, formalState(item)) && same(beforeSnapshots, children(item.snapshots)));
});

for (const [fault, marker] of [["copy-enospc", "ENOSPC"], ["copy-eacces", "EACCES"], ["manifest-write", "MANIFEST_ENOSPC"], ["compat-copy", "COMPAT_COPY_EACCES"]]) scenario(fault, () => {
  const item = fixture(fault);
  const before = formalState(item);
  const result = install(item, { fault });
  check(`${fault}: injected failure was reached`, result.status !== 0 && result.stderr.includes(`PREIMAGE-FAULT:${marker}`), result.stderr);
  check(`${fault}: no formal file or directory changed`, same(before, formalState(item)));
  check(`${fault}: control Git was not initialized`, !fs.existsSync(join(item.control, ".git")));
  const snapshots = children(item.snapshots);
  check(`${fault}: one identifiable backup directory, no whole-local copy`, snapshots.length === 1 && snapshots[0].includes("-project-preimage-entry"));
  if (snapshots.length === 1 && fault !== "compat-copy") {
    const partial = join(item.snapshots, snapshots[0]);
    check(`${fault}: partial has no success manifest`, !fs.existsSync(join(partial, "project-preimage.json")));
    const unchanged = formalState(item);
    const refused = command(item, ["restore-local", "--snapshot", partial, "--confirm-restore", "yes"]);
    check(`${fault}: partial snapshot restore is refused`, refused.status !== 0 && refused.stderr.includes("不能作为整个local快照恢复"));
    check(`${fault}: failed restore leaves originals and snapshot count unchanged`, same(unchanged, formalState(item)) && same(snapshots, children(item.snapshots)));
  }
});

scenario("standalone registration", () => {
  const item = fixture("register");
  const before = formalState(item);
  const rejected = command(item, ["register-project", "--project-root", item.project], { fault: "manifest-write" });
  check("standalone register backup failure precedes ensureControl", rejected.status !== 0 && rejected.stderr.includes("PREIMAGE-FAULT:MANIFEST_ENOSPC") && same(before, formalState(item)));
  const existingSnapshots = children(item.snapshots).length;
  const result = successful(item, ["register-project", "--project-root", item.project]);
  const registered = JSON.parse(result.stdout);
  check("standalone register adds just one precise snapshot", children(item.snapshots).length === existingSnapshots + 1 && fs.existsSync(join(registered.localBackup, "project-preimage.json")));
  check("standalone register preserves execution-clone declarations", fs.readFileSync(item.registration, "utf8").includes(item.cloneField));
});

scenario("legacy adoption", () => {
  const item = fixture("legacy", true);
  const history = join(item.control, "local", "history", "legacy", `${item.id}-workbench.md`);
  const originalHistory = digestTree(history);
  const result = install(item);
  check("legacy adoption succeeds without copying unrelated local cache", result.status === 0, result.stderr);
  if (result.status !== 0) return;
  const adopted = JSON.parse(result.stdout);
  check("legacy adoption reuses the sole exact preimage", children(item.snapshots).length === 1 && adopted.adoption?.imported === 1 && normalized(adopted.adoption.backup) === normalized(adopted.preimage));
  const manifest = JSON.parse(fs.readFileSync(join(adopted.preimage, "project-preimage.json"), "utf8"));
  const historyObject = manifest.objects.find(object => normalized(object.path) === normalized(history));
  check("legacy history original is preserved in exact preimage", historyObject?.existed === true && same(originalHistory, digestTree(join(adopted.preimage, historyObject.saved))));
  check("legacy migration adds only its expected business records", fs.readFileSync(history, "utf8").includes("old-evidence") && fs.readFileSync(join(item.control, "local", "当前工作台.md"), "utf8").includes("Worker-legacy-active"));
});

scenario("manual full backup and restore remain supported", () => {
  const item = fixture("manual");
  const marker = join(item.control, "local", "manual-preservation.txt");
  write(marker, "before manual backup\n");
  const result = successful(item, ["backup-local", "--reason", "manual-regression"], { guard: false });
  const snapshot = result.stdout.trim();
  check("manual backup is still a full local snapshot", fs.existsSync(join(snapshot, "manual-preservation.txt")) && fs.existsSync(join(snapshot, "test-cache", "do-not-copy.txt")) && !fs.existsSync(join(snapshot, "project-preimage.json")));
  write(marker, "changed after backup\n");
  write(join(item.control, "local", "created-after-backup.txt"), "must disappear on explicit restore\n");
  const restored = command(item, ["restore-local", "--snapshot", snapshot, "--confirm-restore", "yes"], { guard: false });
  check("manual full snapshot restore succeeds", restored.status === 0, restored.stderr);
  check("manual restore recovers original bytes and original absence", fs.readFileSync(marker, "utf8") === "before manual backup\n" && !fs.existsSync(join(item.control, "local", "created-after-backup.txt")));
});

console.log(`Product: ${productRoot}\nProduct entry SHA-256: ${productHash}`);
if (errors.length) {
  console.error(`Project preimage regressions failed: ${errors.length}; passed: ${passed}`);
  for (const error of errors) console.error(`- ${error}`);
  console.error(`Isolated evidence retained: ${scratch}`);
  process.exitCode = 1;
} else {
  console.log(`Project preimage regressions passed: ${passed}`);
  const safeRelative = relative(resolve(tmpdir()), scratch);
  if (!safeRelative || safeRelative.startsWith(`..${sep}`) || safeRelative === "..") throw new Error("Unsafe scratch cleanup path");
  fs.rmSync(scratch, { recursive: true, force: true });
}
