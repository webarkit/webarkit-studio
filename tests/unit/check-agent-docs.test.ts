import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/check-agent-docs.mjs');

/** The smallest repository the check accepts: one nested folder, and everything it reads. */
const VALID: Record<string, string> = {
  'package.json': JSON.stringify({ scripts: { 'check:agents': 'x' } }),
  'AGENTS.md': 'Folders with their own file: `lib/`.\n',
  'CLAUDE.md': '@AGENTS.md\n',
  '.github/copilot-instructions.md': 'See AGENTS.md\n',
  '.gemini/settings.json': JSON.stringify({ context: { fileName: ['AGENTS.md'] } }),
  '.mcp.json': JSON.stringify({
    mcpServers: {
      'webarkit-studio': { command: 'node', args: ['src/main.ts'] },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.1'] },
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.0.0', '--isolated', '--usageStatistics=false'] },
    },
  }),
  'src/main.ts': '',
  'src/here.ts': '',
  'lib/AGENTS.md': 'Refines the root. See `src/here.ts`.\n',
  'lib/CLAUDE.md': '@AGENTS.md\n',
};

describe('check-agent-docs: nested agent files', () => {
  let root: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const check = () => {
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    return { status: run.status, output: run.stdout + run.stderr };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-docs-'));
    for (const [path, text] of Object.entries(VALID)) write(path, text);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a nested folder with both files, listed in the root', () => {
    expect(check()).toMatchObject({ status: 0 });
  });

  it('fails on a nested CLAUDE.md that does not import its AGENTS.md', () => {
    write('lib/CLAUDE.md', 'Some rules of its own.\n');
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/CLAUDE.md');
    expect(output).toContain('@AGENTS.md');
  });

  it('fails on a nested CLAUDE.md that holds more than the import', () => {
    write('lib/CLAUDE.md', '@AGENTS.md\n\nA rule that belongs in AGENTS.md.\n');
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/CLAUDE.md');
  });

  it('fails on a missing path named in a nested file', () => {
    write('lib/AGENTS.md', 'See `src/gone.ts`.\n');
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/AGENTS.md');
    expect(output).toContain('src/gone.ts');
  });

  it('fails on a command that does not exist, named in a nested file', () => {
    write('lib/AGENTS.md', 'Run `npm run nope`.\n');
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('npm run nope');
  });

  it('fails on a nested AGENTS.md without its CLAUDE.md', () => {
    rmSync(join(root, 'lib/CLAUDE.md'));
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/CLAUDE.md');
  });

  it('fails on a nested CLAUDE.md without its AGENTS.md', () => {
    rmSync(join(root, 'lib/AGENTS.md'));
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/AGENTS.md');
  });

  it('fails on a nested folder the root does not list', () => {
    write('AGENTS.md', 'No folders listed.\n');
    const { status, output } = check();
    expect(status).toBe(1);
    expect(output).toContain('lib/');
  });

  it('finds a folder at any depth, and leaves out dependencies, builds and hidden folders', () => {
    write('a/b/AGENTS.md', 'Deep.\n');
    write('a/b/CLAUDE.md', '@AGENTS.md\n');
    expect(check().output).toContain('a/b/');
    write('AGENTS.md', 'Folders with their own file: `lib/`, `a/b/`.\n');
    write('node_modules/pkg/CLAUDE.md', 'Not ours.\n');
    write('dist/CLAUDE.md', 'Not ours.\n');
    write('.claude/worktrees/x/lib/CLAUDE.md', 'Another checkout.\n');
    expect(check()).toMatchObject({ status: 0 });
  });
});
