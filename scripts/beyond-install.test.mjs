import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manager = join(repositoryRoot, "scripts", "beyond-install.mjs");
const testRoot = mkdtempSync(join(realpathSync(tmpdir()), "beyond-install-test-"));
const fixtureLinks = [];
let assertions = 0;
let cleanupVerified = false;

function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function createSource(root, version, marker) {
  write(join(root, "VERSION"), `${version}\n`);
  write(join(root, "模板交付包", "AGENTS.md"), `# fixture ${marker}\n`);
  write(join(root, "模板交付包", "docs", "AI编程协同机制", "当前工作台.md"), `# workbench ${marker}\n`);
  write(join(root, "模板交付包", "skills", "identity-pm", "SKILL.md"), `---\nname: identity-pm\n---\n# ${marker}\n`);
  if (marker === "v1") {
    write(join(root, "模板交付包", "docs", "AI编程协同机制", "old.md"), "old\n");
  } else {
    write(join(root, "模板交付包", "docs", "AI编程协同机制", "new.md"), "new\n");
  }
}

function invoke(args, expectedSuccess = true, testMode = false) {
  const result = spawnSync(process.execPath, [manager, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(testMode ? { BEYOND_INSTALL_TEST_MODE: "1" } : {}) },
  });
  if (expectedSuccess) {
    assert.equal(result.status, 0, `command failed: ${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  assert.notEqual(result.status, 0, `command unexpectedly succeeded: ${args.join(" ")}`);
  check(result.stderr.includes("BEYOND_INSTALL_ERROR:"), "failed command should use the stable error prefix");
  return result;
}

function installedVersion(target, source) {
  return invoke(["version", "--target", target, "--source", source]).installedVersion;
}

function availableBackupIds(target) {
  const root = join(target, ".beyond", "backups");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((entry) => existsSync(join(root, entry, "backup.json")))
    .sort();
}

function snapshotTree(root) {
  if (!existsSync(root)) {
    return "ABSENT";
  }
  const snapshot = [];
  function visit(current, relativeRoot) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(current, entry.name);
      const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        snapshot.push(["link", relativePath]);
      } else if (entry.isDirectory()) {
        snapshot.push(["directory", relativePath]);
        visit(absolute, relativePath);
      } else {
        snapshot.push(["file", relativePath, readFileSync(absolute).toString("base64")]);
      }
    }
  }
  visit(root, "");
  return JSON.stringify(snapshot);
}

function isInsideFixture(root, child) {
  const rel = relative(root, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function createOutsideCanary(label) {
  const root = join(testRoot, "outside", label);
  write(join(root, "canary.txt"), `outside:${label}\n`);
  check(isInsideFixture(realpathSync(testRoot), realpathSync(root)), `outside canary must be physically owned by this task: ${label}`);
  return root;
}

function createDirectoryLink(actual, link, type) {
  mkdirSync(dirname(link), { recursive: true });
  check(isInsideFixture(realpathSync(testRoot), realpathSync(actual)), `${type} target must be physically owned by this task`);
  check(isInsideFixture(realpathSync(testRoot), realpathSync(dirname(link))), `${type} parent must be physically owned by this task`);
  try {
    symlinkSync(actual, link, type);
  } catch (error) {
    throw new Error(`CANNOT_DETERMINE: cannot create Windows ${type} fixture at ${link}: ${error.message}`);
  }
  check(lstatSync(link).isSymbolicLink(), `${type} fixture should be a real filesystem link`);
  fixtureLinks.push(link);
}

function removeOwnedDirectory(path) {
  if (!existsSync(path)) {
    return;
  }
  check(!lstatSync(path).isSymbolicLink(), `owned directory must not be a link before removal: ${path}`);
  rmSync(path, { recursive: true });
}

function createInstalledFixture(label, sourceA, sourceB) {
  const target = join(testRoot, `${label}-target`);
  mkdirSync(target, { recursive: true });
  invoke(["install", "--target", target, "--source", sourceA]);
  return { target, sourceA, sourceB };
}

try {
  const sourceA = join(testRoot, "source-a");
  const sourceB = join(testRoot, "source-b");
  const target = join(testRoot, "target");
  const collisionTarget = join(testRoot, "collision-target");
  const eolTarget = join(testRoot, "eol-target");
  const eolSource = join(testRoot, "eol-source");
  const actualTarget = join(testRoot, "actual-candidate-target");
  mkdirSync(target, { recursive: true });
  mkdirSync(collisionTarget, { recursive: true });
  mkdirSync(eolTarget, { recursive: true });
  mkdirSync(actualTarget, { recursive: true });
  createSource(sourceA, "3.0.1", "v1");
  createSource(sourceB, "3.0.2-rc.1", "v2");
  createSource(eolSource, "3.0.2-rc.1", "eol");
  writeFileSync(join(eolSource, "模板交付包", "AGENTS.md"), "# CRLF\r\n", "utf8");

  const symlinkTargetActual = createOutsideCanary("target-symlink-actual");
  const symlinkTargetAlias = join(testRoot, "target-symlink");
  createDirectoryLink(symlinkTargetActual, symlinkTargetAlias, "dir");
  const symlinkTargetSnapshot = snapshotTree(symlinkTargetActual);
  invoke(["install", "--target", symlinkTargetAlias, "--source", sourceA], false);
  check(snapshotTree(symlinkTargetActual) === symlinkTargetSnapshot, "directory symlink target rejection must preserve outside canary");
  check(!existsSync(join(symlinkTargetActual, ".beyond")), "directory symlink target rejection must write no state");

  const junctionTargetActual = createOutsideCanary("target-junction-actual");
  const junctionTargetAlias = join(testRoot, "target-junction");
  createDirectoryLink(junctionTargetActual, junctionTargetAlias, "junction");
  const junctionTargetSnapshot = snapshotTree(junctionTargetActual);
  invoke(["install", "--target", junctionTargetAlias, "--source", sourceA], false);
  check(snapshotTree(junctionTargetActual) === junctionTargetSnapshot, "junction target rejection must preserve outside canary");
  check(!existsSync(join(junctionTargetActual, ".beyond")), "junction target rejection must write no state");

  const managedLinkTarget = join(testRoot, "managed-link-target");
  const managedLinkOutside = createOutsideCanary("managed-link-outside");
  mkdirSync(managedLinkTarget, { recursive: true });
  createDirectoryLink(managedLinkOutside, join(managedLinkTarget, "docs"), "junction");
  const managedLinkSnapshot = snapshotTree(managedLinkOutside);
  invoke(["install", "--target", managedLinkTarget, "--source", sourceA], false);
  check(snapshotTree(managedLinkOutside) === managedLinkSnapshot, "managed parent junction rejection must preserve outside canary");
  check(!existsSync(join(managedLinkTarget, ".beyond")), "managed parent junction rejection must leave no state");

  const transactionFixture = createInstalledFixture("transactions", sourceA, sourceB);
  const transactionOutside = createOutsideCanary("transactions-target-evil");
  const transactionLink = join(transactionFixture.target, ".beyond", "transactions");
  createDirectoryLink(transactionOutside, transactionLink, "junction");
  const transactionOutsideSnapshot = snapshotTree(transactionOutside);
  const transactionBackupsBefore = availableBackupIds(transactionFixture.target);
  const transactionStagingBefore = snapshotTree(join(transactionFixture.target, ".beyond", "staging"));
  invoke(["upgrade", "--target", transactionFixture.target, "--source", sourceB], false);
  check(snapshotTree(transactionOutside) === transactionOutsideSnapshot, "transaction junction rejection must preserve prefix-similar outside canary");
  check(JSON.stringify(availableBackupIds(transactionFixture.target)) === JSON.stringify(transactionBackupsBefore), "transaction junction rejection must create no backup");
  check(snapshotTree(join(transactionFixture.target, ".beyond", "staging")) === transactionStagingBefore, "transaction junction rejection must create no staging payload");
  check(installedVersion(transactionFixture.target, sourceA) === "3.0.1", "transaction junction rejection must preserve installed version");
  check(invoke(["verify", "--target", transactionFixture.target]).status === "VERIFIED", "transaction junction rejection must preserve a verifiable install");

  const stagingUpgradeFixture = createInstalledFixture("staging-upgrade", sourceA, sourceB);
  const stagingUpgradeOutside = createOutsideCanary("staging-upgrade-target-evil");
  const stagingUpgradeLink = join(stagingUpgradeFixture.target, ".beyond", "staging");
  createDirectoryLink(stagingUpgradeOutside, stagingUpgradeLink, "junction");
  const stagingUpgradeOutsideSnapshot = snapshotTree(stagingUpgradeOutside);
  const stagingUpgradeBackupsBefore = availableBackupIds(stagingUpgradeFixture.target);
  const stagingUpgradeTransactionsBefore = snapshotTree(join(stagingUpgradeFixture.target, ".beyond", "transactions"));
  invoke(["upgrade", "--target", stagingUpgradeFixture.target, "--source", sourceB], false);
  check(snapshotTree(stagingUpgradeOutside) === stagingUpgradeOutsideSnapshot, "upgrade staging junction rejection must preserve outside canary");
  check(JSON.stringify(availableBackupIds(stagingUpgradeFixture.target)) === JSON.stringify(stagingUpgradeBackupsBefore), "upgrade staging junction rejection must create no backup");
  check(snapshotTree(join(stagingUpgradeFixture.target, ".beyond", "transactions")) === stagingUpgradeTransactionsBefore, "upgrade staging junction rejection must create no transaction");
  check(invoke(["verify", "--target", stagingUpgradeFixture.target]).status === "VERIFIED", "upgrade staging junction rejection must preserve a verifiable install");

  const stagingRollbackFixture = createInstalledFixture("staging-rollback", sourceA, sourceB);
  const stagingRollbackUpgrade = invoke(["upgrade", "--target", stagingRollbackFixture.target, "--source", sourceB]);
  const stagingRollbackRoot = join(stagingRollbackFixture.target, ".beyond", "staging");
  removeOwnedDirectory(stagingRollbackRoot);
  const stagingRollbackOutside = createOutsideCanary("staging-rollback-target-evil");
  createDirectoryLink(stagingRollbackOutside, stagingRollbackRoot, "junction");
  const stagingRollbackOutsideSnapshot = snapshotTree(stagingRollbackOutside);
  const stagingRollbackBackupsBefore = availableBackupIds(stagingRollbackFixture.target);
  const stagingRollbackTransactionsBefore = snapshotTree(join(stagingRollbackFixture.target, ".beyond", "transactions"));
  invoke(["rollback", "--target", stagingRollbackFixture.target, "--backup", stagingRollbackUpgrade.backupId], false);
  check(snapshotTree(stagingRollbackOutside) === stagingRollbackOutsideSnapshot, "rollback staging junction rejection must preserve outside canary");
  check(JSON.stringify(availableBackupIds(stagingRollbackFixture.target)) === JSON.stringify(stagingRollbackBackupsBefore), "rollback staging junction rejection must create no backup");
  check(snapshotTree(join(stagingRollbackFixture.target, ".beyond", "transactions")) === stagingRollbackTransactionsBefore, "rollback staging junction rejection must create no transaction");
  check(installedVersion(stagingRollbackFixture.target, sourceB) === "3.0.2-rc.1", "rollback staging junction rejection must preserve installed version");
  check(invoke(["verify", "--target", stagingRollbackFixture.target]).status === "VERIFIED", "rollback staging junction rejection must preserve a verifiable install");

  const payloadFixture = createInstalledFixture("backup-payload", sourceA, sourceB);
  const payloadUpgrade = invoke(["upgrade", "--target", payloadFixture.target, "--source", sourceB]);
  const payloadRoot = join(payloadFixture.target, ".beyond", "backups", payloadUpgrade.backupId, "payload");
  const payloadOutside = createOutsideCanary("backup-payload-outside");
  const payloadOutsideRoot = join(payloadOutside, "payload");
  cpSync(payloadRoot, payloadOutsideRoot, { recursive: true });
  removeOwnedDirectory(payloadRoot);
  createDirectoryLink(payloadOutsideRoot, payloadRoot, "junction");
  const payloadOutsideSnapshot = snapshotTree(payloadOutside);
  const payloadCurrentSnapshot = snapshotTree(payloadFixture.target);
  invoke(["rollback", "--target", payloadFixture.target, "--backup", payloadUpgrade.backupId], false);
  check(snapshotTree(payloadOutside) === payloadOutsideSnapshot, "backup payload junction rejection must preserve outside canary");
  check(snapshotTree(payloadFixture.target) === payloadCurrentSnapshot, "backup payload junction rejection must preserve the current managed tree and state");
  check(installedVersion(payloadFixture.target, sourceB) === "3.0.2-rc.1", "backup payload junction rejection must preserve installed version");
  check(invoke(["verify", "--target", payloadFixture.target]).status === "VERIFIED", "backup payload junction rejection must preserve a verifiable install");

  invoke(["install", "--target", eolTarget, "--source", eolSource], false);
  check(!existsSync(join(eolTarget, ".beyond")), "non-canonical source EOL must fail before target writes");

  const dryInstall = invoke(["install", "--target", target, "--source", sourceA, "--dry-run"]);
  check(dryInstall.status === "DRY_RUN", "install dry-run should report DRY_RUN");
  check(!existsSync(join(target, ".beyond")), "install dry-run must not create state");
  check(!existsSync(join(target, "AGENTS.md")), "install dry-run must not copy payload");

  const installed = invoke(["install", "--target", target, "--source", sourceA]);
  check(installed.status === "INSTALLED", "install should succeed");
  check(installedVersion(target, sourceA) === "3.0.1", "version should report the installed version");
  const verifiedA = invoke(["verify", "--target", target]);
  check(verifiedA.status === "VERIFIED", "new install should verify");
  check(existsSync(join(target, "docs", "AI编程协同机制", "old.md")), "v1-only file should be installed");
  const stagingRoot = join(target, ".beyond", "staging");

  write(join(collisionTarget, "AGENTS.md"), "owner content\n");
  invoke(["install", "--target", collisionTarget, "--source", sourceA], false);
  check(readFileSync(join(collisionTarget, "AGENTS.md"), "utf8") === "owner content\n", "collision install must preserve existing content");
  check(!existsSync(join(collisionTarget, ".beyond")), "collision install must not create state");

  write(join(target, "AGENTS.md"), "local drift\n");
  invoke(["verify", "--target", target], false);
  invoke(["upgrade", "--target", target, "--source", sourceB], false);
  check(readFileSync(join(target, "AGENTS.md"), "utf8") === "local drift\n", "drifted upgrade must not overwrite the user file");
  writeFileSync(join(target, "AGENTS.md"), readFileSync(join(sourceA, "模板交付包", "AGENTS.md")));
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "restored v1 fixture should verify");

  const backupIdsBeforeConstructionFailures = availableBackupIds(target);
  const manifestBeforeConstructionFailures = readFileSync(join(target, ".beyond", "installation.json"), "utf8");
  invoke(["upgrade", "--target", target, "--source", sourceB, "--test-fail-backup-after", "1"], false);
  check(availableBackupIds(target).length === backupIdsBeforeConstructionFailures.length, "backup fault injection must require explicit test mode");

  invoke(["upgrade", "--target", target, "--source", sourceB, "--test-fail-backup-after", "1"], false, true);
  check(JSON.stringify(availableBackupIds(target)) === JSON.stringify(backupIdsBeforeConstructionFailures), "interrupted backup copy must publish no selectable backup");
  check(readFileSync(join(target, ".beyond", "installation.json"), "utf8") === manifestBeforeConstructionFailures, "interrupted backup copy must preserve the installation manifest");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "old tree must verify after interrupted backup copy");
  check(!existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, "interrupted backup copy must leave no pending payload");

  invoke(["upgrade", "--target", target, "--source", sourceB, "--test-fail-backup-before-manifest"], false, true);
  check(JSON.stringify(availableBackupIds(target)) === JSON.stringify(backupIdsBeforeConstructionFailures), "pre-manifest backup failure must publish no selectable backup");
  check(readFileSync(join(target, ".beyond", "installation.json"), "utf8") === manifestBeforeConstructionFailures, "pre-manifest backup failure must preserve the installation manifest");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "old tree must verify after pre-manifest backup failure");
  check(!existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, "pre-manifest backup failure must leave no pending payload");

  invoke(["upgrade", "--target", target, "--source", sourceB, "--test-fail-after", "2"], false, true);
  check(installedVersion(target, sourceA) === "3.0.1", "failed upgrade should restore the old version");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "failed upgrade recovery should verify");
  check(existsSync(join(target, "docs", "AI编程协同机制", "old.md")), "failed upgrade should restore removed files");
  check(!existsSync(join(target, "docs", "AI编程协同机制", "new.md")), "failed upgrade should remove partially added files");
  check(!existsSync(stagingRoot) || readdirSync(stagingRoot).length === 0, "failed upgrade should leave no staging payload");

  const backupsBeforeDryRun = readdirSync(join(target, ".beyond", "backups")).length;
  const dryUpgrade = invoke(["upgrade", "--target", target, "--source", sourceB, "--dry-run"]);
  check(dryUpgrade.status === "DRY_RUN", "upgrade dry-run should report DRY_RUN");
  check(readdirSync(join(target, ".beyond", "backups")).length === backupsBeforeDryRun, "upgrade dry-run must not create a backup");

  const upgraded = invoke(["upgrade", "--target", target, "--source", sourceB]);
  check(upgraded.status === "UPGRADED", "normal upgrade should remain retryable after backup-construction failures");
  check(typeof upgraded.backupId === "string" && upgraded.backupId.length > 0, "upgrade should return a backup ID");
  check(installedVersion(target, sourceB) === "3.0.2-rc.1", "version should report upgraded source");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "upgraded tree should verify");
  check(!existsSync(join(target, "docs", "AI编程协同机制", "old.md")), "upgrade should remove retired managed files");
  check(existsSync(join(target, "docs", "AI编程协同机制", "new.md")), "upgrade should add new managed files");
  check(existsSync(join(target, ".beyond", "backups", upgraded.backupId, "backup.json")), "upgrade should persist its backup manifest");

  invoke(["rollback", "--target", target, "--backup", upgraded.backupId, "--test-fail-after", "1"], false, true);
  check(installedVersion(target, sourceB) === "3.0.2-rc.1", "failed rollback should restore the pre-rollback candidate");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "failed rollback recovery should verify");

  const dryRollback = invoke(["rollback", "--target", target, "--backup", upgraded.backupId, "--dry-run"]);
  check(dryRollback.status === "DRY_RUN", "rollback dry-run should report DRY_RUN");
  check(installedVersion(target, sourceB) === "3.0.2-rc.1", "rollback dry-run must not change version");

  const rolledBack = invoke(["rollback", "--target", target, "--backup", upgraded.backupId]);
  check(rolledBack.status === "ROLLED_BACK", "rollback should succeed");
  check(installedVersion(target, sourceA) === "3.0.1", "rollback should restore the previous version");
  check(invoke(["verify", "--target", target]).status === "VERIFIED", "rolled-back tree should verify");
  check(existsSync(join(target, "docs", "AI编程协同机制", "old.md")), "rollback should restore retired files");
  check(!existsSync(join(target, "docs", "AI编程协同机制", "new.md")), "rollback should remove newer files");
  const backup = JSON.parse(readFileSync(join(target, ".beyond", "backups", upgraded.backupId, "backup.json"), "utf8"));
  check(backup.status === "RESTORED", "backup manifest should record successful restoration");

  cpSync(join(repositoryRoot, "examples", "minimal-project"), actualTarget, { recursive: true });
  const actualDryRun = invoke(["install", "--target", actualTarget, "--dry-run"]);
  check(actualDryRun.status === "DRY_RUN", "actual candidate should support an install dry-run");
  check(!existsSync(join(actualTarget, ".beyond")), "actual candidate dry-run must leave no state");
  const actualInstall = invoke(["install", "--target", actualTarget]);
  check(actualInstall.version === "3.0.2", "actual candidate should install its VERSION");
  check(invoke(["verify", "--target", actualTarget]).status === "VERIFIED", "actual candidate install should verify");
  for (const npmArguments of [["test"], ["run", "check"]]) {
    const npmResult = process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${npmArguments.join(" ")}`], { cwd: actualTarget, encoding: "utf8" })
      : spawnSync("npm", npmArguments, { cwd: actualTarget, encoding: "utf8" });
    assert.equal(npmResult.status, 0, `actual candidate fixture command failed: npm ${npmArguments.join(" ")}\n${npmResult.stdout}\n${npmResult.stderr}`);
  }
  check(!existsSync(join(actualTarget, "node_modules")), "actual candidate smoke must not create node_modules");
  check(!existsSync(join(actualTarget, "package-lock.json")), "actual candidate smoke must not create a lockfile");

} finally {
  for (const link of fixtureLinks.reverse()) {
    if (!existsSync(link)) {
      continue;
    }
    if (!lstatSync(link).isSymbolicLink()) {
      throw new Error(`refusing fixture cleanup because path is no longer a link: ${link}`);
    }
    unlinkSync(link);
  }
  const canonicalTemp = realpathSync(tmpdir());
  const canonicalTest = existsSync(testRoot) ? realpathSync(testRoot) : testRoot;
  const rel = relative(canonicalTemp, canonicalTest);
  if (isAbsolute(rel) || rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !rel.startsWith("beyond-install-test-")) {
    throw new Error(`refusing fixture cleanup outside the owned OS temporary root: ${canonicalTest}`);
  }
  rmSync(testRoot, { recursive: true, force: true });
  cleanupVerified = !existsSync(testRoot);
}
check(cleanupVerified, "task-owned OS temporary fixture must be absent after cleanup");
console.log(`BEYOND_INSTALL_TESTS: PASS; assertions=${assertions}; platform=${process.platform}; cleanup=VERIFIED`);
