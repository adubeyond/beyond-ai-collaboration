import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCliContext } from '../模板交付包/scripts/cli/cli-context.mjs';

// These tests prove the bytes prepared for the CLI, not model comprehension.
// Real native-model reading is verified separately by the isolated CLI probe.
const productRoot = fileURLToPath(new URL('../模板交付包/', import.meta.url));
const actualSkill = path.join(productRoot, 'skills/task-dev/SKILL.md');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = file => fs.realpathSync(file);
const entryFor = (context, file) => context.manifest.entries.find(entry => entry.path === canonical(file));
const sourceRecords = context => context.text.split('\n').flatMap(line => {
  try { const value = JSON.parse(line); return typeof value.content === 'string' && value.path ? [value] : []; }
  catch { return []; }
});
const sourceFor = (context, file) => sourceRecords(context).find(item => item.path === canonical(file));

function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-cli-context-'));
  const projectRoot = path.join(temporaryRoot, 'project');
  const executionRoot = path.join(projectRoot, 'packages/module');
  fs.mkdirSync(executionRoot, { recursive: true });
  const write = (relative, body) => {
    const file = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const agents = write('AGENTS.md', '# Project entry\nCurrent project rule: keep the approved business scope.\n');
  const requirements = write('docs/需求.md', '# Current requirements\nRequired source: approved-catalog-v2.\n');
  const design = write('docs/设计.md', '# Current design\nUse the existing CatalogService; do not create a second source.\n');
  const contract = {
    goal: 'Deliver the approved catalog lookup with evidence',
    boundaries: 'Only the isolated fixture; preserve the entire business goal',
    acceptance: 'Required catalog source and existing service agree',
    factEntries: ['docs/需求.md', 'docs/设计.md'], skillEntries: [],
  };
  const binding = {
    projectId: 'context-project', taskId: 'context-task', ownerThreadId: 'context-owner',
    executionRoot, projectRoute: { canonicalProjectRoot: projectRoot }, contract,
  };
  const run = {
    sessionId: 'unchanged-native-session', runNumber: 2, effectiveContract: structuredClone(contract),
    stage: { goal: 'Read the approved sources', acceptance: 'Identify the current source and service' },
  };
  const build = () => buildCliContext({ binding, run, controlRoot: productRoot });
  t.after(() => {
    const actual = canonical(temporaryRoot), parent = canonical(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('beyond-cli-context-'));
    fs.rmSync(actual, { recursive: true });
  });
  return { temporaryRoot, projectRoot, executionRoot, agents, requirements, design, binding, run, write, build };
}

function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true })
    .filter(relative => fs.statSync(path.join(directory, relative)).isFile())
    .sort().map(relative => [relative, sha(fs.readFileSync(path.join(directory, relative)))]));
}

test('current managed ownership is explicit without promoting a document or native peer to owner', t => {
  const f = fixture(t);
  f.write('docs/设计.md', 'Historical note: report to BEYOND-newwst-backend-foundation [2378eb].');
  const context = f.build();
  assert.deepEqual(context.manifest.ownership, {
    projectId: f.binding.projectId, taskId: f.binding.taskId,
    ownerThreadId: f.binding.ownerThreadId, returnChannel: 'normal-final-via-managed-bridge',
  });
  assert.equal(context.text.split('\n')[0], `Current managed assignment: ${JSON.stringify(context.manifest.ownership)}`);
  assert.match(context.text, /normal final answer/);
  assert.match(context.text, /not a native peer address/);
  assert.match(context.text, /Same-session internal subagents remain available/);
  assert.ok(sourceFor(context, f.design).content.includes('[2378eb]'), 'preserve source bytes, do not rewrite history');
  assert.equal(context.manifest.ownership.ownerThreadId, 'context-owner');
});

test('owner transfer refreshes the next-round context while retaining native session and contract', t => {
  const f = fixture(t), before = f.build(), savedRun = structuredClone(f.run);
  const currentBinding = { ...f.binding, ownerThreadId: 'verified-new-desktop-owner' };
  const after = buildCliContext({ binding: currentBinding, run: f.run, controlRoot: productRoot });
  assert.equal(before.manifest.ownership.ownerThreadId, 'context-owner');
  assert.equal(after.manifest.ownership.ownerThreadId, 'verified-new-desktop-owner');
  assert.ok(!after.text.includes('context-owner'));
  assert.deepEqual(after.manifest.entries, before.manifest.entries);
  assert.deepEqual(f.run, savedRun);
  assert.equal(f.run.sessionId, 'unchanged-native-session');
});

test('nested execution cwd resolves current requirements and design from the bound project root', t => {
  const f = fixture(t);
  f.write('packages/module/docs/需求.md', 'WRONG-CWD-REQUIREMENT: obsolete source');
  f.write('packages/module/docs/设计.md', 'WRONG-CWD-DESIGN: create an unrelated replacement');
  const localAgents = f.write('packages/module/AGENTS.md', 'Module instruction: preserve the module interface.\n');
  const context = f.build();
  assert.equal(context.manifest.schemaVersion, 1);
  assert.equal(context.manifest.projectRoot, canonical(f.projectRoot));
  assert.equal(context.manifest.executionRoot, canonical(f.executionRoot));
  for (const file of [f.agents, localAgents, f.requirements, f.design]) {
    const bytes = fs.readFileSync(file), entry = entryFor(context, file);
    assert.ok(entry, `source must be loaded: ${file}`);
    assert.equal(entry.sha256, sha(bytes));
    assert.equal(entry.bytes, bytes.length);
    const source = sourceFor(context, file);
    assert.ok(source, 'source location must accompany its body');
    assert.equal(source.content, bytes.toString('utf8'));
    assert.equal(source.baseDirectory, path.dirname(file));
  }
  assert.doesNotMatch(context.text, /WRONG-CWD-REQUIREMENT|WRONG-CWD-DESIGN/);
  assert.deepEqual(context.manifest.unavailable, []);
});

test('same-session continuation reads changed source bytes rather than caching the first run', t => {
  const f = fixture(t), before = f.build();
  const bindingBefore = structuredClone(f.binding), runBefore = structuredClone(f.run);
  const oldRequirementHash = entryFor(before, f.requirements).sha256;
  const oldDesignHash = entryFor(before, f.design).sha256;
  f.write('docs/需求.md', '# Current requirements\nRequired source: approved-catalog-v3.\n');
  f.write('docs/设计.md', '# Current design\nUse CatalogServiceV3 under the same approved interface.\n');
  const after = f.build();
  assert.match(after.text, /approved-catalog-v3/);
  assert.match(after.text, /CatalogServiceV3/);
  assert.doesNotMatch(after.text, /approved-catalog-v2/);
  assert.notEqual(entryFor(after, f.requirements).sha256, oldRequirementHash);
  assert.notEqual(entryFor(after, f.design).sha256, oldDesignHash);
  assert.equal(f.run.sessionId, 'unchanged-native-session');
  assert.deepEqual(f.binding, bindingBefore);
  assert.deepEqual(f.run, runBefore);
});

test('effective contract selects current sources without changing the original contract or stage', t => {
  const f = fixture(t);
  const current = f.write('docs/当前设计.md', 'CURRENT-CONTRACT-DESIGN: approved revision 4.\n');
  f.run.effectiveContract.factEntries = ['docs/当前设计.md'];
  const before = { binding: structuredClone(f.binding), run: structuredClone(f.run) };
  const context = f.build();
  assert.ok(entryFor(context, current));
  assert.equal(entryFor(context, f.requirements), undefined);
  assert.equal(entryFor(context, f.design), undefined);
  assert.match(context.text, /CURRENT-CONTRACT-DESIGN/);
  assert.deepEqual(f.binding, before.binding);
  assert.deepEqual(f.run, before.run);
});

test('missing named design is explicit and does not silently substitute a cwd or historical namesake', t => {
  const f = fixture(t);
  fs.unlinkSync(f.design);
  f.write('packages/module/docs/设计.md', 'WRONG-CWD-FALLBACK');
  f.write('history/docs/设计.md', 'WRONG-HISTORY-FALLBACK');
  const context = f.build();
  assert.ok(entryFor(context, f.requirements), 'an unavailable design must not hide valid requirements');
  const missing = context.manifest.unavailable.find(entry => entry.path === path.join(f.projectRoot, 'docs/设计.md'));
  assert.ok(missing, 'the unavailable canonical source must be recorded');
  assert.equal(typeof missing.reason, 'string');
  assert.ok(missing.reason.length > 0);
  assert.ok(context.text.includes(JSON.stringify(missing.path)), 'the model must see the unavailable source, not only the manifest');
  assert.doesNotMatch(context.text, /WRONG-CWD-FALLBACK|WRONG-HISTORY-FALLBACK/);
});

test('explicit real Action Skill includes its unchanged body and original reference base', t => {
  const f = fixture(t);
  f.run.effectiveContract.skillEntries = [actualSkill];
  const skillBytes = fs.readFileSync(actualSkill), context = f.build();
  const entry = entryFor(context, actualSkill);
  assert.ok(entry);
  assert.equal(entry.sha256, sha(skillBytes));
  const source = sourceFor(context, actualSkill);
  assert.equal(source.content, skillBytes.toString('utf8'));
  assert.equal(source.baseDirectory, path.dirname(actualSkill));
  const reference = /\]\((references\/[^)]+)\)/.exec(skillBytes.toString('utf8'))?.[1];
  assert.ok(reference, 'the existing Skill must expose a real relative reference');
  const referenceFile = path.resolve(path.dirname(entry.path), reference);
  assert.ok(fs.statSync(referenceFile).isFile(), 'the supplied source location must resolve the existing reference');
  assert.equal(entryFor(context, referenceFile), undefined, 'references remain on-demand, not recursively preloaded');
});

test('empty skill selection advertises only existing Action Skills without loading every Skill', t => {
  const f = fixture(t), context = f.build();
  assert.deepEqual(context.manifest.availableSkills.map(item => item.name).sort(), ['task-design', 'task-dev', 'task-ops', 'task-test']);
  for (const item of context.manifest.availableSkills) {
    assert.ok(fs.statSync(item.path).isFile());
    assert.ok(context.text.includes(JSON.stringify(item.path)));
    assert.equal(entryFor(context, item.path), undefined);
  }
  assert.ok(!context.manifest.availableSkills.some(item => /^identity-/.test(item.name)));
  assert.ok(!context.text.includes(fs.readFileSync(actualSkill, 'utf8')));
});

test('duplicate absolute and relative paths inject each physical source only once', t => {
  const f = fixture(t);
  f.run.effectiveContract.factEntries = ['docs/需求.md', f.requirements, 'docs/../docs/需求.md', f.agents];
  const context = f.build();
  for (const file of [f.requirements, f.agents]) {
    assert.equal(context.manifest.entries.filter(entry => entry.path === canonical(file)).length, 1);
    const marker = fs.readFileSync(file, 'utf8');
    assert.equal(sourceRecords(context).filter(item => item.content === marker).length, 1);
  }
});

test('project instruction override takes precedence while nested instructions remain applicable', t => {
  const f = fixture(t);
  const override = f.write('AGENTS.override.md', 'CURRENT-OVERRIDE-INSTRUCTION\n');
  const nested = f.write('packages/AGENTS.md', 'CURRENT-PACKAGE-INSTRUCTION\n');
  const context = f.build();
  assert.ok(entryFor(context, override));
  assert.ok(entryFor(context, nested));
  assert.equal(entryFor(context, f.agents), undefined);
  assert.match(context.text, /CURRENT-OVERRIDE-INSTRUCTION/);
  assert.match(context.text, /CURRENT-PACKAGE-INSTRUCTION/);
  assert.doesNotMatch(context.text, /Current project rule: keep the approved business scope/);
});

test('linked documents are not recursively copied into context or confused with current evidence', t => {
  const f = fixture(t);
  const archived = f.write('docs/archive/旧设计.md', 'OBSOLETE-PRIVATE-CONTENT-DO-NOT-INJECT\n');
  f.write('docs/需求.md', '# Current requirement\nUse approved-catalog-v2.\n[Historical comparison only](archive/旧设计.md)\n');
  const context = f.build();
  assert.ok(entryFor(context, f.requirements));
  assert.equal(entryFor(context, archived), undefined);
  assert.doesNotMatch(context.text, /OBSOLETE-PRIVATE-CONTENT-DO-NOT-INJECT/);
  assert.equal(sourceFor(context, f.requirements).baseDirectory, path.dirname(f.requirements), 'the source-relative link retains its correct base');
});

test('invalid UTF-8, binary content and directories are reported without hiding valid current sources', t => {
  const f = fixture(t);
  const invalid = f.write('docs/invalid.md', Buffer.from([0xc3, 0x28]));
  const binary = f.write('docs/binary.md', Buffer.from('BINARY\u0000PAYLOAD'));
  f.run.effectiveContract.factEntries.push('docs/invalid.md', 'docs/binary.md', 'docs');
  const context = f.build();
  assert.ok(entryFor(context, f.requirements));
  assert.ok(entryFor(context, f.design));
  for (const file of [invalid, binary, path.join(f.projectRoot, 'docs')]) {
    assert.ok(context.manifest.unavailable.some(entry => entry.path === canonical(file) && entry.reason));
    assert.equal(entryFor(context, file), undefined);
  }
  assert.ok(!context.text.includes('BINARY\u0000PAYLOAD'));
});

test('context preparation is read-only and retains session, stage and every contract field', t => {
  const f = fixture(t), filesBefore = snapshot(f.temporaryRoot);
  const valuesBefore = { binding: structuredClone(f.binding), run: structuredClone(f.run) };
  f.build(); f.build();
  assert.deepEqual(snapshot(f.temporaryRoot), filesBefore);
  assert.deepEqual(f.binding, valuesBefore.binding);
  assert.deepEqual(f.run, valuesBefore.run);
});

test('oversized and aggregate-budget sources are visible as not loaded, never silently truncated', t => {
  const f = fixture(t);
  const oversized = f.write('docs/large.md', 'OVERSIZED-CONTENT\n' + 'L'.repeat(256 * 1024));
  const one = f.write('docs/within-one.md', 'FIRST-BUDGET-SOURCE\n' + 'A'.repeat(150 * 1024));
  const two = f.write('docs/within-two.md', 'SECOND-BUDGET-SOURCE\n' + 'B'.repeat(150 * 1024));
  f.run.effectiveContract.factEntries = ['docs/large.md', 'docs/within-one.md', 'docs/within-two.md', 'docs/需求.md'];
  const context = f.build();
  assert.ok(entryFor(context, one));
  assert.ok(entryFor(context, f.requirements), 'a small valid source remains readable after an unavailable large source');
  for (const file of [oversized, two]) {
    assert.equal(entryFor(context, file), undefined);
    const unavailable = context.manifest.unavailable.find(entry => entry.path === canonical(file));
    assert.ok(unavailable);
    assert.match(unavailable.reason, /budget|limit|size/i);
  }
  assert.ok(context.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= 256 * 1024);
  assert.doesNotMatch(context.text, /OVERSIZED-CONTENT|SECOND-BUDGET-SOURCE/);
  assert.equal(sourceFor(context, one).content, fs.readFileSync(one, 'utf8'));
});

test('ordinary project without AGENTS remains supported without inventing a different project entry', t => {
  const f = fixture(t);
  fs.unlinkSync(f.agents);
  f.binding.executionRoot = f.projectRoot;
  delete f.binding.projectRoute;
  const context = f.build();
  assert.equal(context.manifest.projectRoot, canonical(f.projectRoot));
  assert.equal(context.manifest.executionRoot, canonical(f.projectRoot));
  assert.ok(entryFor(context, f.requirements));
  assert.ok(entryFor(context, f.design));
  assert.deepEqual(context.manifest.unavailable, []);
});

test('an EACCES instruction probe is explicit and never falls back to an older normal entry', t => {
  const f = fixture(t);
  const override = f.write('AGENTS.override.md', 'CURRENT-PREFERRED-RULE\n');
  const normalBefore = fs.readFileSync(f.agents, 'utf8');
  const originalStat = fs.statSync;
  fs.statSync = function (file, ...args) {
    if (String(file) === override) throw Object.assign(new Error('isolated permission denial'), { code: 'EACCES' });
    return originalStat.call(this, file, ...args);
  };
  let context;
  try { context = f.build(); } finally { fs.statSync = originalStat; }
  assert.ok(context.manifest.unavailable.some(item => item.path === override && item.reason === 'EACCES'));
  assert.equal(entryFor(context, override), undefined);
  assert.equal(entryFor(context, f.agents), undefined);
  assert.ok(!sourceRecords(context).some(item => item.content === normalBefore));
  assert.ok(entryFor(context, f.requirements));
  assert.ok(entryFor(context, f.design));
  assert.match(context.text, /EACCES/);
});
