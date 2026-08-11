import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-team-control-"));
const control = join(scratch, "beyond control");
const project = join(scratch, "demo-project");
const remote = join(scratch, "control-remote.git");
const localFirstProject = join(scratch, "local-first-project");
const secondClone = join(scratch, "second-clone");
const secureRemoteProject = join(scratch, "secure-remote-project");
const legacyBeyondProject = join(scratch, "legacy-beyond-project");
let crossDriveProject = null;
const errors = [];
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function run(command, args, cwd = scratch, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== expectedStatus) {
    errors.push(`${command} ${args.join(" ")}：期望退出码${expectedStatus}，实际${result.status}\n${output}`);
  }
  return { status: result.status, output, stdout: (result.stdout ?? "").trim() };
}

function controlCommand(args, expectedStatus = 0) {
  return run(process.execPath, [join(control, "scripts", "beyond-control.mjs"), ...args], control, expectedStatus);
}

try {
  cpSync(packageRoot, control, { recursive: true });
  cpSync(join(repositoryRoot, "examples", "minimal-project"), project, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# 原项目规则\n\n- 使用 npm test 验证。\n", "utf8");
  run("git", ["init"], project);
  run("git", ["remote", "add", "origin", "https://example.com/team/demo-project.git"], project);

  controlCommand(["init-control"]);
  check("控制仓建立共享目录", existsSync(join(control, "shared", "tasks", "active")));
  check("控制仓建立本机工作台", existsSync(join(control, "local", "当前工作台.md")));
  const controlEntryBeforeSelfRegistration = readFileSync(join(control, "AGENTS.md"), "utf8");
  const rejectedSelfRegistration = controlCommand(["register-project", "--project-root", control], 2);
  check("控制仓拒绝把自身登记为业务项目", rejectedSelfRegistration.output.includes("不能登记或融合为业务项目") && readFileSync(join(control, "AGENTS.md"), "utf8") === controlEntryBeforeSelfRegistration, rejectedSelfRegistration.output);
  const ignored = run("git", ["check-ignore", "local/probe"], control);
  check("local由Git忽略", ignored.status === 0 && ignored.output.includes("local/probe"), ignored.output);

  const inspect = controlCommand(["inspect-project", "--project-root", project]);
  const inspected = JSON.parse(inspect.stdout);
  check("项目使用remote生成稳定编号", /^project-[a-f0-9]{12}$/.test(inspected.projectId), inspected.projectId);
  check("项目识别已有AGENTS", inspected.agentsPath?.endsWith("/AGENTS.md"), inspected.agentsPath);

  cpSync(join(repositoryRoot, "examples", "minimal-project"), localFirstProject, { recursive: true });
  run("git", ["init"], localFirstProject);
  const localFirstResult = JSON.parse(controlCommand(["register-project", "--project-root", localFirstProject]).stdout);
  const localFirst = localFirstResult.project;
  const localFirstRecord = join(control, "local", "projects", `${localFirst.projectId}.md`);
  writeFileSync(localFirstRecord, `${readFileSync(localFirstRecord, "utf8")}\n- 备份哨兵：before-promotion\n`, "utf8");
  run("git", ["remote", "add", "origin", "https://example.com/team/local-first.git"], localFirstProject);
  const promotedResult = JSON.parse(controlCommand(["register-project", "--project-root", localFirstProject]).stdout);
  const promoted = promotedResult.project;
  check("本地项目绑定remote后沿用原编号", localFirst.projectId === promoted.projectId && localFirst.projectId.startsWith("local-"), `${localFirst.projectId} -> ${promoted.projectId}`);
  check("项目登记覆盖前自动备份local", readFileSync(join(promotedResult.localBackup, "projects", `${promoted.projectId}.md`), "utf8").includes("before-promotion"), promotedResult.localBackup);
  const promotedShared = readFileSync(join(control, "shared", "projects", `${promoted.projectId}.md`), "utf8");
  check("原项目记录补入remote而不新建项目", promotedShared.includes("https://example.com/team/local-first.git"));
  cpSync(join(repositoryRoot, "examples", "minimal-project"), secondClone, { recursive: true });
  run("git", ["init"], secondClone);
  run("git", ["remote", "add", "origin", "https://example.com/team/local-first.git"], secondClone);
  const clonedIdentity = JSON.parse(controlCommand(["inspect-project", "--project-root", secondClone]).stdout);
  check("不同本机路径按同一remote复用项目编号", clonedIdentity.projectId === promoted.projectId, `${clonedIdentity.projectId} != ${promoted.projectId}`);

  cpSync(join(repositoryRoot, "examples", "minimal-project"), secureRemoteProject, { recursive: true });
  run("git", ["init"], secureRemoteProject);
  run("git", ["remote", "add", "origin", "https://oauth2:secret-token@example.com/team/secure.git?access_token=hidden"], secureRemoteProject);
  const secureInspect = JSON.parse(controlCommand(["inspect-project", "--project-root", secureRemoteProject]).stdout);
  check("项目识别移除remote中的凭据与查询参数", secureInspect.remote === "https://example.com/team/secure.git", secureInspect.remote);
  controlCommand(["register-project", "--project-root", secureRemoteProject]);
  const secureRecords = `${readFileSync(join(control, "shared", "projects", `${secureInspect.projectId}.md`), "utf8")}\n${readFileSync(join(control, "local", "projects", `${secureInspect.projectId}.md`), "utf8")}`;
  check("本机与共享项目登记不泄露remote凭据", !/secret-token|access_token|hidden/.test(secureRecords));

  controlCommand(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"]);
  const firstEntry = readFileSync(join(project, "AGENTS.md"), "utf8");
  check("项目入口包含完整3.1内核", firstEntry.includes("BEYOND-RUNTIME-VERSION: 3.1.1"));
  check("项目入口登记控制仓", firstEntry.includes("BEYOND-CONTROL-ROOT: ../beyond control"));
  check("带空格控制仓文档链接使用有效Markdown目标", firstEntry.includes("](<../beyond control/docs/AI编程协同机制/00-模板入口.md>)"));
  check("项目入口把控制脚本映射到控制仓", firstEntry.includes("`../beyond control/scripts/beyond-control.mjs"));
  check("原项目规则得到保留", firstEntry.includes("使用 npm test 验证"));
  check("业务项目没有复制BEYOND文档树", !existsSync(join(project, "docs", "AI编程协同机制")));
  const projectId = inspected.projectId;
  const projectOverview = join(control, "projects", projectId, "项目总览.md");
  const projectFacts = join(control, "projects", projectId, "项目事实", "README.md");
  check("最低接入建立可达的项目总览", existsSync(projectOverview) && readFileSync(projectOverview, "utf8").includes(projectId));
  check("最低接入建立可达的事实索引", existsSync(projectFacts) && readFileSync(projectFacts, "utf8").includes("当前任务需要某类事实时才定点调查"));

  mkdirSync(legacyBeyondProject, { recursive: true });
  run("git", ["init"], legacyBeyondProject);
  writeFileSync(join(legacyBeyondProject, "AGENTS.md"), `<!-- BEYOND-RUNTIME-VERSION: 3.0.9 -->\n# 旧版受管入口\n\n<!-- BEGIN BEYOND PROJECT OVERRIDES -->\n- 保留的项目覆盖。\n<!-- END BEYOND PROJECT OVERRIDES -->\n\n## 旧版受管正文\n\n- 不得作为原生规则复制。\n`, "utf8");
  controlCommand(["install-project-entry", "--project-root", legacyBeyondProject, "--confirm-fusion", "yes"]);
  const upgradedLegacy = readFileSync(join(legacyBeyondProject, "AGENTS.md"), "utf8");
  check("3.09升级只保留项目覆盖不叠加旧运行内核", upgradedLegacy.includes("保留的项目覆盖") && !upgradedLegacy.includes("旧版受管正文") && (upgradedLegacy.match(/BEYOND-RUNTIME-VERSION/g) ?? []).length === 1, upgradedLegacy.slice(-500));
  if (isAbsolute(relative(repositoryRoot, control))) {
    crossDriveProject = mkdtempSync(join(repositoryRoot, ".beyond-cross-drive-"));
    writeFileSync(join(crossDriveProject, "README.md"), "# cross-drive project\n", "utf8");
    run("git", ["init"], crossDriveProject);
    run("git", ["config", "user.name", "BEYOND Test"], crossDriveProject);
    run("git", ["config", "user.email", "beyond-test@example.invalid"], crossDriveProject);
    run("git", ["add", "."], crossDriveProject);
    run("git", ["commit", "-m", "fixture: cross-drive project"], crossDriveProject);
    controlCommand(["install-project-entry", "--project-root", crossDriveProject, "--confirm-fusion", "yes"]);
    const crossDriveEntry = readFileSync(join(crossDriveProject, "AGENTS.md"), "utf8");
    const expectedControl = control.replaceAll("\\", "/");
    check("不同盘符控制仓路径保持绝对定位", crossDriveEntry.includes(`BEYOND-CONTROL-ROOT: ${expectedControl}`) && !crossDriveEntry.includes(`BEYOND-CONTROL-ROOT: ./${expectedControl}`));
    const crossDriveVerify = run(process.execPath, [
      join(control, "scripts", "verify-install-integrity.mjs"),
      "--installed-skills-root",
      join(control, "skills"),
      "--project-agents",
      join(crossDriveProject, "AGENTS.md"),
      "--content-only",
    ], control);
    check("不同盘符融合入口通过内容验真", crossDriveVerify.output.includes("内容验真通过"), crossDriveVerify.output);
  } else {
    check("不同盘符控制仓路径保持绝对定位", true, "当前测试环境控制仓与源码仓同盘");
    check("不同盘符融合入口通过安装验真", true, "当前测试环境控制仓与源码仓同盘");
  }

  controlCommand(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"]);
  const secondEntry = readFileSync(join(project, "AGENTS.md"), "utf8");
  check("重复升级入口保持幂等", firstEntry === secondEntry);
  check("项目入口只有一个原生规则区", (secondEntry.match(/BEGIN PROJECT NATIVE RULES/g) ?? []).length === 1);

  const verify = run(process.execPath, [
    join(control, "scripts", "verify-install-integrity.mjs"),
    "--installed-skills-root",
    join(control, "skills"),
    "--project-agents",
    join(project, "AGENTS.md"),
    "--content-only",
  ], control);
  check("融合入口通过内容验真", verify.output.includes("内容验真通过"), verify.output);

  const localMarker = join(control, "local", "backup-probe.md");
  writeFileSync(localMarker, "before\n", "utf8");
  const backup = controlCommand(["backup-local", "--reason", "test"]).stdout;
  writeFileSync(localMarker, "after\n", "utf8");
  controlCommand(["restore-local", "--snapshot", backup, "--confirm-restore", "yes"]);
  check("local可以从本机备份恢复", readFileSync(localMarker, "utf8") === "before\n");

  run("git", ["config", "user.name", "BEYOND Test"], control);
  run("git", ["config", "user.email", "beyond-test@example.invalid"], control);
  run("git", ["add", "."], control);
  run("git", ["commit", "-m", "control baseline"], control);
  run("git", ["init", "--bare", remote], scratch);
  run("git", ["remote", "add", "origin", remote], control);
  run("git", ["push", "-u", "origin", "HEAD"], control);

  const projectRegistrationPath = `shared/projects/${secureInspect.projectId}.md`;
  const projectOverviewRegistrationPath = `projects/${secureInspect.projectId}/项目总览.md`;
  const projectFactsRegistrationPath = `projects/${secureInspect.projectId}/项目事实/README.md`;
  writeFileSync(join(control, projectRegistrationPath), `${readFileSync(join(control, projectRegistrationPath), "utf8")}\n- 共享登记同步探针。\n`, "utf8");
  writeFileSync(join(control, projectOverviewRegistrationPath), `${readFileSync(join(control, projectOverviewRegistrationPath), "utf8")}\n- 项目总览同步探针。\n`, "utf8");
  writeFileSync(join(control, projectFactsRegistrationPath), `${readFileSync(join(control, projectFactsRegistrationPath), "utf8")}\n- 事实索引同步探针。\n`, "utf8");
  const registrationWithoutScope = controlCommand(["sync", "--action", "push", "--paths", projectRegistrationPath, "--message", "invalid project registration"], 1);
  check("共享项目登记没有专用范围时拒绝推送", registrationWithoutScope.output.includes("不允许该路径"), registrationWithoutScope.output);
  const projectFoundationPaths = [projectRegistrationPath, projectOverviewRegistrationPath, projectFactsRegistrationPath];
  controlCommand(["sync", "--action", "push", "--scope", "project-registration", "--paths", projectFoundationPaths.join(","), "--message", "test: sync project foundation"]);
  const registrationLog = run("git", ["--git-dir", remote, "log", "-1", "--pretty=%s"], scratch);
  check("用户授权后可精确同步固定项目地基", registrationLog.output === "test: sync project foundation", registrationLog.output);
  const remoteFoundation = run("git", ["-c", "core.quotepath=false", "--git-dir", remote, "ls-tree", "-r", "--name-only", "HEAD"], scratch);
  check("项目地基通过共享Git到达远端", projectFoundationPaths.every((path) => remoteFoundation.output.includes(path)), remoteFoundation.output);
  const rejectedProjectDocument = `projects/${secureInspect.projectId}/项目事实/工程开发基线.md`;
  writeFileSync(join(control, rejectedProjectDocument), "# 越界探针\n", "utf8");
  const rejectedProjectDocumentResult = controlCommand(["sync", "--action", "push", "--scope", "project-registration", "--paths", rejectedProjectDocument, "--message", "invalid project document"], 1);
  check("项目登记范围拒绝后续项目事实正文", rejectedProjectDocumentResult.output.includes("不允许该路径"), rejectedProjectDocumentResult.output);

  const taskPath = join(control, "shared", "tasks", "active", "TASK-TEST-001.md");
  writeFileSync(taskPath, "---\nid: TASK-TEST-001\nstatus: 进行中\nowner: tester\n---\n\n# 验证团队任务\n", "utf8");
  controlCommand(["sync", "--action", "push", "--paths", "shared/tasks/active/TASK-TEST-001.md", "--message", "test: add team task"]);
  const remoteLog = run("git", ["--git-dir", remote, "log", "-1", "--pretty=%s"], scratch);
  check("团队任务可以精确提交推送", remoteLog.output === "test: add team task", remoteLog.output);

  const collaborationPath = join(control, "shared", "collaborations", "active", "协同-001.md");
  writeFileSync(collaborationPath, "---\nid: COL-001\nstatus: 进行中\nowner: other\n---\n\n# 验证中文协同文件\n", "utf8");
  controlCommand(["sync", "--action", "push", "--paths", "shared/collaborations/active/协同-001.md", "--message", "test: add unicode collaboration"]);
  const unicodeCommit = run("git", ["-c", "core.quotepath=false", "--git-dir", remote, "show", "--format=", "--name-only", "HEAD"], scratch);
  check("中文共享文件保持精确暂存", unicodeCommit.output.includes("协同-001.md") && !unicodeCommit.output.includes("TASK-TEST-001.md"), unicodeCommit.output);

  const collaborationDetailPath = join(control, "shared", "collaborations", "details", "协同-001.md");
  const collaborationResponsePath = join(control, "shared", "collaborations", "responses", "协同-001", "tester.md");
  writeFileSync(collaborationDetailPath, "# 协同详细过程\n", "utf8");
  mkdirSync(dirname(collaborationResponsePath), { recursive: true });
  writeFileSync(collaborationResponsePath, "# tester反馈\n", "utf8");
  controlCommand(["sync", "--action", "push", "--paths", "shared/collaborations/details/协同-001.md,shared/collaborations/responses/协同-001/tester.md", "--message", "test: add collaboration process"]);

  writeFileSync(collaborationPath, "---\nid: COL-001\nstatus: 已完成\nowner: other\n---\n\n# 验证中文协同文件\n", "utf8");
  const collaborationArchiveResult = JSON.parse(controlCommand(["archive", "--type", "collaboration", "--id", "协同-001", "--result", "协同完成"]).stdout);
  check("协同归档默认回收活动主记录", !existsSync(collaborationPath));
  check("协同归档默认回收详情", !existsSync(collaborationDetailPath));
  check("协同归档默认回收参与者回复", !existsSync(collaborationResponsePath));
  check("协同归档返回精确同步清单", collaborationArchiveResult.syncPaths.includes("shared/collaborations/active/协同-001.md")
    && collaborationArchiveResult.syncPaths.includes("shared/collaborations/details/协同-001.md")
    && collaborationArchiveResult.syncPaths.includes("shared/collaborations/responses/协同-001/tester.md")
    && collaborationArchiveResult.syncPaths.some((path) => path.startsWith("shared/collaborations/archive/")), JSON.stringify(collaborationArchiveResult));
  controlCommand(["sync", "--action", "push", "--paths", collaborationArchiveResult.syncPaths.join(","), "--message", "test: archive collaboration"]);
  const remoteAfterCollaborationArchive = run("git", ["-c", "core.quotepath=false", "--git-dir", remote, "ls-tree", "-r", "--name-only", "HEAD"], scratch);
  check("协同过程从远端活动树回收", !remoteAfterCollaborationArchive.output.includes("shared/collaborations/active/协同-001.md")
    && !remoteAfterCollaborationArchive.output.includes("shared/collaborations/details/协同-001.md")
    && !remoteAfterCollaborationArchive.output.includes("shared/collaborations/responses/协同-001/tester.md"), remoteAfterCollaborationArchive.output);

  const rejected = controlCommand(["sync", "--action", "push", "--paths", "README.md", "--message", "invalid"], 1);
  check("PM协同推送拒绝范围外文件", rejected.output.includes("不允许该路径"), rejected.output);
  const rejectedDirectory = controlCommand(["sync", "--action", "push", "--paths", "shared/tasks/active", "--message", "invalid"], 1);
  check("PM协同推送拒绝目录级批量暂存", rejectedDirectory.output.includes("不允许该路径"), rejectedDirectory.output);

  writeFileSync(taskPath, "---\nid: TASK-TEST-001\nstatus: 已完成\nowner: tester\n---\n\n# 验证团队任务\n", "utf8");
  const rejectedArchiveTraversal = controlCommand(["archive", "--type", "task", "--id", "../README", "--result", "invalid"], 2);
  check("归档编号拒绝路径穿越", rejectedArchiveTraversal.output.includes("归档编号无效"), rejectedArchiveTraversal.output);
  const taskArchiveResult = JSON.parse(controlCommand(["archive", "--type", "task", "--id", "TASK-TEST-001", "--result", "验证完成"]).stdout);
  check("完成任务退出活动目录", !existsSync(taskPath));
  const archive = join(control, "shared", "tasks", "archive", new Date().toISOString().slice(0, 7) + ".md");
  check("完成任务进入精简月度归档", existsSync(archive) && readFileSync(archive, "utf8").includes("TASK-TEST-001"));
  controlCommand(["sync", "--action", "push", "--paths", taskArchiveResult.syncPaths.join(","), "--message", "test: archive team task"]);

  const list = controlCommand(["list", "--git-account", "tester"]);
  const listed = JSON.parse(list.stdout);
  check("已归档任务不再出现在活动汇总", listed.count === 0, list.stdout);

  const untrackedId = "COLLAB-UNTRACKED-001";
  const untrackedActive = join(control, "shared", "collaborations", "active", `${untrackedId}.md`);
  const untrackedResponse = join(control, "shared", "collaborations", "responses", untrackedId, "tester.md");
  writeFileSync(untrackedActive, `---\nid: ${untrackedId}\nstatus: 已完成\nowner: other\n---\n\n# 验证未跟踪回复保护\n`, "utf8");
  controlCommand(["sync", "--action", "push", "--paths", `shared/collaborations/active/${untrackedId}.md`, "--message", "test: add atomic archive guard"]);
  mkdirSync(dirname(untrackedResponse), { recursive: true });
  writeFileSync(untrackedResponse, "# 尚未进入Git的回复\n", "utf8");
  const collaborationArchivePath = join(control, "shared", "collaborations", "archive", `${new Date().toISOString().slice(0, 7)}.md`);
  const archiveBeforeRejection = readFileSync(collaborationArchivePath, "utf8");
  const rejectedUntrackedArchive = controlCommand(["archive", "--type", "collaboration", "--id", untrackedId, "--result", "不应归档"], 1);
  check("未跟踪协同回复阻止归档", rejectedUntrackedArchive.output.includes("尚未进入Git"), rejectedUntrackedArchive.output);
  check("归档拒绝时保留活动记录和回复", existsSync(untrackedActive) && existsSync(untrackedResponse));
  check("归档拒绝时不提前写月度摘要", readFileSync(collaborationArchivePath, "utf8") === archiveBeforeRejection && !archiveBeforeRejection.includes(untrackedId));
} finally {
  if (crossDriveProject) rmSync(crossDriveProject, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`团队控制仓回归失败：${errors.length}项；通过${passed}项`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`团队控制仓回归通过：${passed}项`);
