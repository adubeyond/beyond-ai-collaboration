import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productRoot = process.env.BEYOND_TEST_PRODUCT_ROOT
  ? resolve(process.env.BEYOND_TEST_PRODUCT_ROOT) : join(repositoryRoot, "模板交付包");
const scratch = mkdtempSync(join(tmpdir(), "beyond-policy-approval-"));
const project = join(scratch, "project");
const control = join(project, "beyond-control");
let passed = 0;
const errors = [];
const cli = join(control, "scripts", "beyond-control.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8", windowsHide: true });
}
function required(args) {
  const result = run(args);
  if (result.status !== 0) throw new Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
function check(name, result, expected, unchanged) {
  if (result.status === expected && unchanged) passed += 1;
  else errors.push(`${name}: expected=${expected}, actual=${result.status}, unchanged=${unchanged}\n${result.stdout}\n${result.stderr}`);
}

try {
  mkdirSync(project);
  cpSync(productRoot, control, { recursive: true });
  const registration = required(["register-project", "--project-root", project]);
  const projectId = registration.project.projectId;
  required(["install-project-entry", "--project-root", project, "--confirm-fusion", "yes"]);
  const overview = join(control, "projects", projectId, "项目总览.md");
  const modes = ["platform-default", "beyond-worker-matrix-v1", "beyond-worker-sweetspots-v2", "beyond-worker-gpt6-v3", "beyond-worker-gpt61-v4", "beyond-worker-gpt61-v5"];
  const validAt = "2026-09-27T06:00:00.000Z";
  const scenarios = [
    { name: "valid-iso", patch: { approvedAt: validAt }, expected: 0 },
    { name: "valid-legacy-date", patch: { approvedAt: "September 27, 2026 06:00:00 GMT" }, expected: 0 },
    { name: "invalid-date", patch: { approvedAt: "not-an-iso-date" }, expected: 2 },
    { name: "numeric-date", patch: { approvedAt: 12345 }, expected: 2 },
    { name: "array-date", patch: { approvedAt: [validAt] }, expected: 2 },
    { name: "blank-date", patch: { approvedAt: "   " }, expected: 2 },
    { name: "numeric-approver", patch: { approvedBy: 123 }, expected: 2 },
    { name: "blank-approver", patch: { approvedBy: "   " }, expected: 2 },
  ];
  for (const mode of modes) {
    const saved = ["platform-default", "beyond-worker-gpt61-v5"].includes(mode)
      ? required(["worker-policy", "--action", "set", "--project-id", projectId,
        "--mode", mode, "--approved-by", "isolated-test-approval", "--approved-at", validAt])
      : { policy: { schemaVersion: 1, mode,
        scope: mode.endsWith("v1") ? "new-formal-worker" : "formal-worker-stages",
        confirmed: true, approvedBy: "historical-approval", approvedAt: validAt } };
    const clean = readFileSync(overview, "utf8");
    // Preserve malformed-record coverage on retired policies and the new approval.
    for (const scenario of ["beyond-worker-gpt6-v3", "beyond-worker-gpt61-v4", "beyond-worker-gpt61-v5"].includes(mode) ? scenarios : scenarios.slice(0, 2)) {
      const policy = { ...saved.policy, ...scenario.patch };
      writeFileSync(overview, clean.replace(
        /(<!-- BEGIN BEYOND WORKER POLICY -->)[\s\S]*?(<!-- END BEYOND WORKER POLICY -->)/,
        `$1\n\`\`\`json\n${JSON.stringify(policy)}\n\`\`\`\n$2`,
      ));
      const before = readFileSync(overview);
      for (const action of ["show", "resolve", "resolve-stage"]) {
        const result = run(["worker-policy", "--action", action, "--project-id", projectId,
          "--task-kind", "ordinary-engineering"]);
        check(`${mode}/${scenario.name}/${action}`, result, scenario.expected, before.equals(readFileSync(overview)));
      }
      const verification = spawnSync(process.execPath, [join(control, "scripts", "verify-install-integrity.mjs"),
        "--installed-skills-root", join(control, "skills"), "--project-agents", join(project, "AGENTS.md")],
      { cwd: project, encoding: "utf8", windowsHide: true });
      check(`${mode}/${scenario.name}/verify`, verification, scenario.expected ? 1 : 0, before.equals(readFileSync(overview)));
    }
    writeFileSync(overview, clean);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`Worker批准证据校验失败：${errors.length}项\n${errors.join("\n")}`);
  process.exitCode = 1;
} else console.log(`Worker批准证据校验通过：${passed}项；当前候选=${productRoot}`);
