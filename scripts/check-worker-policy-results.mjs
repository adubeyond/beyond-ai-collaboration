import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "beyond-worker-policy-"));
const project = join(scratch, "legacy-project");
const control = join(project, "beyond-control");
const errors = [];
let passed = 0;
function snapshot(root) {
  const out = {};
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { out[`${key}/`] = "directory"; visit(join(directory, entry.name), `${key}/`); }
      else out[key] = createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex");
    }
  }
  visit(root);
  return JSON.stringify(out);
}

function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else errors.push(`${name}${detail ? `：${detail}` : ""}`);
}

function command(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [join(control, "scripts", "beyond-control.mjs"), ...args], {
    cwd: control,
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== expectedStatus) {
    errors.push(`${args.join(" ")}：期望退出码${expectedStatus}，实际${result.status}\n${output}`);
  }
  return { status: result.status, stdout: (result.stdout ?? "").trim(), output };
}

function json(args, expectedStatus = 0) {
  const result = command(args, expectedStatus);
  return { ...result, value: result.stdout ? JSON.parse(result.stdout) : null };
}

try {
  const entryText = readFileSync(join(repositoryRoot, "模板交付包", "AGENTS.md"), "utf8");
  check("根入口不把所有已批准策略限制为仅新建", !entryText.includes("只适用于当前项目新建Worker"));
  check("根入口将策略及批准范围交给唯一项目所有者", entryText.includes("运行策略及其适用范围由项目总览受管小节唯一承载"));
  cpSync(join(repositoryRoot, "examples", "minimal-project"), project, { recursive: true });
  cpSync(join(repositoryRoot, "模板交付包"), control, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), `# 原项目规则

<!-- BEGIN BEYOND PROJECT OVERRIDES -->
- 旧项目曾明确采用 Terra / Luna / Sol 的 Worker 模型矩阵。
<!-- END BEYOND PROJECT OVERRIDES -->
`, "utf8");

  const inspection = json(["inspect-project", "--project-root", project]).value;
  check("旧入口只识别为待裁决候选", inspection.legacyWorkerPolicyCandidate === true);
  check("旧入口不自动恢复为已批准策略", inspection.workerPolicy.configured === false && inspection.workerPolicy.policy.confirmed === false);
  const rootBeforeRejectedInstall = readFileSync(join(project, "AGENTS.md"), "utf8");
  const rejectedLegacyInstall = command(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"], 2);
  check("旧模型策略未经用户选择时拒绝融合", rejectedLegacyInstall.output.includes("不能静默继承") && readFileSync(join(project, "AGENTS.md"), "utf8") === rootBeforeRejectedInstall, rejectedLegacyInstall.output);

  const registration = json(["register-project", "--project-root", project]).value;
  const projectId = registration.project.projectId;
  const overviewPath = join(control, "projects", projectId, "项目总览.md");
  const initialOverview = readFileSync(overviewPath, "utf8");
  check("老项目登记建立唯一受管策略块", (initialOverview.match(/BEGIN BEYOND WORKER POLICY/g) ?? []).length === 1);

  const initial = json(["worker-policy", "--action", "show", "--project-id", projectId]).value;
  check("未批准策略默认关闭", initial.configured === true && initial.policy.mode === "platform-default" && initial.policy.confirmed === false, JSON.stringify(initial));

  for (const taskKind of ["design-analysis", "ordinary-engineering", "bulk-structured", "complex-high-risk"]) {
    const unresolved = json(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", taskKind]).value;
    check(`未批准时${taskKind}不覆盖平台模型`, unresolved.decision === "keep-platform-default" && Object.keys(unresolved.createParameters).length === 0, JSON.stringify(unresolved));
  }

  const approvedAt = "2026-08-12T08:00:00.000Z";
  const enabled = json([
    "worker-policy", "--action", "set", "--project-id", projectId,
    "--mode", "beyond-worker-matrix-v1", "--approved-by", "老板在项目初始化时明确批准",
    "--approved-at", approvedAt,
  ]).value;
  check("启用策略保留明确批准依据", enabled.policy.confirmed === true && enabled.policy.approvedBy === "老板在项目初始化时明确批准" && enabled.policy.approvedAt === approvedAt, JSON.stringify(enabled));
  check("策略变更先建立可恢复备份", existsSync(enabled.backup), enabled.backup);

  const expected = {
    "design-analysis": { model: "gpt-5.6-sol", thinking: "high" },
    "ordinary-engineering": { model: "gpt-5.6-terra", thinking: "high" },
    "bulk-structured": { model: "gpt-5.6-luna", thinking: "high" },
    "complex-high-risk": { model: "gpt-5.6-sol", thinking: "high" },
  };
  const overviewBeforeResolve = readFileSync(overviewPath, "utf8");
  const shown = json(["worker-policy", "--action", "show", "--project-id", projectId]).value;
  check("show展示与解析相同的唯一映射", JSON.stringify(shown.choices["beyond-worker-matrix-v1"]) === JSON.stringify(expected));
  for (const [taskKind, createParameters] of Object.entries(expected)) {
    const resolved = json(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", taskKind]).value;
    check(`已批准时${taskKind}解析固定参数`, resolved.decision === "use-approved-project-worker-matrix" && JSON.stringify(resolved.createParameters) === JSON.stringify(createParameters), JSON.stringify(resolved));
    check(`${taskKind}只产生模型与强度创建参数`, Object.keys(resolved.createParameters).sort().join(",") === "model,thinking");
  }
  check("show与resolve不改写项目策略", readFileSync(overviewPath, "utf8") === overviewBeforeResolve);
  check("策略仍只作用于新建正式Worker", shown.policy.scope === "new-formal-worker");
  const stageArgs = ["worker-policy", "--action", "resolve-stage", "--project-id", projectId];
  const legacyStage = json([...stageArgs, "--task-kind", "design-analysis"]).value;
  check("旧v1批准不扩张为任务内切换", legacyStage.decision === "keep-current-worker-settings" && Object.keys(legacyStage.continuationParameters).length === 0);
  check("旧v1不偷偷使用v2难题映射", command(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", "hard-analysis"], 2).output.includes("当前Worker策略不包含"));

  const migrated = json([
    "install-project-entry", "--project-root", project, "--confirm-fusion", "yes",
    "--worker-policy-mode", "beyond-worker-matrix-v1",
    "--worker-policy-approved-by", "老板明确把旧矩阵迁入项目总览",
    "--worker-policy-approved-at", "2026-08-12T08:30:00.000Z",
  ]).value;
  const migratedRoot = readFileSync(join(project, "AGENTS.md"), "utf8");
  check("确认后旧模型行迁出根入口", migrated.removedLegacyWorkerPolicyOverrides.length === 1 && !/Terra|Luna|Sol|模型矩阵/.test(migratedRoot), JSON.stringify(migrated));
  check("迁移结果返回新策略与备份", migrated.workerPolicy.policy.mode === "beyond-worker-matrix-v1" && existsSync(migrated.workerPolicy.backup), JSON.stringify(migrated));

  json(["register-project", "--project-root", project]);
  const repeatedOverview = readFileSync(overviewPath, "utf8");
  check("重复初始化不重置用户已批准策略", repeatedOverview.includes('"mode":"beyond-worker-matrix-v1"') && repeatedOverview.includes('"confirmed":true'));
  check("重复初始化不产生第二个策略块", (repeatedOverview.match(/BEGIN BEYOND WORKER POLICY/g) ?? []).length === 1);
  check("模型策略不写回项目根入口", !/gpt-5\.6|Terra|Luna|Sol|模型矩阵|worker-policy|Worker运行策略/.test(readFileSync(join(project, "AGENTS.md"), "utf8")));

  const disabled = json([
    "worker-policy", "--action", "set", "--project-id", projectId,
    "--mode", "platform-default", "--approved-by", "老板明确恢复平台默认",
    "--approved-at", "2026-08-12T09:00:00.000Z",
  ]).value;
  const defaultResolution = json(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", "complex-high-risk"]).value;
  check("用户可明确恢复平台默认", disabled.policy.mode === "platform-default" && Object.keys(defaultResolution.createParameters).length === 0);
  for (const taskKind of Object.keys(expected)) {
    const resolved = json(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", taskKind]).value;
    check(`已批准平台默认时${taskKind}仍不覆盖`, resolved.decision === "keep-platform-default" && Object.keys(resolved.createParameters).length === 0);
  }

  const beforeInvalid = readFileSync(overviewPath, "utf8");
  const invalidMode = command([
    "worker-policy", "--action", "set", "--project-id", projectId,
    "--mode", "unknown", "--approved-by", "无效测试",
  ], 2);
  check("未知策略拒绝且不改文件", invalidMode.output.includes("Worker运行策略无效") && readFileSync(overviewPath, "utf8") === beforeInvalid, invalidMode.output);
  const invalidKind = command(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", "unknown"], 2);
  check("未知任务性质拒绝默认猜测", invalidKind.output.includes("Worker任务性质无效"), invalidKind.output);

  const defaultStage = json([...stageArgs, "--task-kind", "bulk-structured"]).value;
  check("平台默认续接不重置原Worker", defaultStage.decision === "keep-current-worker-settings" && Object.keys(defaultStage.continuationParameters).length === 0);
  const v2Args = ["worker-policy", "--action", "set", "--project-id", projectId, "--mode", "beyond-worker-sweetspots-v2"];
  check("v2没有批准依据不生效", command(v2Args, 2).output.includes("明确批准依据") && readFileSync(overviewPath, "utf8") === beforeInvalid);
  const legacyIntro = "本节记录当前项目的新建正式Worker运行策略状态。用户未确认时保持平台默认；任务分类由PM判断，具体模型映射由控制仓固定脚本唯一维护；工作台、任务包和根入口不复制本节。";
  writeFileSync(overviewPath, readFileSync(overviewPath, "utf8").replace(/本节记录当前项目的Worker运行策略及批准范围。[^\n]+/, legacyIntro) + "\n用户自有说明必须保留。\n");
  const v2 = json([...v2Args, "--approved-by", "批准新建及同一Worker阶段切换"]).value;
  check("v2显式登记阶段适用范围", v2.policy.scope === "formal-worker-stages" && v2.policy.confirmed && existsSync(v2.backup));
  check("升级只刷新旧生成说明不删用户正文", !readFileSync(overviewPath,"utf8").includes(legacyIntro) && readFileSync(overviewPath,"utf8").includes("用户自有说明必须保留。"));
  const sweetspots = {
    "design-analysis": { model: "gpt-5.6-sol", thinking: "medium" },
    "ordinary-engineering": { model: "gpt-5.6-terra", thinking: "medium" },
    "bulk-structured": { model: "gpt-5.6-luna", thinking: "high" },
    "hard-analysis": { model: "gpt-6-astra", thinking: "medium" },
    "complex-high-risk": expected["complex-high-risk"],
  };
  const v2BeforeRead = readFileSync(overviewPath, "utf8");
  const v2Show = json(["worker-policy", "--action", "show", "--project-id", projectId]).value;
  check("展示新旧映射和范围", JSON.stringify(v2Show.choices["beyond-worker-matrix-v1"]) === JSON.stringify(expected)
    && JSON.stringify(v2Show.choices["beyond-worker-sweetspots-v2"]) === JSON.stringify(sweetspots)
    && v2Show.choiceScopes["beyond-worker-sweetspots-v2"] === "formal-worker-stages");
  for (const [kind, pair] of Object.entries(sweetspots)) {
    const creation = json(["worker-policy", "--action", "resolve", "--project-id", projectId, "--task-kind", kind]).value;
    const continuation = json([...stageArgs, "--task-kind", kind]).value;
    check(`v2 ${kind}新建与续接完整组合相同`, JSON.stringify(creation.createParameters) === JSON.stringify(pair)
      && JSON.stringify(continuation.continuationParameters) === JSON.stringify(pair));
    check(`v2 ${kind}续接只包含两个模型字段`, Object.keys(continuation.continuationParameters).sort().join(",") === "model,thinking" && !("createParameters" in continuation));
  }
  let currentPair = sweetspots["bulk-structured"];
  for (const kind of ["design-analysis", "ordinary-engineering", "hard-analysis", "bulk-structured"]) {
    const params = json([...stageArgs, "--task-kind", kind]).value.continuationParameters;
    currentPair = { ...currentPair, ...params };
    check(`往返阶段${kind}不残留上个模型强度`, JSON.stringify(currentPair) === JSON.stringify(sweetspots[kind]));
  }
  check("阶段解析不写策略或切换台账", readFileSync(overviewPath, "utf8") === v2BeforeRead);
  command([...stageArgs, "--task-kind", "unknown"], 2);
  json(["register-project", "--project-root", project]);
  check("重复登记保留v2批准及范围", readFileSync(overviewPath, "utf8").includes('"scope":"formal-worker-stages"'));
  // Corrupt only the isolated fixture: a scope cannot be broadened by changing its label.
  const validV2 = readFileSync(overviewPath, "utf8");
  writeFileSync(overviewPath, validV2.replace('"scope":"formal-worker-stages"', '"scope":"new-formal-worker"'));
  check("不接受v2窄授权冒充阶段授权", command([...stageArgs, "--task-kind", "bulk-structured"], 2).output.includes("字段无效"));
  writeFileSync(overviewPath, validV2.replace('"confirmed":true', '"confirmed":false'));
  const unconfirmedStage = json([...stageArgs, "--task-kind", "hard-analysis"]).value;
  check("未批准v2保持原设置", Object.keys(unconfirmedStage.continuationParameters).length === 0);
  writeFileSync(overviewPath, validV2);
  json(["worker-policy", "--action", "set", "--project-id", projectId, "--mode", "beyond-worker-matrix-v1", "--approved-by", "恢复原策略"]);
  check("可退回v1且停止自动切换", Object.keys(json([...stageArgs, "--task-kind", "hard-analysis"]).value.continuationParameters).length === 0);

  const queryRoot = join(scratch, "query-only");
  cpSync(join(repositoryRoot, "模板交付包"), queryRoot, { recursive: true });
  mkdirSync(join(queryRoot, "projects", projectId), { recursive: true });
  writeFileSync(join(queryRoot, "projects", projectId, "项目总览.md"), validV2);
  const queryBefore = snapshot(queryRoot);
  for (const action of ["show", "resolve", "resolve-stage"]) {
    const result = spawnSync(process.execPath, [join(queryRoot, "scripts/beyond-control.mjs"), "worker-policy", "--action", action, "--project-id", projectId, "--task-kind", "bulk-structured"], { cwd: queryRoot, encoding: "utf8", windowsHide: true });
    check(`${action}不初始化Git或工作台且不写文件`, result.status === 0 && snapshot(queryRoot) === queryBefore, result.stderr);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`Worker策略回归失败：${errors.length}项\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Worker策略回归通过：${passed}项`);
