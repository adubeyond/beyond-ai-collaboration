import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  checkPromotion,
  collectGitTree,
  collectRuntimeTree,
  collectTree,
  compareRuntime,
} from "./check-skill-promotion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(scriptDirectory, "check-skill-promotion.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beyond-skill-promotion-"));
const manifestPath = path.join(temporaryRoot, "promotion.json");
const stableRoot = path.join(temporaryRoot, "stable");
const crlfStableRoot = path.join(temporaryRoot, "stable-crlf");
const canaryRoot = path.join(temporaryRoot, "canary");
const runtimeRoot = path.join(temporaryRoot, "runtime");
const runtimeRootTwo = path.join(temporaryRoot, "runtime-two");
const canary32Root = path.join(temporaryRoot, "canary-32");
const runtime32Root = path.join(temporaryRoot, "runtime-32");
const gitRepository = path.join(temporaryRoot, "git-fixture");
const gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gitSubtree = "模板交付包/skills";
const candidatePath = "identity-worker/SKILL.md";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function write(relative, contents) {
  const absolute = path.join(temporaryRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function createManifest({
  stable,
  canary,
  upstreamCommit = "fixture",
  upstreamTreeSha256 = stable.sha256,
  overrides = [{
    path: candidatePath,
    kind: "modified",
    upstream_sha256: stable.files.get(candidatePath),
    canary_sha256: canary.files.get(candidatePath),
    classification: "generic_candidate",
    evidence: "testing",
  }],
}) {
  return {
    schema_version: 1,
    policy: "beyond-skill-canary-promotion",
    checker_sha256: sha256(fs.readFileSync(checker)),
    upstream: {
      product: "BEYOND",
      version: "fixture",
      commit: upstreamCommit,
      source_type: "git_blob",
      subtree: gitSubtree,
      file_count: stable.count,
      tree_sha256: upstreamTreeSha256,
    },
    canary: {
      policy_version: "fixture-canary",
      state: "testing",
      promotion_gate: "blocked",
      file_count: canary.count,
      tree_sha256: canary.sha256,
    },
    public_safety: { forbidden_patterns: ["WST-"] },
    overrides,
  };
}

function writeManifest(manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function physicalArgs(extra = []) {
  return [
    "--stable-root", stableRoot,
    "--canary-root", canaryRoot,
    "--manifest", manifestPath,
    "--runtime-root", runtimeRoot,
    ...extra,
  ];
}

function gitArgs(extra = []) {
  return [
    "--stable-git-repo", gitRepository,
    "--stable-git-commit", gitCommit,
    "--stable-git-subtree", gitSubtree,
    "--canary-root", canaryRoot,
    "--manifest", manifestPath,
    "--runtime-root", runtimeRoot,
    ...extra,
  ];
}

function runPhysical(extra = []) {
  return spawnSync(process.execPath, [checker, ...physicalArgs(extra)], { encoding: "utf8" });
}

function createFakeGitRunner(files) {
  const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
  const objects = new Map(entries.map(([relative, contents], index) => [String(index + 1).padStart(40, "0"), { relative, contents }]));
  return (_repository, args) => {
    if (args[0] === "rev-parse") return Buffer.from(`${gitCommit}\n`, "utf8");
    if (args[0] === "cat-file" && args[1] === "-t") return Buffer.from("tree\n", "utf8");
    if (args[0] === "ls-tree") {
      const records = [...objects.entries()].map(([objectId, entry]) => (
        `100644 blob ${objectId}\t${gitSubtree}/${entry.relative}\0`
      ));
      return Buffer.from(records.join(""), "utf8");
    }
    if (args[0] === "cat-file" && args[1] === "blob") {
      const entry = objects.get(args[2]);
      if (!entry) throw new Error(`Unknown fixture blob: ${args[2]}`);
      return entry.contents;
    }
    throw new Error(`Unexpected fake git arguments: ${args.join(" ")}`);
  };
}

function createRuntimeFsProbe(forbiddenPathFragments = []) {
  const calls = { lstat: [], realpath: [], readFile: [], readdir: 0 };
  function rejectForbidden(absolute) {
    const resolved = path.resolve(absolute);
    if (forbiddenPathFragments.some((fragment) => resolved.includes(fragment))) {
      throw new Error(`Runtime probe touched a forbidden path: ${resolved}`);
    }
  }
  return {
    calls,
    api: {
      lstatSync(absolute) {
        rejectForbidden(absolute);
        calls.lstat.push(path.resolve(absolute));
        return fs.lstatSync(absolute);
      },
      realpathSync(absolute) {
        rejectForbidden(absolute);
        calls.realpath.push(path.resolve(absolute));
        return fs.realpathSync.native(absolute);
      },
      readFileSync(absolute) {
        rejectForbidden(absolute);
        calls.readFile.push(path.resolve(absolute));
        return fs.readFileSync(absolute);
      },
      readdirSync() {
        calls.readdir += 1;
        throw new Error("Runtime validation must not enumerate directories.");
      },
    },
  };
}

function fakeSymlinkLstat(baseApi, symlinkPath) {
  const resolvedLink = path.resolve(symlinkPath);
  return {
    ...baseApi,
    lstatSync(absolute) {
      const stat = fs.lstatSync(absolute);
      if (path.resolve(absolute) !== resolvedLink) return stat;
      return {
        isSymbolicLink: () => true,
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
      };
    },
  };
}

try {
  const stableContents = Buffer.from("stable\n", "utf8");
  const canaryContents = Buffer.from("canary\n", "utf8");
  write("stable/identity-worker/SKILL.md", stableContents);
  write("stable-crlf/identity-worker/SKILL.md", Buffer.from("stable\r\n", "utf8"));
  write("canary/identity-worker/SKILL.md", canaryContents);
  write("runtime/identity-worker/SKILL.md", canaryContents);
  write("runtime/unrelated-personal-skill/SKILL.md", Buffer.from("unmanaged\n", "utf8"));
  write("runtime-two/identity-worker/SKILL.md", canaryContents);
  write("runtime-two/manifest-outside-decoy/do-not-read.txt", Buffer.from("decoy\n", "utf8"));
  for (let index = 0; index < 32; index += 1) {
    const relative = `skill-${String(index).padStart(2, "0")}/managed.txt`;
    const contents = Buffer.from(`managed-${index}\n`, "utf8");
    write(`canary-32/${relative}`, contents);
    write(`runtime-32/${relative}`, contents);
  }
  fs.mkdirSync(gitRepository, { recursive: true });

  const stable = collectTree(stableRoot);
  let canary = collectTree(canaryRoot);
  writeManifest(createManifest({ stable, canary }));

  const physicalValid = runPhysical();
  assert.equal(physicalValid.status, 0, physicalValid.stderr);
  assert.match(physicalValid.stdout, /CANARY_ALIGNMENT: PASS/);
  assert.match(physicalValid.stdout, /PROMOTION_GATE: BLOCKED/);
  assert.match(physicalValid.stdout, /STABLE_SOURCE: physical_root/);

  const fakeGitRunner = createFakeGitRunner(new Map([[candidatePath, stableContents]]));
  const gitStable = collectGitTree(gitRepository, gitCommit, gitSubtree, fakeGitRunner);
  assert.equal(gitStable.sha256, stable.sha256);
  assert.equal(gitStable.files.get(candidatePath), stable.files.get(candidatePath));
  writeManifest(createManifest({ stable: gitStable, canary, upstreamCommit: gitCommit }));
  const gitValid = checkPromotion(gitArgs(), { gitRunner: fakeGitRunner });
  assert.equal(gitValid.status, "PASS");
  assert.deepEqual(gitValid.stable_source, {
    type: "git_blob",
    repository: path.resolve(gitRepository),
    commit: gitCommit,
    subtree: gitSubtree,
  });

  assert.doesNotMatch(collectRuntimeTree.toString(), /collectTree|readdirSync|glob/);
  assert.doesNotMatch(compareRuntime.toString(), /collectTree|readdirSync|glob/);

  const runtimeProbe = createRuntimeFsProbe([path.join("unrelated-personal-skill", "SKILL.md")]);
  const targetedRuntime = checkPromotion(gitArgs(), {
    gitRunner: fakeGitRunner,
    runtimeFs: runtimeProbe.api,
  });
  assert.equal(targetedRuntime.status, "PASS");
  assert.equal(runtimeProbe.calls.readdir, 0);
  assert.deepEqual(runtimeProbe.calls.readFile, [path.resolve(runtimeRoot, ...candidatePath.split("/"))]);

  const twoRuntimeProbe = createRuntimeFsProbe([
    path.join("unrelated-personal-skill", "SKILL.md"),
    path.join("manifest-outside-decoy", "do-not-read.txt"),
  ]);
  const twoRuntimeValid = checkPromotion([
    ...gitArgs(),
    "--runtime-root", runtimeRootTwo,
  ], {
    gitRunner: fakeGitRunner,
    runtimeFs: twoRuntimeProbe.api,
  });
  assert.equal(twoRuntimeValid.runtime_roots.length, 2);
  assert.equal(twoRuntimeProbe.calls.readdir, 0);
  assert.equal(twoRuntimeProbe.calls.readFile.length, 2);

  const canary32 = collectTree(canary32Root);
  assert.equal(canary32.count, 32);
  const runtime32 = compareRuntime(runtime32Root, canary32);
  assert.equal(runtime32.file_count, 32);
  assert.equal(runtime32.tree_sha256, canary32.sha256);

  const invalidManagedPaths = [
    "/absolute/file.txt",
    "C:/absolute/file.txt",
    "//server/share/file.txt",
    "\\\\server\\share\\file.txt",
    "skill\\file.txt",
    "skill/../file.txt",
    "skill/./file.txt",
    "skill//file.txt",
    "skill/\0file.txt",
  ];
  for (const invalidPath of invalidManagedPaths) {
    assert.throws(
      () => collectRuntimeTree(runtimeRoot, { files: new Map([[invalidPath, "0".repeat(64)]]) }),
      /normalized relative POSIX file path/,
      invalidPath,
    );
  }

  const missingRuntimeRoot = path.join(temporaryRoot, "runtime-missing");
  fs.mkdirSync(missingRuntimeRoot, { recursive: true });
  assert.throws(
    () => collectRuntimeTree(missingRuntimeRoot, {
      files: new Map([["managed/missing.txt", "0".repeat(64)]]),
    }),
    /Runtime managed path is missing/,
  );

  const driftCanaryRoot = path.join(temporaryRoot, "canary-drift");
  const driftRuntimeRoot = path.join(temporaryRoot, "runtime-managed-drift");
  write("canary-drift/managed/file.txt", Buffer.from("expected\n", "utf8"));
  write("runtime-managed-drift/managed/file.txt", Buffer.from("different\n", "utf8"));
  assert.throws(
    () => compareRuntime(driftRuntimeRoot, collectTree(driftCanaryRoot)),
    /Runtime root differs from the registered canary/,
  );

  const linkCanaryRoot = path.join(temporaryRoot, "canary-link");
  const linkCanaryContents = Buffer.from("linked\n", "utf8");
  write("canary-link/managed/file.txt", linkCanaryContents);
  const linkCanary = collectTree(linkCanaryRoot);
  const runtimeApi = {
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync.native,
    readFileSync: fs.readFileSync,
  };

  const targetLinkRoot = path.join(temporaryRoot, "runtime-target-link");
  const targetLink = path.join(targetLinkRoot, "managed", "file.txt");
  const targetLinkSource = path.join(temporaryRoot, "target-link-source.txt");
  write("target-link-source.txt", linkCanaryContents);
  fs.mkdirSync(path.dirname(targetLink), { recursive: true });
  let targetSymlinkMode = "actual";
  let targetSymlinkError = null;
  try {
    fs.symlinkSync(targetLinkSource, targetLink, "file");
  } catch (error) {
    targetSymlinkError = error;
  }
  if (targetSymlinkError === null) {
    assert.throws(() => compareRuntime(targetLinkRoot, linkCanary), /symbolic link or junction/);
  } else {
    targetSymlinkMode = `injected(${targetSymlinkError.code ?? targetSymlinkError.message})`;
    write("runtime-target-link/managed/file.txt", linkCanaryContents);
    assert.throws(
      () => compareRuntime(targetLinkRoot, linkCanary, fakeSymlinkLstat(runtimeApi, targetLink)),
      /symbolic link or junction/,
    );
  }

  const parentLinkRoot = path.join(temporaryRoot, "runtime-parent-link");
  const parentLink = path.join(parentLinkRoot, "managed");
  const parentLinkSource = path.join(temporaryRoot, "parent-link-source");
  write("parent-link-source/file.txt", linkCanaryContents);
  fs.mkdirSync(parentLinkRoot, { recursive: true });
  let parentSymlinkMode = "actual";
  let parentSymlinkError = null;
  try {
    fs.symlinkSync(parentLinkSource, parentLink, "dir");
  } catch (error) {
    parentSymlinkError = error;
  }
  if (parentSymlinkError === null) {
    assert.throws(() => compareRuntime(parentLinkRoot, linkCanary), /symbolic link or junction/);
  } else {
    parentSymlinkMode = `injected(${parentSymlinkError.code ?? parentSymlinkError.message})`;
    write("runtime-parent-link/managed/file.txt", linkCanaryContents);
    assert.throws(
      () => compareRuntime(parentLinkRoot, linkCanary, fakeSymlinkLstat(runtimeApi, parentLink)),
      /symbolic link or junction/,
    );
  }

  const rootLinkTarget = path.join(temporaryRoot, "runtime-root-link-target");
  const rootLink = path.join(temporaryRoot, "runtime-root-link");
  write("runtime-root-link-target/managed/file.txt", linkCanaryContents);
  let rootSymlinkMode = "actual";
  let rootSymlinkError = null;
  try {
    fs.symlinkSync(rootLinkTarget, rootLink, "dir");
  } catch (error) {
    rootSymlinkError = error;
  }
  if (rootSymlinkError === null) {
    assert.throws(() => compareRuntime(rootLink, linkCanary), /symbolic link or junction/);
  } else {
    rootSymlinkMode = `injected(${rootSymlinkError.code ?? rootSymlinkError.message})`;
    const fakeRootApi = fakeSymlinkLstat(runtimeApi, rootLinkTarget);
    assert.throws(() => compareRuntime(rootLinkTarget, linkCanary, fakeRootApi), /symbolic link or junction/);
  }

  const junctionRoot = path.join(temporaryRoot, "runtime-junction");
  const junctionPath = path.join(junctionRoot, "managed");
  fs.mkdirSync(junctionRoot, { recursive: true });
  let junctionResult = "not-applicable";
  if (process.platform === "win32") {
    try {
      fs.symlinkSync(parentLinkSource, junctionPath, "junction");
      assert.throws(() => compareRuntime(junctionRoot, linkCanary), /symbolic link or junction/);
      junctionResult = "PASS";
    } catch (error) {
      junctionResult = `SKIP(${error.code ?? error.message})`;
    }
  }

  const escapeRoot = path.join(temporaryRoot, "runtime-realpath-escape");
  const escapeTarget = path.join(escapeRoot, "managed", "file.txt");
  write("runtime-realpath-escape/managed/file.txt", linkCanaryContents);
  const escapeApi = {
    ...runtimeApi,
    realpathSync(absolute) {
      if (path.resolve(absolute) === path.resolve(escapeTarget)) {
        return path.join(temporaryRoot, "outside-runtime", "file.txt");
      }
      return fs.realpathSync.native(absolute);
    },
  };
  assert.throws(
    () => compareRuntime(escapeRoot, linkCanary, escapeApi),
    /real path escapes the runtime root/,
  );

  const crlfStable = collectTree(crlfStableRoot);
  assert.notEqual(crlfStable.sha256, gitStable.sha256);
  assert.throws(
    () => checkPromotion([
      "--stable-root", crlfStableRoot,
      "--canary-root", canaryRoot,
      "--manifest", manifestPath,
      "--runtime-root", runtimeRoot,
    ]),
    /Stable tree differs from the manifest upstream anchor/,
  );

  writeManifest(createManifest({
    stable: gitStable,
    canary,
    upstreamCommit: gitCommit,
    upstreamTreeSha256: "0".repeat(64),
  }));
  assert.throws(
    () => checkPromotion(gitArgs(), { gitRunner: fakeGitRunner }),
    /Stable tree differs from the manifest upstream anchor/,
  );

  write("canary/identity-worker/unregistered.md", Buffer.from("drift\n", "utf8"));
  canary = collectTree(canaryRoot);
  writeManifest(createManifest({ stable: gitStable, canary, upstreamCommit: gitCommit }));
  assert.throws(
    () => checkPromotion(gitArgs(), { gitRunner: fakeGitRunner }),
    /Stable\/canary differences do not exactly match the registered overrides/,
  );
  fs.rmSync(path.join(canaryRoot, "identity-worker/unregistered.md"));
  canary = collectTree(canaryRoot);

  writeManifest(createManifest({
    stable: gitStable,
    canary,
    upstreamCommit: gitCommit,
    upstreamTreeSha256: "0".repeat(64),
  }));
  const canaryOnly = checkPromotion([
    "--canary-only",
    "--canary-root", canaryRoot,
    "--manifest", manifestPath,
  ]);
  assert.equal(canaryOnly.status, "PASS");
  assert.equal(canaryOnly.stable_source.type, "manifest_only");
  assert.equal(canaryOnly.stable_tree_sha256, "0".repeat(64));

  assert.throws(
    () => checkPromotion([
      "--canary-only",
      "--canary-root", canaryRoot,
      "--manifest", manifestPath,
      "--require-ready",
    ]),
    /Promotion is blocked/,
  );

  const privateContents = Buffer.from("WST-private\n", "utf8");
  write("canary/identity-worker/SKILL.md", privateContents);
  write("runtime/identity-worker/SKILL.md", privateContents);
  canary = collectTree(canaryRoot);
  writeManifest(createManifest({ stable, canary }));
  const privateLeak = runPhysical();
  assert.notEqual(privateLeak.status, 0);
  assert.match(privateLeak.stderr, /project-private marker/);

  write("canary/identity-worker/SKILL.md", canaryContents);
  write("runtime/identity-worker/SKILL.md", Buffer.from("runtime-drift\n", "utf8"));
  canary = collectTree(canaryRoot);
  writeManifest(createManifest({ stable, canary }));
  const runtimeDrift = runPhysical();
  assert.notEqual(runtimeDrift.status, 0);
  assert.match(runtimeDrift.stderr, /Runtime root differs/);

  console.log(
    `Skill promotion checker tests passed: 20/20; `
    + `target-symlink=${targetSymlinkMode}; parent-symlink=${parentSymlinkMode}; `
    + `root-symlink=${rootSymlinkMode}; junction=${junctionResult}`,
  );
} finally {
  const resolved = path.resolve(temporaryRoot);
  const expectedPrefix = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith("beyond-skill-promotion-")) {
    throw new Error(`Refusing to remove unexpected test root: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
