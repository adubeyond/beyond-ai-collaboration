import { existsSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const isolatedParent = process.env.BEYOND_ISOLATED_PARENT;
const sourceCodexHome = process.env.BEYOND_SOURCE_CODEX_HOME;
const runRoots = process.argv.slice(2);

if (!isolatedParent || !isAbsolute(isolatedParent) || !sourceCodexHome || !isAbsolute(sourceCodexHome)) {
  throw new Error('absolute BEYOND_ISOLATED_PARENT and BEYOND_SOURCE_CODEX_HOME are required');
}
if (runRoots.length === 0) throw new Error('at least one isolated run root is required');

const allowedParent = resolve(isolatedParent);
let removed = 0;
for (const runRoot of runRoots) {
  if (!isAbsolute(runRoot)) throw new Error(`run root must be absolute: ${runRoot}`);
  const resolvedRoot = resolve(runRoot);
  const fromParent = relative(allowedParent, resolvedRoot);
  if (!fromParent || fromParent.startsWith('..') || isAbsolute(fromParent)) {
    throw new Error(`run root is outside the isolated parent: ${resolvedRoot}`);
  }
  const target = join(resolvedRoot, 'codex-home', 'auth.json');
  if (existsSync(target)) {
    unlinkSync(target);
    removed += 1;
  }
  if (existsSync(target)) throw new Error(`isolated authentication copy still exists: ${target}`);
}

if (!existsSync(join(resolve(sourceCodexHome), 'auth.json'))) {
  throw new Error('source Codex authentication unexpectedly missing');
}

console.log(`isolated authentication copies removed: ${removed}`);
