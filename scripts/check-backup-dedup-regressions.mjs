import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(join(tmpdir(), "beyond-backup-dedup-"));
const project = join(scratch, "project");
const control = join(project, "beyond-control");
const snapshots = join(project, ".beyond-local-backups", "beyond-control");
const local = join(control, "local");
const script = join(control, "scripts", "beyond-control.mjs");
const clock = join(scratch, "clock.mjs");
let assertions = 0;
let linkCopy = "not-run";
const verify = (condition, message) => { assert.ok(condition, message); assertions += 1; };
function write(file, text) { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function command(args, { success = true, env = {} } = {}) {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, script, ...args], {
    cwd: project, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, ...env },
  });
  if (success) assert.equal(result.status, 0, `${args[0]}: ${result.error ?? result.stderr}`);
  return result;
}
function measure(root) {
  let files = 0; let bytes = 0; let directories = 0;
  if (!fs.existsSync(root)) return { files, bytes, directories };
  function visit(file) {
    const info = fs.lstatSync(file);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      directories += 1;
      for (const child of fs.readdirSync(file)) visit(join(file, child));
    } else { files += 1; bytes += info.size; }
  }
  visit(root);
  return { files, bytes, directories };
}
const backup = () => command(["backup-local", "--reason", "dedup-regression"]).stdout.trim();
const register = () => JSON.parse(command(["register-project", "--project-root", project]).stdout);
function racingMutation(args, file, directory = snapshots) {
  const before = fs.readFileSync(file, "utf8");
  const changed = `${before}\nINJECTED CONCURRENT SOURCE CHANGE\n`;
  const size = measure(snapshots);
  try {
    const result = command(args, { success: false, env: {
      BEYOND_BACKUP_RACE_DIRECTORY: directory, BEYOND_BACKUP_RACE_FILE: file, BEYOND_BACKUP_RACE_CONTENT: changed,
    } });
    verify(result.status !== 0 && result.stderr.includes("源内容发生变化"), `${args[0]} refuses stale reused before-image`);
    verify(fs.readFileSync(file, "utf8") === changed, "concurrent source change is not overwritten");
    assert.deepEqual(measure(snapshots), size);
  } finally { fs.writeFileSync(file, before); }
}

try {
  fs.cpSync(join(repository, "模板交付包"), control, { recursive: true });
  // Fixed time is test-only: registration's real updated_at semantics remain untouched.
  write(clock, `import fs from "node:fs";
  import { resolve } from "node:path";
  import { syncBuiltinESMExports } from "node:module";
  const originalRead = fs.readdirSync;
  let raced = false;
  fs.readdirSync = (path, ...args) => {
    const result = originalRead(path, ...args);
    if (!raced && process.env.BEYOND_BACKUP_RACE_DIRECTORY && typeof path === "string"
      && resolve(path) === resolve(process.env.BEYOND_BACKUP_RACE_DIRECTORY)) {
      raced = true;
      fs.writeFileSync(process.env.BEYOND_BACKUP_RACE_FILE, process.env.BEYOND_BACKUP_RACE_CONTENT);
    }
    return result;
  };
  syncBuiltinESMExports();
  const OriginalDate = Date; globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ["2026-10-13T00:00:00.000Z"])); }
    static now() { return 1791849600000; }
  };`);
  const git = spawnSync("git", ["init", project], { encoding: "utf8", windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const outside = join(scratch, "must-survive.txt");
  write(outside, "independent unique material");
  const marker = join(local, "unique.txt");
  write(marker, "original unique material");
  fs.mkdirSync(join(local, "empty"), { recursive: true });

  const first = backup();
  const fullSize = measure(snapshots);
  for (let round = 0; round < 5; round += 1) {
    verify(backup() === first, `full backup repeat ${round + 1} reuses verified snapshot`);
    assert.deepEqual(measure(snapshots), fullSize);
  }
  racingMutation(["backup-local", "--reason", "dedup-regression"], marker);
  verify(fs.existsSync(join(first, "empty")), "empty directory retained");
  write(marker, "second unique material");
  const second = backup();
  verify(second !== first && fs.readFileSync(join(first, "unique.txt"), "utf8") === "original unique material", "unique prior image remains intact");
  write(join(second, "unique.txt"), "tampered backup");
  const damagedRestore = command(["restore-local", "--snapshot", second, "--confirm-restore", "yes"], { success: false });
  verify(damagedRestore.status !== 0 && damagedRestore.stderr.includes("停止恢复") && fs.readFileSync(marker, "utf8") === "second unique material", "tampered fingerprinted snapshot refused before restore mutation");
  const childRestore = command(["restore-local", "--snapshot", join(first, "empty"), "--confirm-restore", "yes"], { success: false });
  verify(childRestore.status !== 0 && childRestore.stderr.includes("停止恢复"), "partial subtree of complete snapshot is not a full restore");
  const third = backup();
  verify(third !== second && fs.readFileSync(join(third, "unique.txt"), "utf8") === "second unique material", "tampered full backup is not reused");
  verify(fs.readFileSync(join(second, "unique.txt"), "utf8") === "tampered backup", "tampered historical material is not deleted or overwritten");
  const partial = `${third}.partial`;
  fs.renameSync(third, partial);
  verify(backup() !== partial, "complete-looking partial backup is not reused");
  const partialRestore = command(["restore-local", "--snapshot", partial, "--confirm-restore", "yes"], { success: false });
  verify(partialRestore.status !== 0 && partialRestore.stderr.includes("尚未核验完成"), "partial restore rejected");
  verify(fs.readFileSync(marker, "utf8") === "second unique material", "partial refusal leaves live fixture unchanged");
  fs.rmSync(join(local, "empty"), { recursive: true });
  const withoutEmpty = backup();
  verify(!fs.existsSync(join(withoutEmpty, "empty")), "empty directory removal creates distinct correct snapshot");
  write(join(local, "new-only.txt"), "new content");
  command(["restore-local", "--snapshot", first, "--confirm-restore", "yes"]);
  verify(fs.readFileSync(marker, "utf8") === "original unique material" && !fs.existsSync(join(local, "new-only.txt")), "full restore recovers bytes and original absence");
  verify(fs.existsSync(join(local, "empty")), "full restore recovers empty directory");

  // A directory junction exercises links on Windows without requiring symlink privilege.
  const linked = join(scratch, "link-target");
  write(join(linked, "external.txt"), "linked independent material");
  fs.symlinkSync(linked, join(local, "link"), process.platform === "win32" ? "junction" : "dir");
  const linkedBackup = command(["backup-local", "--reason", "link-regression"], { success: false });
  if (linkedBackup.status === 0) {
    const withLink = linkedBackup.stdout.trim();
    verify(fs.lstatSync(join(withLink, "link")).isSymbolicLink(), "directory link is preserved, not traversed");
    verify(backup() === withLink, "matching link backup reused");
    linkCopy = "preserved";
  } else {
    verify(/EPERM.*symlink/.test(linkedBackup.stderr), "unavailable link-copy privilege fails visibly, not silently dereferenced");
    verify(fs.readdirSync(snapshots).some(name => name.endsWith("-link-regression.partial")), "failed link copy remains identifiable partial evidence");
    linkCopy = "EPERM source preserved; no privilege bypass";
  }
  fs.unlinkSync(join(local, "link"));
  verify(fs.readFileSync(join(linked, "external.txt"), "utf8") === "linked independent material", "link target untouched");

  register();
  register(); // Existing host/project empty-field normalization settles on the second registration.
  const initialRegistered = register();
  const preciseSize = measure(snapshots);
  for (let round = 0; round < 5; round += 1) {
    const repeated = register();
    verify(repeated.localBackup === initialRegistered.localBackup, `precise backup repeat ${round + 1} reuses verified snapshot`);
    assert.deepEqual(measure(snapshots), preciseSize);
  }
  const overview = initialRegistered.overviewPath;
  racingMutation(["register-project", "--project-root", project], overview);
  fs.appendFileSync(overview, "\nUnique revised business boundary.\n");
  const changed = register();
  verify(changed.localBackup !== initialRegistered.localBackup, "unique precise before-image gets separate preserved snapshot");
  const manifest = JSON.parse(fs.readFileSync(join(changed.localBackup, "project-preimage.json"), "utf8"));
  const object = manifest.objects.find(item => resolve(item.path) === resolve(overview));
  verify(fs.readFileSync(join(changed.localBackup, object.saved), "utf8") === fs.readFileSync(overview, "utf8"), "precise image retains exact unique business text");
  write(join(changed.localBackup, object.saved), "tampered precise image");
  const repaired = register();
  verify(repaired.localBackup !== changed.localBackup, "tampered precise backup never reused");
  fs.unlinkSync(join(repaired.localBackup, "project-preimage.json"));
  const afterPartial = register();
  verify(afterPartial.localBackup !== repaired.localBackup, "precise partial without completion manifest never reused");
  verify(fs.existsSync(repaired.localBackup), "partial evidence retained");
  const overviewText = fs.readFileSync(overview, "utf8");
  fs.unlinkSync(overview);
  const missing = register();
  const missingManifest = JSON.parse(fs.readFileSync(join(missing.localBackup, "project-preimage.json"), "utf8"));
  verify(missingManifest.objects.find(item => resolve(item.path) === resolve(overview)).existed === false, "original absence differs from existing content");
  write(overview, overviewText);

  const install = () => JSON.parse(command(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"]).stdout);
  write(join(project, "AGENTS.md"), "# Distinct native entry\n");
  const firstInstall = install();
  const initialCompat = new Map(fs.readdirSync(firstInstall.backupDirectory).map(name => [name, createHash("sha256").update(fs.readFileSync(join(firstInstall.backupDirectory, name))).digest("hex")]));
  const installed = install();
  for (const [name, digest] of initialCompat) verify(createHash("sha256").update(fs.readFileSync(join(installed.backupDirectory, name))).digest("hex") === digest, "same-timestamp install retains unique compatibility original");
  const compatibilitySize = measure(installed.backupDirectory);
  for (let round = 0; round < 5; round += 1) {
    install();
    assert.deepEqual(measure(installed.backupDirectory), compatibilitySize);
  }
  verify(true, "five equivalent installs do not duplicate compatibility entry backups");
  racingMutation(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"], join(project, "AGENTS.md"), installed.backupDirectory);
  const choose = () => JSON.parse(command(["initialization", "--action", "choose", "--project-id", initialRegistered.project.projectId,
    "--mode", "on-demand", "--approved-by", "isolated backup regression"]).stdout);
  choose();
  const single = choose();
  const singleSize = measure(snapshots);
  for (let round = 0; round < 5; round += 1) {
    verify(choose().backup === single.backup, `single-file repeat ${round + 1} reuses verified image`);
    assert.deepEqual(measure(snapshots), singleSize);
  }
  racingMutation(["initialization", "--action", "choose", "--project-id", initialRegistered.project.projectId,
    "--mode", "on-demand", "--approved-by", "isolated backup regression"], overview);
  const singleRoot = join(snapshots, relative(snapshots, single.backup).split(/[\\/]/)[0]);
  for (const value of [singleRoot, dirname(single.backup)]) {
    const refused = command(["restore-local", "--snapshot", value, "--confirm-restore", "yes"], { success: false });
    verify(refused.status !== 0 && refused.stderr.includes("单文件前像"), "single-file image/root cannot replace entire local tree");
  }
  const legacy = join(snapshots, "legacy-full-local-regression");
  fs.cpSync(first, legacy, { recursive: true });
  command(["restore-local", "--snapshot", legacy, "--confirm-restore", "yes"]);
  verify(fs.readFileSync(marker, "utf8") === "original unique material", "legacy full snapshot restore remains compatible");
  verify(fs.readFileSync(outside, "utf8") === "independent unique material", "out-of-scope recovery sentinel preserved");
  console.log(JSON.stringify({ passed: true, assertions, rounds: 5, fullBackupPlateau: fullSize, preciseBackupPlateau: preciseSize, compatibilityPlateau: compatibilitySize, linkCopy }));
} finally {
  const inside = relative(resolve(tmpdir()), scratch);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || fs.lstatSync(scratch).isSymbolicLink()) throw new Error("Unsafe isolated scratch cleanup");
  fs.rmSync(scratch, { recursive: true, force: true });
}
