// Real-entry regressions: registration persistence and overview policy guidance only.
// Usage: node scripts/check-project-registration-regressions.mjs --product-root <product>
//        [--baseline-root <reviewed-R3-product>] [--keep-scratch]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
function rootOption(name, required = false) {
  const index = args.indexOf(name);
  if (index < 0 && !required) return null;
  assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `Pass ${name} explicitly.`);
  const root = realpathSync(resolve(args[index + 1]));
  assert.ok(lstatSync(join(root, "scripts", "beyond-control.mjs")).isFile(), `${name} must contain the complete product.`);
  return root;
}
const productRoot = rootOption("--product-root", true);
const baselineRoot = rootOption("--baseline-root");
const scratch = mkdtempSync(join(tmpdir(), "beyond-registration-regression-"));
const scratchIdentity = realpathSync(scratch);
const excludedState = new Set([".git", "local", "projects", "shared"]);
const results = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sandbox(source, label) {
  const project = join(scratch, label);
  const control = join(project, "beyond-control");
  mkdirSync(project);
  cpSync(source, control, {
    recursive: true,
    filter: (file) => !excludedState.has(relative(source, file).split(/[\\/]/)[0]),
  });
  return { project, control, cli: join(control, "scripts", "beyond-control.mjs") };
}

function successful(environment, commandArgs) {
  const result = spawnSync(process.execPath, [environment.cli, ...commandArgs], {
    cwd: environment.project, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${commandArgs[0]} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function check(name, action) {
  try {
    results.push({ name, passed: true, ...await action() });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

function field(text, key) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assert.ok(frontmatter !== undefined, "registration must contain frontmatter");
  const values = frontmatter.split(/\r?\n/).filter((line) => line.startsWith(`${key}:`));
  assert.equal(values.length, 1, `registration must contain exactly one ${key}`);
  return values[0].slice(key.length + 1).trim();
}

function policySection(text) {
  const section = text.match(/^##\s+(?:\d+\.\s*)?Worker运行策略[^\n]*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1];
  assert.ok(section, "overview must have a Worker policy section");
  return section;
}

let fatal = null;
let cleanupError = null;
try {
  const candidate = sandbox(productRoot, "candidate");
  const hostId = "registration-regression-host";
  const codexProjectId = "11111111-2222-4333-8444-555555555555";
  const registered = successful(candidate, ["register-project", "--project-root", candidate.project,
    "--host-id", hostId, "--codex-project-id", codexProjectId]);
  const projectId = registered.project.projectId;
  const registrationFile = join(candidate.control, "local", "projects", `${projectId}.md`);
  const manifestFile = join(candidate.project, ".codex-local", "registration-probe", "clone-manifest.json");
  const manifest = {
    schemaVersion: 1, projectId, canonicalProjectRoot: candidate.project,
    task: "registration-preservation-regression", root: dirname(manifestFile),
    copies: [], repositories: [], formalRepositories: [],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, manifestBytes);
  const declarations = [{ manifestPath: manifestFile, sha256: sha256(manifestBytes), taskId: manifest.task }];
  const declarationJson = JSON.stringify(declarations);
  const initialText = readFileSync(registrationFile, "utf8");
  const seededText = initialText.replace(/\r?\n---\r?\n/, `\nexecution_clone_manifests_json: ${declarationJson}\n---\n`);
  assert.notEqual(seededText, initialText, "fixture must add the manifest declaration to real registration");
  writeFileSync(registrationFile, seededText);

  const { ProjectIdentityProvider } = await import(pathToFileURL(join(candidate.control, "scripts", "runtime", "project-identity-provider.mjs")).href);
  const provider = new ProjectIdentityProvider({ controlRoot: candidate.control });
  function verifyRegistration() {
    const text = readFileSync(registrationFile, "utf8");
    assert.equal(field(text, "execution_clone_manifests_json"), declarationJson, "registered manifest declaration must retain its content");
    assert.equal(field(text, "id"), projectId, "BEYOND project ID must remain stable");
    assert.equal(field(text, "host_id"), hostId, "host ID must remain stable");
    assert.equal(field(text, "codex_project_id"), codexProjectId, "Codex project ID must remain stable");
    const registrations = provider.registrations();
    assert.deepEqual(registrations.local.issues, [], "consumer must accept the local registration");
    const matching = registrations.local.records.filter((record) => record.beyondProjectId === projectId);
    assert.equal(matching.length, 1, "exactly one local registration must remain");
    assert.equal(matching[0].executionCloneManifests?.length, 1, "real provider must still see one execution clone manifest");
    assert.deepEqual(matching[0].executionCloneManifests, declarations, "consumer must retain manifest identity and digest");
    assert.equal(matching[0].hostId, hostId);
    assert.equal(matching[0].codexProjectId, codexProjectId);
    assert.ok(readFileSync(manifestFile).equals(manifestBytes), "manifest file must remain byte-identical");
    return { consumerDeclarations: 1, manifestUnchanged: true, identitiesPreserved: true };
  }

  await check("injected declaration is recognized by the real provider", verifyRegistration);
  await check("repeated register-project preserves execution clone declarations and identities", () => {
    const result = successful(candidate, ["register-project", "--project-root", candidate.project]);
    assert.equal(result.project.projectId, projectId);
    return verifyRegistration();
  });
  // Reset only the isolated fixture so one failure cannot hide the independent install regression.
  writeFileSync(registrationFile, seededText);
  await check("install-project-entry preserves execution clone declarations and identities", () => {
    successful(candidate, ["install-project-entry", "--project-root", candidate.project, "--confirm-fusion", "yes"]);
    return verifyRegistration();
  });

  await check("overview template delegates policy selection to current worker-policy show", () => {
    const section = policySection(readFileSync(join(candidate.control, "docs", "AI编程协同机制", "项目总览.md"), "utf8"));
    assert.match(section, /worker-policy\s+--action\s+show/, "template must point to the authoritative current policy output");
    assert.doesNotMatch(section, /\bv[123]\b/i, "template must not preserve retired v1/v2/v3 policy guidance");
  });

  if (baselineRoot) {
    await check("worker-policy show matrix is unchanged from the reviewed baseline", () => {
      const baseline = sandbox(baselineRoot, "baseline");
      const baselineRegistration = successful(baseline, ["register-project", "--project-root", baseline.project]);
      const candidatePolicy = successful(candidate, ["worker-policy", "--action", "show", "--project-id", projectId]);
      const baselinePolicy = successful(baseline, ["worker-policy", "--action", "show", "--project-id", baselineRegistration.project.projectId]);
      const { projectId: candidateId, ...candidateValues } = candidatePolicy;
      const { projectId: baselineId, ...baselineValues } = baselinePolicy;
      assert.equal(candidateId, projectId);
      assert.equal(baselineId, baselineRegistration.project.projectId);
      // All policy/default/option/scope values must match; only the isolated project IDs differ.
      assert.deepEqual(candidateValues, baselineValues);
      return { baselineRoot, matrixUnchanged: true };
    });
  }
} catch (error) {
  fatal = error.message;
} finally {
  if (!args.includes("--keep-scratch")) {
    try {
      assert.equal(realpathSync(scratch), scratchIdentity);
      assert.equal(dirname(scratchIdentity), realpathSync(tmpdir()));
      assert.ok(basename(scratchIdentity).startsWith("beyond-registration-regression-"));
      rmSync(scratchIdentity, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error.message;
    }
  }
}

const failures = results.filter((result) => !result.passed);
console.log(JSON.stringify({
  verdict: !fatal && failures.length === 0 && !cleanupError ? "passed" : "failed",
  productRoot, baselineRoot, sourceSha256: sha256(readFileSync(join(productRoot, "scripts", "beyond-control.mjs"))),
  cases: results.length, passed: results.length - failures.length, failed: failures.length, fatal,
  baselineCompared: baselineRoot !== null,
  scratchRetained: args.includes("--keep-scratch") || cleanupError ? scratch : null,
  cleanupError, results,
}, null, 2));
if (fatal || failures.length || cleanupError) process.exitCode = 1;
