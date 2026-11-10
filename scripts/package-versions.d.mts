/** The installed version of each package, read from its own package.json under `root`/node_modules. */
export function packageVersions(names: readonly string[], root?: string): Record<string, string>;
/** What the generated project's core part depends on. */
export const CODEGEN_PACKAGES: string[];
