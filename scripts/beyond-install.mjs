import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDirectoryName = ".beyond";
const manifestRelativePath = `${stateDirectoryName}/installation.json`;
const sourceEntries = ["AGENTS.md", "docs/AI编程协同机制", "skills"];
const managedTextExtensions = new Set([".md", ".mjs", ".js", ".json", ".yml", ".yaml", ".ps1"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

function pathKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isInside(root, child) {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertAbsoluteDirectory(input, label) {
  if (!input || !isAbsolute(input)) {
    throw new Error(`${label} must be an explicit absolute path.`);
  }
  const resolved = resolve(input);
  if (resolved === parse(resolved).root) {
    throw new Error(`${label} cannot be a filesystem root.`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a link: ${resolved}`);
  }
  const canonical = realpathSync(resolved);
  if (pathKey(canonical) !== pathKey(resolved)) {
    throw new Error(`${label} contains a symbolic-link or junction hop: ${resolved}`);
  }
  return canonical;
}

function safePath(root, relativePath) {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid managed relative path: ${JSON.stringify(relativePath)}`);
  }
  const destination = resolve(root, ...relativePath.split("/"));
  if (!isInside(root, destination) || pathKey(destination) === pathKey(root)) {
    throw new Error(`Managed path escapes target: ${relativePath}`);
  }
  return destination;
}

function assertPhysicalPathChain(root, destination) {
  const resolvedRoot = resolve(root);
  const resolvedDestination = resolve(destination);
  if (!isInside(resolvedRoot, resolvedDestination)) {
    throw new Error(`Path escapes root: ${resolvedDestination}`);
  }
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Physical root does not exist: ${resolvedRoot}`);
  }
  const rootStat = lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Physical root must be a real directory, not a link: ${resolvedRoot}`);
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  if (pathKey(canonicalRoot) !== pathKey(resolvedRoot)) {
    throw new Error(`Physical root contains a symbolic-link or junction hop: ${resolvedRoot}`);
  }
  let cursor = resolvedRoot;
  for (const part of relative(resolvedRoot, resolvedDestination).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) {
      continue;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links and junctions are not allowed in managed paths: ${cursor}`);
    }
    const canonical = realpathSync(cursor);
    if (!isInside(canonicalRoot, canonical) || pathKey(canonical) !== pathKey(resolve(cursor))) {
      throw new Error(`Managed path resolves outside its physical root: ${cursor}`);
    }
  }
  return resolvedDestination;
}

function assertNoLinkChain(root, destination) {
  assertPhysicalPathChain(root, destination);
}

function assertNoLinksInTree(root, current) {
  assertPhysicalPathChain(root, current);
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to traverse a linked cleanup root: ${current}`);
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to traverse a linked cleanup entry: ${path}`);
    }
    if (entry.isDirectory()) {
      assertNoLinksInTree(root, path);
    }
  }
}

function removeOwnedTree(root, path) {
  if (!existsSync(path)) {
    return;
  }
  assertNoLinksInTree(root, path);
  rmSync(path, { recursive: true, force: true });
}

function preflightPaths(root, paths) {
  for (const path of paths) {
    assertPhysicalPathChain(root, path);
  }
}

function preflightManagedPaths(root, records) {
  preflightPaths(root, records.map((record) => safePath(root, record.path)));
}

function listFiles(root, current = root) {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new Error(`Source contains a symbolic link: ${current}`);
  }
  if (stat.isFile()) {
    return [current];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Source contains an unsupported entry: ${current}`);
  }
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .flatMap((entry) => listFiles(root, join(current, entry.name)));
}

function collectSource(sourceRepositoryRoot) {
  const versionPath = join(sourceRepositoryRoot, "VERSION");
  if (!existsSync(versionPath) || !lstatSync(versionPath).isFile()) {
    throw new Error(`Source VERSION is missing: ${versionPath}`);
  }
  const version = readFileSync(versionPath, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Source VERSION is invalid: ${JSON.stringify(version)}`);
  }
  const packageRoot = join(sourceRepositoryRoot, "模板交付包");
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) {
    throw new Error(`Template package is missing: ${packageRoot}`);
  }
  const absoluteFiles = [];
  for (const entry of sourceEntries) {
    const path = join(packageRoot, ...entry.split("/"));
    if (!existsSync(path)) {
      throw new Error(`Template source entry is missing: ${entry}`);
    }
    absoluteFiles.push(...listFiles(packageRoot, path));
  }
  const files = absoluteFiles
    .map((path) => {
      const relativePath = normalizeRelative(relative(packageRoot, path));
      const bytes = readFileSync(path);
      if (managedTextExtensions.has(extname(path).toLowerCase())) {
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          throw new Error(`Template text contains a UTF-8 BOM: ${relativePath}`);
        }
        if (bytes.includes(0x0d)) {
          throw new Error(`Template text is not canonical LF: ${relativePath}`);
        }
        try {
          utf8Decoder.decode(bytes);
        } catch {
          throw new Error(`Template text is not strict UTF-8: ${relativePath}`);
        }
      }
      return { path: relativePath, sha256: sha256(bytes), size: bytes.length, sourcePath: path };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Template source contains duplicate managed paths.");
  }
  return { version, packageRoot, files, treeSha256: treeSha256(files) };
}

function treeSha256(files) {
  const lines = files
    .map((file) => `${file.path}\t${file.sha256}\t${file.size}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  return sha256(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

function publicFiles(files) {
  return files.map(({ path, sha256: hash, size }) => ({ path, sha256: hash, size }));
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.product !== "BEYOND" || !Array.isArray(manifest.files)) {
    throw new Error("Installation manifest schema is invalid.");
  }
  const seen = new Set();
  for (const file of manifest.files) {
    safePath(resolve("."), file.path);
    if (seen.has(file.path)) {
      throw new Error(`Installation manifest repeats a path: ${file.path}`);
    }
    seen.add(file.path);
    if (!/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0) {
      throw new Error(`Installation manifest has an invalid file record: ${file.path}`);
    }
  }
  if (treeSha256(manifest.files) !== manifest.treeSha256) {
    throw new Error("Installation manifest tree digest is invalid.");
  }
  return manifest;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readInstallation(targetRoot) {
  const path = safePath(targetRoot, manifestRelativePath);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`BEYOND is not installed in target: ${targetRoot}`);
  }
  assertNoLinkChain(targetRoot, path);
  return { path, manifest: validateManifest(readJson(path, "Installation manifest")) };
}

function writeJson(root, path, value) {
  assertPhysicalPathChain(root, path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (existsSync(path)) {
    unlinkSync(path);
  }
  renameSync(temporary, path);
}

function verifyFiles(root, files) {
  const issues = [];
  for (const file of files) {
    const path = safePath(root, file.path);
    try {
      assertNoLinkChain(root, path);
      if (!existsSync(path)) {
        issues.push(`${file.path}: missing`);
        continue;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        issues.push(`${file.path}: not a regular file`);
        continue;
      }
      const bytes = readFileSync(path);
      const actual = sha256(bytes);
      if (actual !== file.sha256 || bytes.length !== file.size) {
        issues.push(`${file.path}: expected ${file.sha256}/${file.size}, got ${actual}/${bytes.length}`);
      }
    } catch (error) {
      issues.push(`${file.path}: ${error.message}`);
    }
  }
  return issues;
}

function ensureParentDirectories(targetRoot, destination, createdDirectories) {
  const missing = [];
  let cursor = dirname(destination);
  while (pathKey(cursor) !== pathKey(targetRoot) && !existsSync(cursor)) {
    if (!isInside(targetRoot, cursor)) {
      throw new Error(`Parent path escapes target: ${cursor}`);
    }
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  assertNoLinkChain(targetRoot, cursor);
  for (const path of missing.reverse()) {
    mkdirSync(path);
    createdDirectories.push(path);
  }
}

function copyRecords(records, destinationRoot, sourceRoot = null, afterCopy = null) {
  const createdDirectories = [];
  let copied = 0;
  for (const record of records) {
    const destination = safePath(destinationRoot, record.path);
    assertNoLinkChain(destinationRoot, dirname(destination));
    ensureParentDirectories(destinationRoot, destination, createdDirectories);
    const source = sourceRoot ? safePath(sourceRoot, record.path) : record.sourcePath;
    copyFileSync(source, destination);
    const bytes = readFileSync(destination);
    if (sha256(bytes) !== record.sha256 || bytes.length !== record.size) {
      throw new Error(`Copied file failed hash verification: ${record.path}`);
    }
    copied += 1;
    if (afterCopy) {
      afterCopy(record, copied);
    }
  }
  return createdDirectories;
}

function removeManagedFiles(root, files) {
  for (const file of [...files].sort((left, right) => right.path.length - left.path.length)) {
    const path = safePath(root, file.path);
    assertNoLinkChain(root, path);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing to remove non-file managed path: ${file.path}`);
      }
      unlinkSync(path);
    }
  }
}

function cleanupEmptyDirectories(targetRoot, paths) {
  const candidates = new Set();
  for (const path of paths) {
    let cursor = dirname(safePath(targetRoot, path.path));
    while (pathKey(cursor) !== pathKey(targetRoot) && isInside(targetRoot, cursor)) {
      candidates.add(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const path of [...candidates].sort((left, right) => right.length - left.length)) {
    try {
      assertPhysicalPathChain(targetRoot, path);
      const stat = existsSync(path) ? lstatSync(path) : null;
      if (stat?.isDirectory() && !stat.isSymbolicLink() && readdirSync(path).length === 0) {
        rmSync(path, { recursive: false });
      }
    } catch {
      // A non-empty project directory is intentionally retained.
    }
  }
}

function nowId(prefix) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}-${timestamp}-${randomBytes(4).toString("hex")}`;
}

function buildInstallation(source, previous = null, backupId = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    product: "BEYOND",
    version: source.version,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    previousBackupId: backupId,
    treeSha256: source.treeSha256,
    files: publicFiles(source.files),
  };
}

function assertTestFailureOption(targetRoot, value) {
  if (!value) {
    return 0;
  }
  if (process.env.BEYOND_INSTALL_TEST_MODE !== "1") {
    throw new Error("Failure injection is available only in explicit test mode.");
  }
  const tempRoot = realpathSync(tmpdir());
  if (!isInside(tempRoot, targetRoot)) {
    throw new Error("Failure injection target must be below the operating-system temporary directory.");
  }
  return value;
}

function maybeFail(counter, limit, label) {
  if (limit > 0 && counter >= limit) {
    throw new Error(`Injected ${label} failure after ${counter} managed file changes.`);
  }
}

function install({ targetRoot, source, dryRun, testFailAfter }) {
  const stateRoot = safePath(targetRoot, stateDirectoryName);
  if (existsSync(stateRoot)) {
    throw new Error(`Target already contains ${stateDirectoryName}; use verify or upgrade.`);
  }
  preflightPaths(targetRoot, [stateRoot]);
  preflightManagedPaths(targetRoot, source.files);
  const collisions = source.files.filter((file) => existsSync(safePath(targetRoot, file.path))).map((file) => file.path);
  if (collisions.length > 0) {
    throw new Error(`Install conflicts with existing target files: ${collisions.join(", ")}`);
  }
  const result = { command: "install", status: dryRun ? "DRY_RUN" : "INSTALLED", target: targetRoot, version: source.version, treeSha256: source.treeSha256, files: source.files.length };
  if (dryRun) {
    return result;
  }
  const limit = assertTestFailureOption(targetRoot, testFailAfter);
  const transactionId = nowId("install");
  const stageRoot = join(stateRoot, "staging", transactionId);
  preflightPaths(targetRoot, [stageRoot, safePath(targetRoot, manifestRelativePath)]);
  const createdFiles = [];
  try {
    mkdirSync(stageRoot, { recursive: true });
    copyRecords(source.files, stageRoot);
    const stageIssues = verifyFiles(stageRoot, source.files);
    if (stageIssues.length > 0) {
      throw new Error(`Staged source verification failed: ${stageIssues.join("; ")}`);
    }
    let changed = 0;
    for (const file of source.files) {
      const destination = safePath(targetRoot, file.path);
      ensureParentDirectories(targetRoot, destination, []);
      copyFileSync(safePath(stageRoot, file.path), destination);
      createdFiles.push(file);
      changed += 1;
      maybeFail(changed, limit, "install");
    }
    const issues = verifyFiles(targetRoot, source.files);
    if (issues.length > 0) {
      throw new Error(`Installed tree verification failed: ${issues.join("; ")}`);
    }
    writeJson(targetRoot, safePath(targetRoot, manifestRelativePath), buildInstallation(source));
    removeOwnedTree(targetRoot, join(stateRoot, "staging"));
    return result;
  } catch (error) {
    removeManagedFiles(targetRoot, createdFiles);
    cleanupEmptyDirectories(targetRoot, createdFiles);
    removeOwnedTree(targetRoot, stateRoot);
    throw new Error(`Install rolled back after failure: ${error.message}`);
  }
}

function createBackup(targetRoot, manifest, backupId, { testFailAfter = 0, testFailBeforeManifest = false } = {}) {
  const backupRoot = safePath(targetRoot, `${stateDirectoryName}/backups/${backupId}`);
  if (existsSync(backupRoot)) {
    throw new Error(`Backup already exists: ${backupId}`);
  }
  const pendingRoot = safePath(targetRoot, `${stateDirectoryName}/staging/${backupId}.pending`);
  if (existsSync(pendingRoot)) {
    throw new Error(`Pending backup already exists: ${backupId}`);
  }
  const pendingPayloadRoot = join(pendingRoot, "payload");
  preflightPaths(targetRoot, [backupRoot, pendingRoot, pendingPayloadRoot]);
  ensureParentDirectories(targetRoot, pendingRoot, []);
  mkdirSync(pendingRoot);
  mkdirSync(pendingPayloadRoot);
  try {
    copyRecords(manifest.files, pendingPayloadRoot, targetRoot, (_record, copied) => {
      maybeFail(copied, testFailAfter, "backup construction");
    });
    const issues = verifyFiles(pendingPayloadRoot, manifest.files);
    if (issues.length > 0) {
      throw new Error(`Backup verification failed: ${issues.join("; ")}`);
    }
    if (testFailBeforeManifest) {
      throw new Error("Injected backup construction failure before manifest publication.");
    }
    const backupManifest = {
      schemaVersion: 1,
      product: "BEYOND",
      backupId,
      createdAt: new Date().toISOString(),
      status: "READY",
      fromVersion: manifest.version,
      fromTreeSha256: manifest.treeSha256,
      installation: manifest,
    };
    writeJson(targetRoot, join(pendingRoot, "backup.json"), backupManifest);
    ensureParentDirectories(targetRoot, backupRoot, []);
    renameSync(pendingRoot, backupRoot);
    return { backupRoot, payloadRoot: join(backupRoot, "payload"), backupManifest };
  } catch (error) {
    removeOwnedTree(targetRoot, pendingRoot);
    throw new Error(`Backup construction failed: ${error.message}`);
  }
}

function updateBackupStatus(targetRoot, backupRoot, backupManifest, status) {
  backupManifest.status = status;
  backupManifest.updatedAt = new Date().toISOString();
  writeJson(targetRoot, join(backupRoot, "backup.json"), backupManifest);
}

function upgrade({ targetRoot, source, dryRun, testFailAfter, testFailBackupAfter, testFailBackupBeforeManifest }) {
  const { path: manifestPath, manifest } = readInstallation(targetRoot);
  const currentIssues = verifyFiles(targetRoot, manifest.files);
  if (currentIssues.length > 0) {
    throw new Error(`Managed tree has drift; upgrade refused: ${currentIssues.join("; ")}`);
  }
  const oldPaths = new Set(manifest.files.map((file) => file.path));
  const collisions = source.files.filter((file) => !oldPaths.has(file.path) && existsSync(safePath(targetRoot, file.path))).map((file) => file.path);
  if (collisions.length > 0) {
    throw new Error(`Upgrade conflicts with unmanaged target files: ${collisions.join(", ")}`);
  }
  if (manifest.version === source.version && manifest.treeSha256 === source.treeSha256) {
    return { command: "upgrade", status: "UP_TO_DATE", target: targetRoot, version: source.version, treeSha256: source.treeSha256, files: source.files.length };
  }
  const backupId = nowId("backup");
  const transactionId = nowId("upgrade");
  const backupRoot = safePath(targetRoot, `${stateDirectoryName}/backups/${backupId}`);
  const pendingRoot = safePath(targetRoot, `${stateDirectoryName}/staging/${backupId}.pending`);
  const stageRoot = safePath(targetRoot, `${stateDirectoryName}/staging/${transactionId}`);
  const transactionPath = safePath(targetRoot, `${stateDirectoryName}/transactions/${transactionId}.json`);
  preflightPaths(targetRoot, [manifestPath, backupRoot, pendingRoot, join(pendingRoot, "payload"), stageRoot, transactionPath]);
  preflightManagedPaths(targetRoot, [...manifest.files, ...source.files]);
  const result = { command: "upgrade", status: dryRun ? "DRY_RUN" : "UPGRADED", target: targetRoot, fromVersion: manifest.version, version: source.version, treeSha256: source.treeSha256, files: source.files.length, backupId };
  if (dryRun) {
    return result;
  }
  const limit = assertTestFailureOption(targetRoot, testFailAfter);
  const backupFailAfter = assertTestFailureOption(targetRoot, testFailBackupAfter);
  const backupFailBeforeManifest = assertTestFailureOption(targetRoot, testFailBackupBeforeManifest ? 1 : 0) > 0;
  const backup = createBackup(targetRoot, manifest, backupId, {
    testFailAfter: backupFailAfter,
    testFailBeforeManifest: backupFailBeforeManifest,
  });
  mkdirSync(stageRoot, { recursive: true });
  copyRecords(source.files, stageRoot);
  const stageIssues = verifyFiles(stageRoot, source.files);
  if (stageIssues.length > 0) {
    throw new Error(`Staged upgrade verification failed: ${stageIssues.join("; ")}`);
  }
  writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "upgrade", status: "PREPARED", backupId, fromVersion: manifest.version, toVersion: source.version });
  const union = [...new Map([...manifest.files, ...source.files].map((file) => [file.path, file])).values()];
  try {
    let changed = 0;
    for (const file of manifest.files.filter((file) => !source.files.some((next) => next.path === file.path))) {
      removeManagedFiles(targetRoot, [file]);
      changed += 1;
      maybeFail(changed, limit, "upgrade");
    }
    for (const file of source.files) {
      const destination = safePath(targetRoot, file.path);
      ensureParentDirectories(targetRoot, destination, []);
      copyFileSync(safePath(stageRoot, file.path), destination);
      changed += 1;
      maybeFail(changed, limit, "upgrade");
    }
    const issues = verifyFiles(targetRoot, source.files);
    if (issues.length > 0) {
      throw new Error(`Upgraded tree verification failed: ${issues.join("; ")}`);
    }
    writeJson(targetRoot, manifestPath, buildInstallation(source, manifest, backupId));
    writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "upgrade", status: "UPGRADED", backupId, fromVersion: manifest.version, toVersion: source.version });
    updateBackupStatus(targetRoot, backup.backupRoot, backup.backupManifest, "AVAILABLE");
    removeOwnedTree(targetRoot, stageRoot);
    cleanupEmptyDirectories(targetRoot, union);
    return result;
  } catch (error) {
    removeManagedFiles(targetRoot, union);
    assertPhysicalPathChain(targetRoot, backup.payloadRoot);
    copyRecords(manifest.files, targetRoot, backup.payloadRoot);
    writeJson(targetRoot, manifestPath, manifest);
    const restoreIssues = verifyFiles(targetRoot, manifest.files);
    const restored = restoreIssues.length === 0;
    writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "upgrade", status: restored ? "ROLLED_BACK_AFTER_FAILURE" : "RECOVERY_FAILED", backupId, error: error.message, recoveryIssues: restoreIssues });
    updateBackupStatus(targetRoot, backup.backupRoot, backup.backupManifest, restored ? "FAILURE_RECOVERY_SOURCE" : "RECOVERY_FAILED");
    removeOwnedTree(targetRoot, stageRoot);
    cleanupEmptyDirectories(targetRoot, union);
    if (!restored) {
      throw new Error(`Upgrade failed and recovery could not be verified: ${error.message}; ${restoreIssues.join("; ")}`);
    }
    throw new Error(`Upgrade rolled back after failure: ${error.message}`);
  }
}

function loadBackup(targetRoot, backupId) {
  if (!backupId || !/^[0-9A-Za-z._-]+$/.test(backupId)) {
    throw new Error("Rollback requires a valid explicit --backup ID.");
  }
  const backupRoot = safePath(targetRoot, `${stateDirectoryName}/backups/${backupId}`);
  const backupPath = join(backupRoot, "backup.json");
  preflightPaths(targetRoot, [backupRoot, backupPath]);
  if (!existsSync(backupPath) || !lstatSync(backupPath).isFile()) {
    throw new Error(`Backup does not exist: ${backupId}`);
  }
  assertNoLinkChain(targetRoot, backupPath);
  const backupManifest = readJson(backupPath, "Backup manifest");
  if (backupManifest.schemaVersion !== 1 || backupManifest.product !== "BEYOND" || backupManifest.backupId !== backupId) {
    throw new Error(`Backup manifest is invalid: ${backupId}`);
  }
  const installation = validateManifest(backupManifest.installation);
  const payloadRoot = join(backupRoot, "payload");
  assertPhysicalPathChain(targetRoot, payloadRoot);
  const issues = verifyFiles(payloadRoot, installation.files);
  if (issues.length > 0) {
    throw new Error(`Backup payload verification failed: ${issues.join("; ")}`);
  }
  return { backupRoot, payloadRoot, backupManifest, installation };
}

function rollback({ targetRoot, backupId, dryRun, testFailAfter }) {
  const { path: manifestPath, manifest } = readInstallation(targetRoot);
  const currentIssues = verifyFiles(targetRoot, manifest.files);
  if (currentIssues.length > 0) {
    throw new Error(`Managed tree has drift; rollback refused: ${currentIssues.join("; ")}`);
  }
  const backup = loadBackup(targetRoot, backupId);
  const currentPaths = new Set(manifest.files.map((file) => file.path));
  const collisions = backup.installation.files.filter((file) => !currentPaths.has(file.path) && existsSync(safePath(targetRoot, file.path))).map((file) => file.path);
  if (collisions.length > 0) {
    throw new Error(`Rollback conflicts with unmanaged target files: ${collisions.join(", ")}`);
  }
  const union = [...new Map([...manifest.files, ...backup.installation.files].map((file) => [file.path, file])).values()];
  const transactionId = nowId("rollback");
  const currentRoot = safePath(targetRoot, `${stateDirectoryName}/staging/${transactionId}/current`);
  const transactionPath = safePath(targetRoot, `${stateDirectoryName}/transactions/${transactionId}.json`);
  preflightPaths(targetRoot, [manifestPath, backup.backupRoot, backup.payloadRoot, currentRoot, transactionPath]);
  preflightManagedPaths(targetRoot, union);
  const result = { command: "rollback", status: dryRun ? "DRY_RUN" : "ROLLED_BACK", target: targetRoot, fromVersion: manifest.version, version: backup.installation.version, backupId };
  if (dryRun) {
    return result;
  }
  const limit = assertTestFailureOption(targetRoot, testFailAfter);
  mkdirSync(currentRoot, { recursive: true });
  copyRecords(manifest.files, currentRoot, targetRoot);
  const snapshotIssues = verifyFiles(currentRoot, manifest.files);
  if (snapshotIssues.length > 0) {
    throw new Error(`Pre-rollback snapshot verification failed: ${snapshotIssues.join("; ")}`);
  }
  writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "rollback", status: "PREPARED", backupId, fromVersion: manifest.version, toVersion: backup.installation.version });
  try {
    removeManagedFiles(targetRoot, manifest.files);
    let changed = 0;
    for (const file of backup.installation.files) {
      const destination = safePath(targetRoot, file.path);
      ensureParentDirectories(targetRoot, destination, []);
      copyFileSync(safePath(backup.payloadRoot, file.path), destination);
      changed += 1;
      maybeFail(changed, limit, "rollback");
    }
    const issues = verifyFiles(targetRoot, backup.installation.files);
    if (issues.length > 0) {
      throw new Error(`Rolled-back tree verification failed: ${issues.join("; ")}`);
    }
    const restoredManifest = { ...backup.installation, updatedAt: new Date().toISOString(), restoredFromBackupId: backupId, previousBackupId: null };
    writeJson(targetRoot, manifestPath, restoredManifest);
    writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "rollback", status: "ROLLED_BACK", backupId, fromVersion: manifest.version, toVersion: backup.installation.version });
    updateBackupStatus(targetRoot, backup.backupRoot, backup.backupManifest, "RESTORED");
    removeOwnedTree(targetRoot, dirname(currentRoot));
    cleanupEmptyDirectories(targetRoot, union);
    return result;
  } catch (error) {
    removeManagedFiles(targetRoot, union);
    assertPhysicalPathChain(targetRoot, currentRoot);
    copyRecords(manifest.files, targetRoot, currentRoot);
    writeJson(targetRoot, manifestPath, manifest);
    const restoreIssues = verifyFiles(targetRoot, manifest.files);
    const restored = restoreIssues.length === 0;
    writeJson(targetRoot, transactionPath, { schemaVersion: 1, transactionId, command: "rollback", status: restored ? "ROLLED_FORWARD_AFTER_FAILURE" : "RECOVERY_FAILED", backupId, error: error.message, recoveryIssues: restoreIssues });
    removeOwnedTree(targetRoot, dirname(currentRoot));
    cleanupEmptyDirectories(targetRoot, union);
    if (!restored) {
      throw new Error(`Rollback failed and the pre-rollback candidate could not be verified: ${error.message}; ${restoreIssues.join("; ")}`);
    }
    throw new Error(`Rollback restored the pre-rollback candidate after failure: ${error.message}`);
  }
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {
    command,
    dryRun: false,
    target: null,
    source: scriptRoot,
    backupId: null,
    testFailAfter: 0,
    testFailBackupAfter: 0,
    testFailBackupBeforeManifest: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--test-fail-backup-before-manifest") {
      options.testFailBackupBeforeManifest = true;
      continue;
    }
    if (["--target", "--source", "--backup", "--test-fail-after", "--test-fail-backup-after"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--target") options.target = value;
      if (argument === "--source") options.source = value;
      if (argument === "--backup") options.backupId = value;
      if (argument === "--test-fail-after" || argument === "--test-fail-backup-after") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`${argument} must be a positive integer.`);
        }
        if (argument === "--test-fail-after") options.testFailAfter = parsed;
        if (argument === "--test-fail-backup-after") options.testFailBackupAfter = parsed;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function help() {
  return [
    "Usage:",
    "  node scripts/beyond-install.mjs install  --target <absolute-project-path> [--source <absolute-source-root>] [--dry-run]",
    "  node scripts/beyond-install.mjs version  --target <absolute-project-path> [--source <absolute-source-root>]",
    "  node scripts/beyond-install.mjs verify   --target <absolute-project-path>",
    "  node scripts/beyond-install.mjs upgrade  --target <absolute-project-path> [--source <absolute-source-root>] [--dry-run]",
    "  node scripts/beyond-install.mjs rollback --target <absolute-project-path> --backup <backup-id> [--dry-run]",
  ].join("\n");
}

function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(help());
    return;
  }
  const options = parseArguments(argv);
  if (!new Set(["install", "version", "verify", "upgrade", "rollback"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  const targetRoot = assertAbsoluteDirectory(options.target, "--target");
  const needsSource = new Set(["install", "upgrade", "version"]).has(options.command);
  const sourceRoot = needsSource ? assertAbsoluteDirectory(resolve(options.source), "--source") : null;
  const source = sourceRoot ? collectSource(sourceRoot) : null;
  if (options.command !== "upgrade" && (options.testFailBackupAfter > 0 || options.testFailBackupBeforeManifest)) {
    throw new Error("Backup-construction failure injection is available only for upgrade.");
  }
  let result;
  if (options.command === "install") {
    result = install({ targetRoot, source, dryRun: options.dryRun, testFailAfter: options.testFailAfter });
  } else if (options.command === "upgrade") {
    result = upgrade({
      targetRoot,
      source,
      dryRun: options.dryRun,
      testFailAfter: options.testFailAfter,
      testFailBackupAfter: options.testFailBackupAfter,
      testFailBackupBeforeManifest: options.testFailBackupBeforeManifest,
    });
  } else if (options.command === "rollback") {
    result = rollback({ targetRoot, backupId: options.backupId, dryRun: options.dryRun, testFailAfter: options.testFailAfter });
  } else if (options.command === "verify") {
    const { manifest } = readInstallation(targetRoot);
    const issues = verifyFiles(targetRoot, manifest.files);
    if (issues.length > 0) {
      throw new Error(`Managed tree verification failed: ${issues.join("; ")}`);
    }
    result = { command: "verify", status: "VERIFIED", target: targetRoot, version: manifest.version, treeSha256: manifest.treeSha256, files: manifest.files.length };
  } else {
    const { manifest } = readInstallation(targetRoot);
    result = { command: "version", status: "VERSION", target: targetRoot, installedVersion: manifest.version, installedTreeSha256: manifest.treeSha256, sourceVersion: source.version, sourceTreeSha256: source.treeSha256 };
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`BEYOND_INSTALL_ERROR: ${error.message}`);
  process.exitCode = 1;
}
