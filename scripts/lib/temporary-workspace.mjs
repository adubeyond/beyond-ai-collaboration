import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The returned handle owns only the directory it created, never a prefix scan.
export function createTemporaryWorkspace(prefix) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*-$/.test(prefix)) {
    throw new Error('Temporary workspace prefix must be a plain name ending in -');
  }
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const original = fs.lstatSync(root, { bigint: true });
  function cleanup() {
    let current;
    try {
      current = fs.lstatSync(root, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== original.dev || current.ino !== original.ino
      || current.birthtimeNs !== original.birthtimeNs
      || path.dirname(root) !== parent || fs.realpathSync(root) !== root) {
      throw new Error(`Refusing to remove a replaced temporary workspace: ${root}`);
    }
    // rm removes nested links themselves, not the directories they point to.
    // Permission failures remain visible; there is no shell/ACL fallback.
    fs.rmSync(root, { recursive: true, force: true });
  }
  return Object.freeze({ root, cleanup });
}
