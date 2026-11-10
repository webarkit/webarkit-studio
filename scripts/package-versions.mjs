// The installed versions of packages, read from their own package.json (some, like three, do not export it).
// vite.config.ts and vitest.config.ts define them for the source code export (#64), which writes exact versions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function packageVersions(names, root = process.cwd()) {
  return Object.fromEntries(
    names.map((name) => [name, JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version]),
  );
}

/** What the generated project's core part depends on. */
export const CODEGEN_PACKAGES = ['three', 'vite'];
