#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function nextArgument(argv, index, token) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail(`${token} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { runtimeRoots: [], canaryOnly: false, requireReady: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--canary-only") options.canaryOnly = true;
    else if (token === "--require-ready") options.requireReady = true;
    else if (token === "--json") options.json = true;
    else if (token === "--stable-root") options.stableRoot = nextArgument(argv, index++, token);
    else if (token === "--stable-git-repo") options.stableGitRepo = nextArgument(argv, index++, token);
    else if (token === "--stable-git-commit") options.stableGitCommit = nextArgument(argv, index++, token);
    else if (token === "--stable-git-subtree") options.stableGitSubtree = nextArgument(argv, index++, token);
    else if (token === "--canary-root") options.canaryRoot = nextArgument(argv, index++, token);
    else if (token === "--manifest") options.manifest = nextArgument(argv, index++, token);
    else if (token === "--runtime-root") options.runtimeRoots.push(nextArgument(argv, index++, token));
    else fail(`Unknown argument: ${token}`);
  }
  if (!options.canaryRoot) fail("--canary-root is required.");
  if (!options.manifest) fail("--manifest is required.");

  const gitValues = [options.stableGitRepo, options.stableGitCommit, options.stableGitSubtree];
  const hasAnyGitValue = gitValues.some(Boolean);
  const hasCompleteGitSource = gitValues.every(Boolean);
  if (options.canaryOnly) {
    if (options.stableRoot || hasAnyGitValue) fail("--canary-only cannot be combined with a stable source.");
  } else if (options.stableRoot && hasAnyGitValue) {
    fail("Choose exactly one stable source: --stable-root or the three --stable-git-* arguments.");
  } else if (!options.stableRoot && !hasCompleteGitSource) {
    fail("A full check requires --stable-root or all of --stable-git-repo, --stable-git-commit, and --stable-git-subtree.");
  }
  return options;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function requireDirectory(input, label) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    fail(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

function requireFile(input, label) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${label} is not a file: ${resolved}`);
  }
  return resolved;
}

function normalizeGitSubtree(input) {
  if (
    typeof input !== "string"
    || input.length === 0
    || input.includes("\\")
    || input.includes("\0")
    || input.startsWith("/")
    || input.endsWith("/")
    || input === ".."
    || input.startsWith("../")
    || path.posix.normalize(input) !== input
  ) {
    fail("--stable-git-subtree must be a normalized relative POSIX path.");
  }
  return input;
}

function runGit(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`Unable to run git: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim() || `exit ${result.status}`;
    fail(`Git command failed (${args[0]}): ${detail}`);
  }
  return result.stdout;
}

function bufferText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

export function reportTree(files) {
  const manifest = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([relative, hash]) => `${relative}\t${hash}`)
    .join("\n");
  return { files, count: files.size, sha256: sha256(Buffer.from(manifest, "utf8")) };
}

export function collectTree(root) {
  const files = new Map();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        files.set(relative, sha256(fs.readFileSync(absolute)));
      }
    }
  }
  walk(root);
  return reportTree(files);
}

export function collectGitTree(repositoryInput, commit, subtreeInput, gitRunner = runGit) {
  const repository = requireDirectory(repositoryInput, "Stable Git repository");
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) {
    fail("--stable-git-commit must be a fixed lowercase 40-character commit SHA.");
  }
  const subtree = normalizeGitSubtree(subtreeInput);
  const resolvedCommit = bufferText(gitRunner(repository, ["rev-parse", "--verify", `${commit}^{commit}`])).trim();
  if (resolvedCommit !== commit) fail("The stable Git commit did not resolve to the exact fixed commit SHA.");

  const objectType = bufferText(gitRunner(repository, ["cat-file", "-t", `${commit}:${subtree}`])).trim();
  if (objectType !== "tree") fail("The stable Git subtree does not resolve to a tree at the fixed commit.");

  const listing = bufferText(gitRunner(repository, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", subtree]));
  const files = new Map();
  const prefix = `${subtree}/`;
  for (const record of listing.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) fail("Unexpected git ls-tree record without a path separator.");
    const metadata = record.slice(0, separator).split(" ");
    const fullPath = record.slice(separator + 1);
    if (metadata.length !== 3 || metadata[1] !== "blob" || !/^[a-f0-9]{40,64}$/.test(metadata[2])) {
      fail(`Unexpected non-blob entry in the stable Git subtree: ${fullPath}`);
    }
    if (!fullPath.startsWith(prefix)) fail(`Git subtree entry escaped the requested subtree: ${fullPath}`);
    const relative = fullPath.slice(prefix.length);
    if (!relative || files.has(relative)) fail(`Invalid or duplicate Git subtree path: ${relative}`);
    const contents = gitRunner(repository, ["cat-file", "blob", metadata[2]]);
    files.set(relative, sha256(Buffer.isBuffer(contents) ? contents : Buffer.from(contents)));
  }
  if (files.size === 0) fail("The stable Git subtree contains no files.");
  return {
    ...reportTree(files),
    source: { type: "git_blob", repository, commit: resolvedCommit, subtree },
  };
}

function assertSha(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256.`);
}

function comparablePath(input) {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathIsStrictlyInside(root, target) {
  const relative = path.relative(root, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateRuntimeRelativePath(relative) {
  const segments = typeof relative === "string" ? relative.split("/") : [];
  if (
    typeof relative !== "string"
    || relative.length === 0
    || relative.includes("\\")
    || relative.includes("\0")
    || path.posix.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(`Runtime managed path must be a normalized relative POSIX file path: ${String(relative)}`);
  }
  return segments;
}

function runtimeLstat(runtimeFs, absolute, label) {
  if (typeof runtimeFs.lstatSync !== "function") fail("Runtime fs dependency must provide lstatSync.");
  try {
    return runtimeFs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`Runtime managed path is missing: ${label}`);
    fail(`Unable to inspect runtime path ${label}: ${error.message}`);
  }
}

function runtimeRealpath(runtimeFs, absolute, label) {
  const resolver = typeof runtimeFs.realpathSync?.native === "function"
    ? runtimeFs.realpathSync.native
    : runtimeFs.realpathSync;
  if (typeof resolver !== "function") fail("Runtime fs dependency must provide realpathSync.");
  try {
    return path.resolve(resolver(absolute));
  } catch (error) {
    fail(`Unable to resolve runtime path ${label}: ${error.message}`);
  }
}

function rejectRuntimeLink(stat, label) {
  // Node exposes ordinary symlinks and Windows junctions through isSymbolicLink().
  // Other Windows reparse tags are not claimed as zero-dependency coverage;
  // realpath equality and root containment still reject observable escapes.
  if (typeof stat.isSymbolicLink !== "function" || stat.isSymbolicLink()) {
    fail(`Runtime path uses a symbolic link or junction: ${label}`);
  }
}

export function collectRuntimeTree(rootInput, canary, runtimeFs = fs) {
  if (!(canary?.files instanceof Map)) fail("Canary file map is required for runtime validation.");
  const root = path.resolve(rootInput);
  const rootStat = runtimeLstat(runtimeFs, root, root);
  rejectRuntimeLink(rootStat, root);
  if (typeof rootStat.isDirectory !== "function" || !rootStat.isDirectory()) {
    fail(`Runtime root is not a directory: ${root}`);
  }
  const rootReal = runtimeRealpath(runtimeFs, root, root);

  const planned = [];
  const plannedTargets = new Set();
  for (const relative of canary.files.keys()) {
    const segments = validateRuntimeRelativePath(relative);
    const target = path.resolve(root, ...segments);
    if (!pathIsStrictlyInside(root, target)) {
      fail(`Runtime managed path escapes the runtime root: ${relative}`);
    }
    const comparableTarget = comparablePath(target);
    if (plannedTargets.has(comparableTarget)) {
      fail(`Runtime managed paths resolve to the same target: ${relative}`);
    }
    plannedTargets.add(comparableTarget);
    planned.push({ relative, segments, target });
  }

  for (const entry of planned) {
    let current = root;
    for (const segment of entry.segments.slice(0, -1)) {
      current = path.join(current, segment);
      const parentStat = runtimeLstat(runtimeFs, current, entry.relative);
      rejectRuntimeLink(parentStat, current);
      if (typeof parentStat.isDirectory !== "function" || !parentStat.isDirectory()) {
        fail(`Runtime managed parent is not a directory: ${entry.relative}`);
      }
      const parentReal = runtimeRealpath(runtimeFs, current, entry.relative);
      if (!pathIsStrictlyInside(rootReal, parentReal)) {
        fail(`Runtime parent real path escapes the runtime root: ${entry.relative}`);
      }
    }

    const targetStat = runtimeLstat(runtimeFs, entry.target, entry.relative);
    rejectRuntimeLink(targetStat, entry.target);
    if (typeof targetStat.isFile !== "function" || !targetStat.isFile()) {
      fail(`Runtime managed path is not a regular file: ${entry.relative}`);
    }
    const targetReal = runtimeRealpath(runtimeFs, entry.target, entry.relative);
    if (!pathIsStrictlyInside(rootReal, targetReal)) {
      fail(`Runtime managed real path escapes the runtime root: ${entry.relative}`);
    }
  }

  if (typeof runtimeFs.readFileSync !== "function") fail("Runtime fs dependency must provide readFileSync.");
  const files = new Map();
  for (const entry of planned) {
    files.set(entry.relative, sha256(runtimeFs.readFileSync(entry.target)));
  }
  return reportTree(files);
}

export function compareRuntime(root, canary, runtimeFs = fs) {
  const resolvedRoot = path.resolve(root);
  const runtime = collectRuntimeTree(resolvedRoot, canary, runtimeFs);
  if (runtime.sha256 !== canary.sha256 || runtime.count !== canary.count) {
    fail(`Runtime root differs from the registered canary: ${resolvedRoot}`);
  }
  return { root: resolvedRoot, file_count: runtime.count, tree_sha256: runtime.sha256 };
}

export function checkPromotion(argv, dependencies = {}) {
  const options = parseArgs(argv);
  const canaryRoot = requireDirectory(options.canaryRoot, "Canary root");
  const manifestPath = requireFile(options.manifest, "Promotion manifest");
  const data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (data.schema_version !== 1) fail("Unsupported manifest schema_version.");
  if (data.policy !== "beyond-skill-canary-promotion") fail("Unexpected promotion policy.");
  if (!data.upstream || !data.canary || !Array.isArray(data.overrides)) fail("Manifest is missing upstream, canary, or overrides.");
  if (!/^(testing|validated|promoted|rejected)$/.test(data.canary.state)) fail("Invalid canary.state.");
  if (!/^(blocked|ready)$/.test(data.canary.promotion_gate)) fail("Invalid canary.promotion_gate.");
  assertSha(data.upstream.tree_sha256, "upstream.tree_sha256");
  assertSha(data.canary.tree_sha256, "canary.tree_sha256");
  assertSha(data.checker_sha256, "checker_sha256");

  const checkerHash = sha256(fs.readFileSync(new URL(import.meta.url)));
  if (checkerHash !== data.checker_sha256) fail("The running checker does not match checker_sha256 in the manifest.");

  const canary = collectTree(canaryRoot);
  if (canary.sha256 !== data.canary.tree_sha256 || canary.count !== data.canary.file_count) {
    fail("Canary tree has unregistered drift.");
  }

  const overrideMap = new Map();
  for (const entry of data.overrides) {
    if (!entry || typeof entry.path !== "string" || entry.path.includes("\\") || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith("../")) {
      fail("Every override path must be a normalized relative POSIX path.");
    }
    if (overrideMap.has(entry.path)) fail(`Duplicate override: ${entry.path}`);
    if (entry.classification !== "generic_candidate") fail(`Skill override must be a generic_candidate: ${entry.path}`);
    if (!/^(red|testing|passed|rejected)$/.test(entry.evidence)) fail(`Invalid evidence state: ${entry.path}`);
    if (!/^(modified|added|removed)$/.test(entry.kind)) fail(`Invalid override kind: ${entry.path}`);
    assertSha(entry.upstream_sha256, `${entry.path}.upstream_sha256`, true);
    assertSha(entry.canary_sha256, `${entry.path}.canary_sha256`, true);
    if (entry.canary_sha256 !== null && canary.files.get(entry.path) !== entry.canary_sha256) {
      fail(`Canary file hash differs from the registered override: ${entry.path}`);
    }
    overrideMap.set(entry.path, entry);
  }

  let stable = null;
  let stableSource = { type: "manifest_only", commit: data.upstream.commit };
  let differences = [];
  if (!options.canaryOnly) {
    if (options.stableRoot) {
      const stableRoot = requireDirectory(options.stableRoot, "Stable root");
      stable = collectTree(stableRoot);
      stableSource = { type: "physical_root", root: stableRoot };
    } else {
      stable = collectGitTree(
        options.stableGitRepo,
        options.stableGitCommit,
        options.stableGitSubtree,
        dependencies.gitRunner ?? runGit,
      );
      stableSource = stable.source;
      if (data.upstream.commit !== stableSource.commit) {
        fail("Manifest upstream.commit does not match the fixed Git commit.");
      }
      if (data.upstream.source_type !== "git_blob") {
        fail("Git blob stable mode requires upstream.source_type=git_blob.");
      }
      if (data.upstream.subtree !== stableSource.subtree) {
        fail("Manifest upstream.subtree does not match the requested Git subtree.");
      }
    }

    if (stable.sha256 !== data.upstream.tree_sha256 || stable.count !== data.upstream.file_count) {
      fail("Stable tree differs from the manifest upstream anchor.");
    }
    const allPaths = new Set([...stable.files.keys(), ...canary.files.keys()]);
    for (const relative of [...allPaths].sort((left, right) => left.localeCompare(right, "en"))) {
      const upstreamHash = stable.files.get(relative) ?? null;
      const canaryHash = canary.files.get(relative) ?? null;
      if (upstreamHash === canaryHash) continue;
      const kind = upstreamHash === null ? "added" : canaryHash === null ? "removed" : "modified";
      differences.push({ path: relative, kind, upstream_sha256: upstreamHash, canary_sha256: canaryHash });
    }
    const actualPaths = differences.map((entry) => entry.path);
    const registeredPaths = [...overrideMap.keys()].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actualPaths) !== JSON.stringify(registeredPaths)) fail("Stable/canary differences do not exactly match the registered overrides.");
    for (const difference of differences) {
      const registered = overrideMap.get(difference.path);
      if (registered.kind !== difference.kind || registered.upstream_sha256 !== difference.upstream_sha256 || registered.canary_sha256 !== difference.canary_sha256) {
        fail(`Registered override does not match the actual stable/canary difference: ${difference.path}`);
      }
    }

    const forbidden = data.public_safety?.forbidden_patterns;
    if (!Array.isArray(forbidden) || forbidden.length === 0) fail("public_safety.forbidden_patterns must be a non-empty array.");
    for (const difference of differences) {
      if (difference.canary_sha256 === null) continue;
      const contents = fs.readFileSync(path.join(canaryRoot, ...difference.path.split("/")), "utf8");
      for (const marker of forbidden) {
        if (typeof marker !== "string" || marker.length === 0) fail("Forbidden patterns must be non-empty strings.");
        if (contents.includes(marker)) fail(`Generic candidate contains a project-private marker in ${difference.path}.`);
      }
    }
  }

  const runtime = options.runtimeRoots.map((root) => compareRuntime(root, canary, dependencies.runtimeFs ?? fs));
  const allPassed = data.overrides.every((entry) => entry.evidence === "passed");
  if (data.canary.promotion_gate === "ready" && (data.canary.state !== "validated" || !allPassed)) {
    fail("promotion_gate=ready requires canary.state=validated and every override evidence=passed.");
  }
  if (data.canary.state === "promoted" && data.overrides.length !== 0) fail("A promoted canary cannot retain overrides.");
  if (options.requireReady && data.canary.promotion_gate !== "ready") fail("Promotion is blocked by the canary manifest.");

  return {
    status: "PASS",
    policy_version: data.canary.policy_version,
    canary_state: data.canary.state,
    promotion_gate: data.canary.promotion_gate,
    stable_source: stableSource,
    stable_tree_sha256: stable?.sha256 ?? data.upstream.tree_sha256,
    canary_tree_sha256: canary.sha256,
    file_count: canary.count,
    override_count: data.overrides.length,
    runtime_roots: runtime,
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("CANARY_ALIGNMENT: PASS");
  console.log(`POLICY_VERSION: ${result.policy_version}`);
  console.log(`CANARY_STATE: ${result.canary_state}`);
  console.log(`PROMOTION_GATE: ${result.promotion_gate.toUpperCase()}`);
  console.log(`STABLE_SOURCE: ${result.stable_source.type}`);
  if (result.stable_source.type === "git_blob") {
    console.log(`STABLE_REPOSITORY: ${result.stable_source.repository}`);
    console.log(`STABLE_COMMIT: ${result.stable_source.commit}`);
    console.log(`STABLE_SUBTREE: ${result.stable_source.subtree}`);
  } else if (result.stable_source.type === "physical_root") {
    console.log(`STABLE_ROOT: ${result.stable_source.root}`);
  } else {
    console.log(`STABLE_COMMIT: ${result.stable_source.commit}`);
  }
  console.log(`OVERRIDES: ${result.override_count}`);
  console.log(`STABLE_TREE_SHA256: ${result.stable_tree_sha256}`);
  console.log(`CANARY_TREE_SHA256: ${result.canary_tree_sha256}`);
  console.log(`RUNTIME_ROOTS: ${result.runtime_roots.length}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = checkPromotion(process.argv.slice(2));
    printResult(result, process.argv.includes("--json"));
  } catch (error) {
    console.error(`CANARY_ALIGNMENT: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
