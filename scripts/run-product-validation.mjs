// Reproduce checks from an isolated snapshot; retain compact evidence, not test trees.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTemporaryWorkspace } from './lib/temporary-workspace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function publicFiles(sourceRoot) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  return [...new Set(names)].sort().map(name => {
    const target = path.resolve(sourceRoot, name), relative = path.relative(sourceRoot, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('unsafe candidate path');
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Snapshot requires a regular source file: ' + name);
    const bytes = fs.readFileSync(target);
    return { path: name, mode: stat.mode & 0o777, sha256: sha(bytes), contentBase64: bytes.toString('base64') };
  });
}
const fingerprint = files => sha(json(files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 }))));

function atomicWrite(target, bytes, immutable = false) {
  const temporary = target + '.' + randomUUID() + '.tmp';
  const lock = target + '.lock';
  let locked = false;
  try {
    // Windows cannot replace a file while another publisher is replacing it.
    // Serialize only publication, not the tests; never steal a possibly live lock.
    if (!immutable) {
      const deadline = Date.now() + 3000;
      while (!locked) {
        try { fs.mkdirSync(lock); locked = true; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (Date.now() >= deadline) throw new Error('Evidence publication is busy: ' + lock);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    if (immutable) {
      // Publish an already closed file without replacing an immutable recovery snapshot.
      // The staging link is removed below, leaving one normal file (no source-file hardlinks).
      try { fs.linkSync(temporary, target); }
      catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code) || !fs.existsSync(target)
          || !fs.readFileSync(target).equals(bytes)) throw error;
      }
    } else fs.renameSync(temporary, target);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    finally { if (locked) fs.rmdirSync(lock); }
  }
}

export function productCommands(sourceRoot) {
  const runtime = ['check-m3-project-identity', 'check-project-runtime-routing', 'check-worker-result-receipts', 'check-receipt-write-concurrency', 'check-receipt-list-concurrency', 'check-accept-receipt-cache-expiry', 'check-m3-workbench-transaction', 'check-workbench-upgrade-migration', 'check-shared-recovery-workbench', 'check-native-worker-return',
    'check-cli-task-store', 'check-cli-contract', 'check-cli-context', 'check-codex-executable', 'check-cli-manager', 'check-cli-host-lifetime', 'check-cli-next-store', 'check-cli-next-bridge', 'check-cli-launcher', 'check-cli-notification', 'check-cli-reconnect', 'check-cli-workbench', 'check-cli-routing', 'check-cli-recovery', 'check-cli-goal-loop', 'check-cli-interactive', 'check-cli-zcode', 'check-zcode-capabilities', 'check-cli-claude', 'check-cli-transfer'].map(n => 'scripts/' + n + '.mjs');
  return [
    { name: 'artifact-lifecycle', args: ['--test', '--test-concurrency=1', 'scripts/check-temporary-workspace.mjs', 'scripts/check-validation-cleanup.mjs'] },
    { name: 'backup-deduplication', args: ['scripts/check-backup-dedup-regressions.mjs'] },
    ...['check-initialization-markdown-regressions', 'check-project-registration-regressions', 'check-project-preimage-regressions'].map(n => ({ name: n, args: ['scripts/' + n + '.mjs', '--product-root', '模板交付包'] })),
    { name: 'engineering-documentation', args: ['scripts/check-engineering-documentation.mjs'] },
    { name: 'design-confirmation-static', args: ['scripts/check-design-confirmation.mjs'] },
    { name: 'task-engineering-separation', args: ['scripts/check-task-engineering-separation.mjs'] },
    { name: 'retained-cli-regressions', args: ['--test', ...fs.readdirSync(path.join(sourceRoot, '模板交付包/scripts/cli')).filter(n => n.endsWith('.test.mjs')).map(n => '模板交付包/scripts/cli/' + n)] },
    { name: 'team-control-results', args: ['scripts/check-team-control-results.mjs'] },
    { name: 'runtime-and-cli', args: ['--test', '--test-concurrency=4', ...runtime] },
    { name: 'progress-decision-fixtures', args: ['scripts/probe-pm-progress-decisions.mjs', '--check-fixtures'] },
    { name: 'shared-recovery-decision-fixtures', args: ['scripts/probe-pm-progress-decisions.mjs', '--fixture', 'scripts/fixtures/shared-recovery-decisions.json', '--check-fixtures'] },
    ...['check-public-content', 'check-implementation-paths', 'check-worker-policy-results', 'check-worker-policy-approval', 'check-local-worker-final', 'check-existing-project-adoption', 'check-install-integrity', 'check-project-entry-migration', 'check-project-initialization-runtime', 'check-historical-workbench-routing', 'check-workbench-convergence', 'check-shared-workspace-git'].map(n => ({ name: n, args: ['scripts/' + n + '.mjs', ...(n === 'check-public-content' ? ['--strict-candidate'] : [])] })),
    { name: 'minimal-tests', args: ['--test', 'test/calc.test.js'], cwd: 'examples/minimal-project' },
    { name: 'minimal-syntax', args: ['--check', 'src/calc.js'], cwd: 'examples/minimal-project' },
    { name: 'product-content', args: ['模板交付包/scripts/verify-install-integrity.mjs', '--installed-skills-root', '模板交付包/skills', '--project-agents', '模板交付包/AGENTS.md', '--content-only'] },
  ];
}

// Exported so failure/retention cases can exercise this exact runner in a tiny Git fixture.
export function runProductValidation({ sourceRoot = root, commands = productCommands(sourceRoot), timeout = 180000 } = {}) {
  sourceRoot = path.resolve(sourceRoot);
  const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
  const sourceHead = git('rev-parse', 'HEAD'), sourceStatus = git('status', '--porcelain');
  const workspace = createTemporaryWorkspace('beyond-full-validation-');
  const scratch = workspace.root, candidate = path.join(scratch, 'candidate'), childTemp = path.join(scratch, 'child-temp');
  let evidenceSafe = true;
  try {
    fs.mkdirSync(candidate); fs.mkdirSync(childTemp);
    const capturedFiles = publicFiles(sourceRoot), sourceSnapshotSha256 = fingerprint(capturedFiles);
    for (const file of capturedFiles) {
      const target = path.join(candidate, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'), { mode: file.mode });
    }
    if (git('rev-parse', 'HEAD') !== sourceHead || git('status', '--porcelain') !== sourceStatus || fingerprint(publicFiles(sourceRoot)) !== sourceSnapshotSha256) throw Error('source changed during snapshot capture; rerun against a stable tree');
    execFileSync('git', ['init', '--quiet'], { cwd: candidate, windowsHide: true });
    const evidenceRoot = path.join(sourceRoot, 'outputs', 'product-validation', sourceSnapshotSha256);
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const snapshotFile = path.join(evidenceRoot, 'source-snapshot.json.gz');
    const snapshot = json({ schemaVersion: 1, sourceSnapshotSha256, files: capturedFiles });
    if (fs.existsSync(snapshotFile)) {
      if (!gunzipSync(fs.readFileSync(snapshotFile)).equals(snapshot)) throw Error('Retained source snapshot differs; refusing to overwrite unique recovery material');
    } else {
      atomicWrite(snapshotFile, gzipSync(snapshot), true);
    }
    const results = [], logs = {};
    for (const c of commands) {
      const started = Date.now();
      // Descendant fixtures inherit one owned temp root, even if their own failure path leaks.
      const env = { ...process.env, TMP: childTemp, TEMP: childTemp, TMPDIR: childTemp }; delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, c.args, { cwd: path.resolve(candidate, c.cwd ?? '.'), env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
      logs[c.name] = String(r.stdout ?? '') + String(r.stderr ?? '');
      results.push({ name: c.name, exitCode: r.status, error: r.error?.message ?? null, signal: r.signal, durationMs: Date.now() - started });
      console.log(c.name + ': ' + (r.status === 0 && !r.error ? 'PASS' : 'FAIL'));
    }
    const sourceChangedDuringValidation = git('rev-parse', 'HEAD') !== sourceHead || git('status', '--porcelain') !== sourceStatus || fingerprint(publicFiles(sourceRoot)) !== sourceSnapshotSha256;
    const report = { schemaVersion: 2, version: JSON.parse(fs.readFileSync(path.join(candidate, '模板交付包/beyond-release.json'))).releaseVersion,
      sourceHead, sourceSnapshotSha256, testedUncommittedSnapshot: sourceStatus !== '', sourceChangedDuringValidation,
      platform: process.platform, node: process.version, evidenceRoot, snapshotFile, results,
      checksPassed: !sourceChangedDuringValidation && results.every(r => r.exitCode === 0 && !r.error),
      passed: false, scratchRemoved: false, cleanupStatus: 'pending' };
    // Each bundle is self-contained: concurrent runs cannot pair one report with another run's logs.
    report.evidenceFile = path.join(evidenceRoot, 'latest.json.gz');
    evidenceSafe = false;
    try {
      atomicWrite(report.evidenceFile, gzipSync(json({ report, logs })));
    } catch (error) {
      // Do not discard the only diagnostic copy when its permanent destination is full/denied.
      try { fs.writeFileSync(path.join(scratch, 'validation-evidence.json.gz'), gzipSync(json({ report, logs }))); }
      catch { /* The original error and retained workspace are reported below. */ }
      throw new Error('Could not retain validation evidence; workspace kept at ' + scratch, { cause: error });
    }
    evidenceSafe = true;
    try {
      workspace.cleanup();
      report.scratchRemoved = !fs.existsSync(scratch);
      report.cleanupStatus = 'removed';
      report.passed = report.checksPassed;
    } catch (error) {
      report.cleanupStatus = 'failed';
      report.cleanupError = error.message;
      report.remainingScratch = scratch;
    }
    // Retain the last pass and last failure for this exact input, not every repeated run.
    atomicWrite(path.join(evidenceRoot, report.passed ? 'last-success.json.gz' : 'last-failure.json.gz'), gzipSync(json({ report, logs })));
    atomicWrite(report.evidenceFile, gzipSync(json({ report, logs })));
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (evidenceSafe) workspace.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runProductValidation();
  if (!report.passed) process.exitCode = 1;
}
