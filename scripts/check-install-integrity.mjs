import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = process.env.BEYOND_TEST_PRODUCT_ROOT
  ? resolve(process.env.BEYOND_TEST_PRODUCT_ROOT) : join(repositoryRoot, "模板交付包");
const verifier = join(packageRoot, "scripts", "verify-install-integrity.mjs");
const releaseVersion = JSON.parse(readFileSync(join(packageRoot, "beyond-release.json"), "utf8")).releaseVersion;
const scratch = mkdtempSync(join(tmpdir(), "beyond-install-integrity-"));
let passed = 0;
const errors = [];

function run(name, expectedStatus, skillsRoot, agentsPath, expectedText, contentOnly = true) {
  const args = [verifier, "--installed-skills-root", skillsRoot, "--project-agents", agentsPath];
  if (contentOnly) args.push("--content-only");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== expectedStatus || (expectedText && !output.includes(expectedText))) {
    errors.push(`${name}：期望退出码${expectedStatus}且包含“${expectedText}”，实际退出码${result.status}\n${output}`);
  } else passed += 1;
}

function copySkills(root) {
  cpSync(join(packageRoot, "skills"), join(root, "skills"), { recursive: true });
}

function fusedEntry(controlRelative, projectId) {
  return cpEntry()
    .replace(
      `<!-- BEYOND-RUNTIME-VERSION: ${releaseVersion} -->`,
      `<!-- BEYOND-RUNTIME-VERSION: ${releaseVersion} -->\n<!-- BEYOND-CONTROL-ROOT: ${controlRelative} -->\n<!-- BEYOND-PROJECT-ID: ${projectId} -->`,
    )
    .replace(/\]\(docs\//g, `](${controlRelative}/docs/`)
    .replace(/\]\(local\//g, `](${controlRelative}/local/`)
    .replace(/\]\(projects\//g, `](${controlRelative}/projects/`)
    + "\n\n<!-- BEGIN PROJECT NATIVE RULES -->\n# 原项目规则\n\n- 保留真实测试命令。\n<!-- END PROJECT NATIVE RULES -->\n";
}

function cpEntry() {
  return readFileSync(join(packageRoot, "AGENTS.md"), "utf8");
}

function writeProjectOverview(controlRoot, projectId) {
  const path = join(controlRoot, "projects", projectId, "项目总览.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# 安装验真项目总览

## 项目初始化

<!-- BEGIN BEYOND PROJECT INITIALIZATION -->
\`\`\`json
{"schemaVersion":1,"status":"awaiting-choice","mode":null,"approvedBy":null,"approvedAt":null,"groups":{"overview":null,"architecture":null,"development":null,"testing":null,"operations":null,"security":null,"other":null},"completedAt":null}
\`\`\`
<!-- END BEYOND PROJECT INITIALIZATION -->

## Worker运行策略

<!-- BEGIN BEYOND WORKER POLICY -->
\`\`\`json
{"schemaVersion":1,"mode":"platform-default","scope":"new-formal-worker","confirmed":false,"approvedBy":null,"approvedAt":null}
\`\`\`
<!-- END BEYOND WORKER POLICY -->
`, "utf8");
}

function writeLocalRegistration(controlRoot, projectId, projectRoot, options = {}) {
  const registration = join(controlRoot, "local", "projects", `${projectId}.md`);
  mkdirSync(dirname(registration), { recursive: true });
  const registeredId = options.id ?? projectId;
  const registeredPath = options.path ?? projectRoot;
  const repositoriesJson = options.repositoriesJson
    ?? JSON.stringify([{ path: registeredPath, remote: null, role: "project-root" }]);
  writeFileSync(registration, [
    "---", `id: ${registeredId}`, `path: ${registeredPath}`,
    ...(options.hostId !== undefined ? [`host_id: ${options.hostId}`] : []),
    ...(options.codexProjectId !== undefined ? [`codex_project_id: ${options.codexProjectId}`] : []),
    `repositories_json: ${repositoriesJson}`,
    "---", "",
  ].join("\n"), "utf8");
}

try {
  const exactRoot = join(scratch, "exact");
  copySkills(exactRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(exactRoot, "AGENTS.md"));
  run("完全一致内容", 0, join(exactRoot, "skills"), join(exactRoot, "AGENTS.md"), "内容验真通过");

  const controlRoot = join(scratch, "beyond-control");
  cpSync(packageRoot, controlRoot, { recursive: true });
  const policyProjectId = "project-aabbccddeeff";
  writeProjectOverview(controlRoot, policyProjectId);
  writeProjectOverview(controlRoot, "project-third-party");
  const fusedRoot = join(scratch, "fused");
  copySkills(fusedRoot);
  writeLocalRegistration(controlRoot, policyProjectId, fusedRoot);
  writeFileSync(join(fusedRoot, "AGENTS.md"), fusedEntry("../beyond-control", policyProjectId), "utf8");
  run("完整融合项目入口", 0, join(fusedRoot, "skills"), join(fusedRoot, "AGENTS.md"), "安装验真通过", false);

  // Exercise the real setter and full verifier together, not content-only checks.
  const policyOverview = join(controlRoot, "projects", policyProjectId, "项目总览.md");
  const originalOverview = readFileSync(policyOverview, "utf8");
  const policyCli = join(controlRoot, "scripts", "beyond-control.mjs");
  const modes = ["platform-default", "beyond-worker-gpt61-v4", "beyond-worker-matrix-v1", "beyond-worker-sweetspots-v2", "beyond-worker-gpt6-v3"];
  function replacePolicy(policy) {
    writeFileSync(policyOverview, originalOverview.replace(
      /(<!-- BEGIN BEYOND WORKER POLICY -->)[\s\S]*?(<!-- END BEYOND WORKER POLICY -->)/,
      `$1\n\`\`\`json\n${JSON.stringify(policy)}\n\`\`\`\n$2`,
    ), "utf8");
  }
  function verifyPolicy(name, status, expectedText) {
    const before = readFileSync(policyOverview);
    run(name, status, join(fusedRoot, "skills"), join(fusedRoot, "AGENTS.md"), expectedText, false);
    if (!before.equals(readFileSync(policyOverview))) errors.push(`${name}：验真修改了项目策略`);
  }
  for (const mode of modes) {
    writeFileSync(policyOverview, originalOverview);
    const historical = !["platform-default", "beyond-worker-gpt61-v4"].includes(mode);
    const set = historical ? null : spawnSync(process.execPath, [policyCli, "worker-policy", "--action", "set",
      "--project-id", policyProjectId, "--mode", mode, "--approved-by", "isolated-test-explicit-approval"],
    { encoding: "utf8", windowsHide: true });
    if (set && set.status !== 0) throw new Error(`策略保存失败：${mode}\n${set.stdout}\n${set.stderr}`);
    const saved = historical ? { schemaVersion: 1, mode,
      scope: mode.endsWith("v1") ? "new-formal-worker" : "formal-worker-stages",
      confirmed: true, approvedBy: "historical-approval", approvedAt: "2026-10-02T00:00:00.000Z" }
      : JSON.parse(set.stdout).policy;
    if (historical) replacePolicy(saved);
    const show = spawnSync(process.execPath, [policyCli, "worker-policy", "--action", "show",
      "--project-id", policyProjectId], { encoding: "utf8", windowsHide: true });
    if (show.status !== 0 || JSON.parse(show.stdout).policy.mode !== mode) throw new Error(`策略读取失败：${mode}`);
    verifyPolicy(`${mode}实际set/show后完整验真`, 0, "安装验真通过");
    for (const [name, patch, expected] of [
      ["交叉scope", { scope: saved.scope === "formal-worker-stages" ? "new-formal-worker" : "formal-worker-stages" }, "字段无效"],
      ["缺失scope", { scope: undefined }, "字段无效"],
      ["缺失批准人", { approvedBy: null }, "缺少有效批准依据或时间"],
      ["缺失批准时间", { approvedAt: null }, "缺少有效批准依据或时间"],
      ["无效批准时间", { approvedAt: "invalid-date" }, "缺少有效批准依据或时间"],
      ["错误confirmed类型", { confirmed: "true" }, "字段无效"],
      ["错误schema", { schemaVersion: 2 }, "字段无效"],
    ]) {
      replacePolicy({ ...saved, ...patch });
      verifyPolicy(`${mode}${name}`, 1, expected);
    }
    writeFileSync(policyOverview, originalOverview);
    const missingApproval = spawnSync(process.execPath, [policyCli, "worker-policy", "--action", "set",
      "--project-id", policyProjectId, "--mode", mode], { encoding: "utf8", windowsHide: true });
    if (missingApproval.status === 0 || !`${missingApproval.stderr}${missingApproval.stdout}`.includes(historical ? "Worker运行策略无效" : "明确批准依据")
      || readFileSync(policyOverview, "utf8") !== originalOverview) errors.push(`${mode}无批准set未正确拒绝`);
    else passed += 1;
  }
  for (const mode of ["unknown-policy", "__proto__", "constructor", null]) {
    replacePolicy({ schemaVersion: 1, mode, scope: "new-formal-worker", confirmed: false });
    verifyPolicy(`非法模式${mode}`, 1, "字段无效");
  }
  writeFileSync(policyOverview, originalOverview);

  const wrongRegistrationPathId = "project-wrong-registration-path";
  writeProjectOverview(controlRoot, wrongRegistrationPathId);
  const wrongRegistrationPathRoot = join(scratch, "wrong-registration-path");
  copySkills(wrongRegistrationPathRoot);
  writeLocalRegistration(controlRoot, wrongRegistrationPathId, wrongRegistrationPathRoot, {
    path: join(scratch, "another-project-root"),
  });
  writeFileSync(
    join(wrongRegistrationPathRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", wrongRegistrationPathId),
    "utf8",
  );
  run("本机登记指向另一项目", 1, join(wrongRegistrationPathRoot, "skills"),
    join(wrongRegistrationPathRoot, "AGENTS.md"), "本机项目登记路径与当前项目根不一致", false);

  const wrongRegistrationId = "project-wrong-registration-id";
  writeProjectOverview(controlRoot, wrongRegistrationId);
  const wrongRegistrationIdRoot = join(scratch, "wrong-registration-id");
  copySkills(wrongRegistrationIdRoot);
  writeLocalRegistration(controlRoot, wrongRegistrationId, wrongRegistrationIdRoot, { id: "project-other-id" });
  writeFileSync(
    join(wrongRegistrationIdRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", wrongRegistrationId),
    "utf8",
  );
  run("本机登记编号与入口冲突", 1, join(wrongRegistrationIdRoot, "skills"),
    join(wrongRegistrationIdRoot, "AGENTS.md"), "本机项目登记编号与项目入口不一致", false);

  const invalidRepositoriesId = "project-invalid-repositories";
  writeProjectOverview(controlRoot, invalidRepositoriesId);
  const invalidRepositoriesRoot = join(scratch, "invalid-repositories");
  copySkills(invalidRepositoriesRoot);
  writeLocalRegistration(controlRoot, invalidRepositoriesId, invalidRepositoriesRoot, { repositoriesJson: "not-json" });
  writeFileSync(
    join(invalidRepositoriesRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", invalidRepositoriesId),
    "utf8",
  );
  run("本机登记仓库列表无效", 1, join(invalidRepositoriesRoot, "skills"),
    join(invalidRepositoriesRoot, "AGENTS.md"), "本机项目登记缺少有效repositories_json", false);

  const emptyRepositoriesId = "project-empty-repositories";
  writeProjectOverview(controlRoot, emptyRepositoriesId);
  const emptyRepositoriesRoot = join(scratch, "empty-repositories");
  copySkills(emptyRepositoriesRoot);
  writeLocalRegistration(controlRoot, emptyRepositoriesId, emptyRepositoriesRoot, { repositoriesJson: "[]" });
  writeFileSync(
    join(emptyRepositoriesRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", emptyRepositoriesId),
    "utf8",
  );
  run("非Git项目根允许没有登记Git执行仓", 0, join(emptyRepositoriesRoot, "skills"),
    join(emptyRepositoriesRoot, "AGENTS.md"), "安装验真通过", false);

  const invalidRepositoryEntryId = "project-invalid-repository-entry";
  writeProjectOverview(controlRoot, invalidRepositoryEntryId);
  const invalidRepositoryEntryRoot = join(scratch, "invalid-repository-entry");
  copySkills(invalidRepositoryEntryRoot);
  writeLocalRegistration(controlRoot, invalidRepositoryEntryId, invalidRepositoryEntryRoot, {
    repositoriesJson: JSON.stringify([
      { path: invalidRepositoryEntryRoot, remote: null, role: "project-root", kind: "git" }, 42,
    ]),
  });
  writeFileSync(join(invalidRepositoryEntryRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", invalidRepositoryEntryId), "utf8");
  run("仓库列表拒绝非对象条目", 1, join(invalidRepositoryEntryRoot, "skills"),
    join(invalidRepositoryEntryRoot, "AGENTS.md"), "repositories_json包含无效路径条目", false);

  const duplicateRepositoryId = "project-duplicate-repository";
  writeProjectOverview(controlRoot, duplicateRepositoryId);
  const duplicateRepositoryRoot = join(scratch, "duplicate-repository");
  copySkills(duplicateRepositoryRoot);
  const duplicateRepositoryEntry = {
    path: duplicateRepositoryRoot, remote: null, role: "project-root", kind: "git",
  };
  writeLocalRegistration(controlRoot, duplicateRepositoryId, duplicateRepositoryRoot, {
    repositoriesJson: JSON.stringify([duplicateRepositoryEntry, duplicateRepositoryEntry]),
  });
  writeFileSync(join(duplicateRepositoryRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", duplicateRepositoryId), "utf8");
  run("仓库列表拒绝重复路径", 1, join(duplicateRepositoryRoot, "skills"),
    join(duplicateRepositoryRoot, "AGENTS.md"), "repositories_json包含重复路径", false);

  const nonGitComponentId = "project-non-git-component";
  writeProjectOverview(controlRoot, nonGitComponentId);
  const nonGitComponentRoot = join(scratch, "non-git-component-project");
  const plainComponent = join(nonGitComponentRoot, "plain-component");
  copySkills(nonGitComponentRoot);
  mkdirSync(plainComponent, { recursive: true });
  writeLocalRegistration(controlRoot, nonGitComponentId, nonGitComponentRoot, {
    hostId: "local", codexProjectId: "codex-non-git-component",
    repositoriesJson: JSON.stringify([{ path: plainComponent, remote: null, role: "component", kind: "git" }]),
  });
  writeFileSync(join(nonGitComponentRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", nonGitComponentId), "utf8");
  run("组件执行仓必须是精确Git根", 1, join(nonGitComponentRoot, "skills"),
    join(nonGitComponentRoot, "AGENTS.md"), "登记仓库不是存在的精确Git根", false);

  const remoteDriftId = "project-remote-drift";
  writeProjectOverview(controlRoot, remoteDriftId);
  const remoteDriftRoot = join(scratch, "remote-drift-project");
  const remoteDriftComponent = join(remoteDriftRoot, "component");
  copySkills(remoteDriftRoot);
  mkdirSync(remoteDriftComponent, { recursive: true });
  const initializedRemote = spawnSync("git", ["init"], { cwd: remoteDriftComponent, encoding: "utf8", windowsHide: true });
  const addedRemote = spawnSync("git", ["remote", "add", "origin", "https://example.test/team/live.git"], {
    cwd: remoteDriftComponent, encoding: "utf8", windowsHide: true,
  });
  if (initializedRemote.status !== 0 || addedRemote.status !== 0) throw new Error(initializedRemote.stderr || addedRemote.stderr);
  writeLocalRegistration(controlRoot, remoteDriftId, remoteDriftRoot, {
    hostId: "local", codexProjectId: "codex-remote-drift",
    repositoriesJson: JSON.stringify([{
      path: remoteDriftComponent, remote: "https://example.test/team/registered.git", role: "component", kind: "git",
    }]),
  });
  writeFileSync(join(remoteDriftRoot, "AGENTS.md"), fusedEntry("../beyond-control", remoteDriftId), "utf8");
  run("组件执行仓remote漂移被拒绝", 1, join(remoteDriftRoot, "skills"),
    join(remoteDriftRoot, "AGENTS.md"), "登记仓库remote与现场不一致", false);

  const missingRouteBindingId = "project-missing-route-binding";
  writeProjectOverview(controlRoot, missingRouteBindingId);
  const missingRouteBindingRoot = join(scratch, "missing-route-binding-project");
  const boundComponent = join(missingRouteBindingRoot, "component");
  copySkills(missingRouteBindingRoot);
  mkdirSync(boundComponent, { recursive: true });
  const initializedBound = spawnSync("git", ["init"], { cwd: boundComponent, encoding: "utf8", windowsHide: true });
  if (initializedBound.status !== 0) throw new Error(initializedBound.stderr);
  writeLocalRegistration(controlRoot, missingRouteBindingId, missingRouteBindingRoot, {
    repositoriesJson: JSON.stringify([{ path: boundComponent, remote: null, role: "component", kind: "git" }]),
  });
  writeFileSync(join(missingRouteBindingRoot, "AGENTS.md"), fusedEntry("../beyond-control", missingRouteBindingId), "utf8");
  run("多仓登记缺少平台路由字段被拒绝", 1, join(missingRouteBindingRoot, "skills"),
    join(missingRouteBindingRoot, "AGENTS.md"), "缺少host_id或codex_project_id", false);

  const duplicateRegistrationId = "project-duplicate-registration";
  writeProjectOverview(controlRoot, duplicateRegistrationId);
  const duplicateRegistrationRoot = join(scratch, "duplicate-registration");
  copySkills(duplicateRegistrationRoot);
  writeLocalRegistration(controlRoot, duplicateRegistrationId, duplicateRegistrationRoot, { repositoriesJson: "[]" });
  writeFileSync(join(controlRoot, "local", "projects", "duplicate-registration-copy.md"), [
    "---", `id: ${duplicateRegistrationId}`, `path: ${duplicateRegistrationRoot}`, "repositories_json: []", "---", "",
  ].join("\n"), "utf8");
  writeFileSync(join(duplicateRegistrationRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", duplicateRegistrationId), "utf8");
  run("本机登记拒绝重复编号和路径", 1, join(duplicateRegistrationRoot, "skills"),
    join(duplicateRegistrationRoot, "AGENTS.md"), "本机项目编号必须且只能登记一次", false);

  const missingRegistrationId = "project-missing-registration";
  writeProjectOverview(controlRoot, missingRegistrationId);
  const missingRegistrationRoot = join(scratch, "missing-registration");
  copySkills(missingRegistrationRoot);
  writeFileSync(
    join(missingRegistrationRoot, "AGENTS.md"),
    fusedEntry("../beyond-control", missingRegistrationId),
    "utf8",
  );
  run("本机登记缺失", 1, join(missingRegistrationRoot, "skills"),
    join(missingRegistrationRoot, "AGENTS.md"), "项目映射的本机项目登记不存在", false);

  const missingInitializationId = "project-missing-init";
  const missingInitializationOverview = join(controlRoot, "projects", missingInitializationId, "项目总览.md");
  mkdirSync(dirname(missingInitializationOverview), { recursive: true });
  writeFileSync(missingInitializationOverview, `# 旧项目总览\n\n## Worker运行策略\n\n<!-- BEGIN BEYOND WORKER POLICY -->\n\`\`\`json\n{"schemaVersion":1,"mode":"platform-default","scope":"new-formal-worker","confirmed":false,"approvedBy":null,"approvedAt":null}\n\`\`\`\n<!-- END BEYOND WORKER POLICY -->\n`, "utf8");
  const missingInitializationRoot = join(scratch, "missing-initialization");
  copySkills(missingInitializationRoot);
  writeLocalRegistration(controlRoot, missingInitializationId, missingInitializationRoot);
  writeFileSync(join(missingInitializationRoot, "AGENTS.md"), fusedEntry("../beyond-control", missingInitializationId), "utf8");
  run("旧项目缺少初始化状态", 1, join(missingInitializationRoot, "skills"), join(missingInitializationRoot, "AGENTS.md"), "缺少唯一项目初始化受管块", false);

  const thirdPartyRoot = join(scratch, "third-party-hook");
  copySkills(thirdPartyRoot);
  writeLocalRegistration(controlRoot, "project-third-party", thirdPartyRoot);
  writeFileSync(join(thirdPartyRoot, "AGENTS.md"), fusedEntry("../beyond-control", "project-third-party"), "utf8");
  mkdirSync(join(thirdPartyRoot, ".codex"), { recursive: true });
  writeFileSync(join(thirdPartyRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node .codex/native-hook.mjs" }] }] } }, null, 2)}\n`, "utf8");
  run("第三方Hook不属于BEYOND失败", 0, join(thirdPartyRoot, "skills"), join(thirdPartyRoot, "AGENTS.md"), "安装验真通过", false);

  const wrongControlRoot = join(scratch, "wrong-control");
  copySkills(wrongControlRoot);
  writeFileSync(join(wrongControlRoot, "AGENTS.md"), fusedEntry("../missing-control", "project-demo"), "utf8");
  run("错误控制仓映射", 1, join(wrongControlRoot, "skills"), join(wrongControlRoot, "AGENTS.md"), "项目映射的控制仓版本清单不存在", false);

  const missingRuntimeControl = join(scratch, "missing-runtime-control");
  cpSync(packageRoot, missingRuntimeControl, { recursive: true });
  writeProjectOverview(missingRuntimeControl, "project-missing-runtime");
  rmSync(join(missingRuntimeControl, "scripts", "runtime", "control-runtime.mjs"));
  const missingRuntimeRoot = join(scratch, "missing-runtime-project");
  copySkills(missingRuntimeRoot);
  writeLocalRegistration(missingRuntimeControl, "project-missing-runtime", missingRuntimeRoot);
  writeFileSync(
    join(missingRuntimeRoot, "AGENTS.md"),
    fusedEntry("../missing-runtime-control", "project-missing-runtime"),
    "utf8",
  );
  run(
    "控制运行模块缺失",
    1,
    join(missingRuntimeRoot, "skills"),
    join(missingRuntimeRoot, "AGENTS.md"),
    "项目映射的控制运行文件scripts/runtime/control-runtime.mjs不存在",
    false,
  );

  const mixedRoot = join(scratch, "mixed");
  for (const file of [
    "scripts/cli/cli-task-store.mjs", "scripts/cli/native-cli-runner.mjs",
    "scripts/cli/cli-bridge.mjs", "scripts/cli/desktop-host.mjs", "scripts/cli/cli-notify.mjs",
    "scripts/cli/process-identity.mjs",
    "docs/AI编程协同机制/机制/04-CLI目标协作机制.md",
  ]) {
    const missingCliControl = join(scratch, "missing-cli-control");
    cpSync(packageRoot, missingCliControl, { recursive: true });
    writeProjectOverview(missingCliControl, "project-missing-cli");
    rmSync(join(missingCliControl, file));
    const missingCliRoot = join(scratch, "missing-cli-project");
    mkdirSync(missingCliRoot, { recursive: true }); copySkills(missingCliRoot);
    writeLocalRegistration(missingCliControl, "project-missing-cli", missingCliRoot);
    writeFileSync(join(missingCliRoot, "AGENTS.md"), fusedEntry("../missing-cli-control", "project-missing-cli"), "utf8");
    run(`可选CLI产品文件缺失${file}`, 1, join(missingCliRoot, "skills"), join(missingCliRoot, "AGENTS.md"), `项目映射的CLI产品文件${file}不存在`, false);
    rmSync(missingCliControl, { recursive: true, force: true });
    rmSync(missingCliRoot, { recursive: true, force: true });
  }
  copySkills(mixedRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(mixedRoot, "AGENTS.md"));
  writeFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), `${readFileSync(join(mixedRoot, "skills", "identity-pm", "SKILL.md"), "utf8")}\n<!-- stale -->\n`, "utf8");
  run("旧Skill混入", 1, join(mixedRoot, "skills"), join(mixedRoot, "AGENTS.md"), "安装Skill内容不一致");

  const oldEntryRoot = join(scratch, "old-entry");
  copySkills(oldEntryRoot);
  writeFileSync(join(oldEntryRoot, "AGENTS.md"), cpEntry().replace(/<!-- BEYOND-RUNTIME-VERSION: [^>]+ -->\r?\n/, ""), "utf8");
  run("旧项目入口混入", 1, join(oldEntryRoot, "skills"), join(oldEntryRoot, "AGENTS.md"), "缺少目标版本标记");

  const staleGuardRoot = join(scratch, "stale-guard");
  copySkills(staleGuardRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(staleGuardRoot, "AGENTS.md"));
  mkdirSync(join(staleGuardRoot, ".codex"), { recursive: true });
  writeFileSync(join(staleGuardRoot, ".codex", "beyond-runtime-guard.mjs"), "// BEYOND_RUNTIME_IDENTITY\n", "utf8");
  run("旧身份护栏脚本残留", 1, join(staleGuardRoot, "skills"), join(staleGuardRoot, "AGENTS.md"), "项目仍残留BEYOND身份护栏脚本");

  const staleHookRoot = join(scratch, "stale-hook");
  copySkills(staleHookRoot);
  cpSync(join(packageRoot, "AGENTS.md"), join(staleHookRoot, "AGENTS.md"));
  mkdirSync(join(staleHookRoot, ".codex"), { recursive: true });
  writeFileSync(join(staleHookRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node .codex/beyond-runtime-guard.mjs" }] }] } }, null, 2)}\n`, "utf8");
  run("旧身份Hook残留", 1, join(staleHookRoot, "skills"), join(staleHookRoot, "AGENTS.md"), "仍引用BEYOND身份护栏");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`安装完整性回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`安装完整性回归通过：${passed}项`);
