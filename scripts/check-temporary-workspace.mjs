import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTemporaryWorkspace } from './lib/temporary-workspace.mjs';

test('five repeated rounds leave no directories, including failed work', () => {
  const roots = [];
  for (let round = 0; round < 5; round += 1) {
    const workspace = createTemporaryWorkspace('beyond-temp-lifecycle-round-');
    roots.push(workspace.root);
    assert.equal(path.dirname(workspace.root), fs.realpathSync(os.tmpdir()));
    assert.throws(() => {
      try {
        fs.mkdirSync(path.join(workspace.root, 'nested'));
        fs.writeFileSync(path.join(workspace.root, 'nested', 'fixture'), Buffer.alloc(4096));
        throw new Error('simulated test failure');
      } finally { workspace.cleanup(); }
    }, /simulated test failure/);
    workspace.cleanup();
    assert.ok(roots.every(root => !fs.existsSync(root)));
  }
});

test('nested junction cleanup never touches the outside target or sibling', () => {
  const outside = createTemporaryWorkspace('beyond-temp-lifecycle-outside-');
  const workspace = createTemporaryWorkspace('beyond-temp-lifecycle-links-');
  const sentinel = path.join(outside.root, 'unique-recovery');
  try {
    fs.writeFileSync(sentinel, 'retain me');
    fs.symlinkSync(outside.root, path.join(workspace.root, 'outside-link'), 'junction');
    workspace.cleanup();
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain me');
    assert.equal(fs.existsSync(workspace.root), false);
  } finally { workspace.cleanup(); outside.cleanup(); }
});

test('root replacement refuses deletion even at the original path', () => {
  const holding = createTemporaryWorkspace('beyond-temp-lifecycle-holding-');
  const workspace = createTemporaryWorkspace('beyond-temp-lifecycle-replaced-');
  const original = path.join(holding.root, 'original');
  const sentinel = path.join(workspace.root, 'unique-replacement');
  fs.renameSync(workspace.root, original);
  try {
    fs.mkdirSync(workspace.root);
    fs.writeFileSync(sentinel, 'retain replacement');
    assert.throws(workspace.cleanup, /replaced temporary workspace/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retain replacement');
  } finally {
    fs.unlinkSync(sentinel);
    fs.rmdirSync(workspace.root);
    fs.renameSync(original, workspace.root);
    workspace.cleanup(); holding.cleanup();
  }
});

test('root replaced by a junction is refused without following it', () => {
  const outside = createTemporaryWorkspace('beyond-temp-lifecycle-root-link-');
  const workspace = createTemporaryWorkspace('beyond-temp-lifecycle-linked-');
  const original = path.join(outside.root, 'original');
  fs.renameSync(workspace.root, original);
  try {
    fs.symlinkSync(outside.root, workspace.root, 'junction');
    assert.throws(workspace.cleanup, /replaced temporary workspace/);
    assert.equal(fs.existsSync(original), true);
  } finally {
    fs.unlinkSync(workspace.root);
    fs.renameSync(original, workspace.root);
    workspace.cleanup(); outside.cleanup();
  }
});

test('cleanup failures are reported and leave the owned content intact', t => {
  const workspace = createTemporaryWorkspace('beyond-temp-lifecycle-denied-');
  fs.writeFileSync(path.join(workspace.root, 'evidence'), 'keep until cleanup works');
  const denied = Object.assign(new Error('simulated permission denial'), { code: 'EACCES' });
  const mocked = t.mock.method(fs, 'rmSync', () => { throw denied; });
  try {
    assert.throws(workspace.cleanup, error => error === denied);
    assert.equal(fs.readFileSync(path.join(workspace.root, 'evidence'), 'utf8'), 'keep until cleanup works');
  } finally { mocked.mock.restore(); workspace.cleanup(); }
});

test('path-like prefixes are rejected before creating a directory', () => {
  for (const prefix of ['', '..', '../escape-', 'a/b-', 'a\\b-', '/absolute-', 'C:escape-']) {
    assert.throws(() => createTemporaryWorkspace(prefix), /plain name/);
  }
});

test('direct node:test fixtures clean up on successful and failing assertions', () => {
  const sandbox = createTemporaryWorkspace('beyond-temp-lifecycle-child-');
  const helper = new URL('./lib/test-workspace.mjs', import.meta.url).href;
  const env = { ...process.env, TEMP: sandbox.root, TMP: sandbox.root, TMPDIR: sandbox.root };
  delete env.NODE_TEST_CONTEXT;
  try {
    for (let round = 0; round < 5; round += 1) {
      const fail = round % 2 === 1;
      const source = `import test from 'node:test';
        import fs from 'node:fs';
        import path from 'node:path';
        import { createTestWorkspace } from ${JSON.stringify(helper)};
        test('fixture lifecycle', () => {
          const root = createTestWorkspace('beyond-child-fixture-');
          fs.writeFileSync(path.join(root, 'fixture'), 'generated content');
          fs.mkdirSync(path.join(path.dirname(root), 'sibling-project'));
          fs.writeFileSync(path.join(path.dirname(root), 'sibling-project', 'data'), 'generated sibling');
          ${fail ? "throw new Error('intentional assertion failure');" : ''}
        });`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env, encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      assert.equal(child.status, fail ? 1 : 0, child.stderr || child.stdout);
      assert.deepEqual(fs.readdirSync(sandbox.root), []);
    }
  } finally { sandbox.cleanup(); }
});
