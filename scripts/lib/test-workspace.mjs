import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { createTemporaryWorkspace } from './temporary-workspace.mjs';

const workspaces = [];
after(() => {
  const errors = [];
  for (const workspace of workspaces.reverse()) {
    try { workspace.cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Test workspace cleanup failed');
});

export function createTestWorkspace(prefix) {
  const workspace = createTemporaryWorkspace(prefix);
  workspaces.push(workspace);
  // Some fixtures model an external control root beside its business project.
  // Own their parent too, so sibling outputs never land in shared OS TEMP.
  const fixture = path.join(workspace.root, 'fixture');
  fs.mkdirSync(fixture);
  return fixture;
}
