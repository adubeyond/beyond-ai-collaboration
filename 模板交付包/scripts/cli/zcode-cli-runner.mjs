import { runVisibleCli } from './visible-cli-runner.mjs';
import { openZcodeWindow } from './zcode-client.mjs';

export function runZcodeCli(options) {
  return runVisibleCli({ openWindow: openZcodeWindow, ...options });
}
