// What the hook scripts share. A hook is a convenience: when it cannot read its input, or is turned
// off, it does nothing rather than get in the way of the session. CI is what enforces the rules.
import { readFileSync } from 'node:fs';

/** The JSON Claude Code passes on stdin, or null when there is none. */
function readInput() {
  try {
    // A PowerShell pipe adds a byte order mark, which JSON.parse refuses.
    const text = readFileSync(0, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

/** STUDIO_HOOKS_OFF is a comma-separated list of hook names (`guard-bash,post-edit`). */
const isOff = (name) => (process.env.STUDIO_HOOKS_OFF ?? '').split(',').some((entry) => entry.trim() === name);

/** Runs a hook on its input, unless it is turned off or has none. */
export function runHook(name, handler) {
  if (isOff(name)) return;
  const input = readInput();
  if (input) handler(input);
}

/** Text for the session's context, without blocking anything. */
export function addContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

/** Blocks a PreToolUse call, or shows a PostToolUse problem to Claude: only exit 2 does either. */
export function report(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
