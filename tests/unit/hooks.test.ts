import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hook = (name: string) => resolve(`.claude/hooks/${name}.mjs`);

function run(name: string, input: unknown, options: { cwd?: string; off?: string } = {}) {
  const env = { ...process.env };
  delete env.STUDIO_HOOKS_OFF;
  if (options.off !== undefined) env.STUDIO_HOOKS_OFF = options.off;
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [hook(name)], { input: stdin, encoding: 'utf8', cwd: options.cwd, env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('guard-bash', () => {
  const guard = (command: string, tool_name = 'Bash', off?: string) => run('guard-bash', { hook_event_name: 'PreToolUse', tool_name, tool_input: { command } }, { off });

  it.each([
    'npx playwright test',
    'npx playwright test tests/e2e/studio.spec.ts --grep foo',
    'npx -y playwright test',
    'npx playwright@1.64.1 test',
    'npm exec playwright test',
    'node_modules/.bin/playwright test',
    'node_modules\\.bin\\playwright.cmd test',
    'cd tests && npx playwright test',
    'FOO=1 npx playwright test',
    'for i in 1 2 3; do npx playwright test; done',
    '! npx playwright test',
    'foreach ($i in 1..3) { npx playwright test }',
    'git status; if ($?) { npx playwright test }',
    'timeout 300 npx playwright test',
    'nohup npx playwright test &',
    'exec npx playwright test',
    'npx -p @playwright/test playwright test',
    'npx --package @playwright/test playwright test',
    'npx playwright -c playwright.config.ts test',
  ])('refuses %s and names npm run test:e2e', (command) => {
    const { status, stderr } = guard(command);
    expect(status).toBe(2);
    expect(stderr).toContain('npm run test:e2e');
  });

  it.each([
    'git push --force',
    'git push -f',
    'git push origin dev --force',
    'git push --force-with-lease',
    'git push --force-with-lease=dev:abc',
    'git push --force-if-includes',
    'git push -fu origin dev',
    'git push -uf origin dev',
    'git push origin +dev',
    'git -C some/path push -f',
    'git -c a=b push --force',
    'git status && git push -f',
    'git status; git push -f',
    '(git push -f)',
    'if true; then git push -f; fi',
    'true && { git push -f; }',
    'if ($?) { git push -f }',
    '& { git push -f }',
    'git push --mirror',
    'git push --force-w',
    'git push 2>&1 -f',
    'git push `\n --force origin dev',
    'GIT push -f',
    'cat <<EOF && git push -f\nbody\nEOF',
  ])('refuses %s', (command) => {
    const { status, stderr } = guard(command);
    expect(status).toBe(2);
    expect(stderr).toMatch(/force/i);
  });

  it.each([
    'npm run test:e2e',
    'npm run test:e2e -- tests/e2e/studio.spec.ts',
    'npx playwright install chromium',
    'npx playwright show-trace trace.zip',
    'npx vitest run',
    'git push',
    'git push origin docs/52-agent-folders-hooks',
    'git push -u origin dev',
    'git push origin dev:refs/heads/force',
    'git status',
    'git log --format=%h -f',
    'echo npx playwright test',
    'echo "git push --force"',
    'git commit -m "never run git push --force or npx playwright test"',
    "git commit -m 'npx playwright test; git push -f'",
    'grep -rn "npx playwright test" docs',
    '# git push -f',
    "cat <<'EOF'\ngit push -f\nnpx playwright test\nEOF",
    "git commit -m @'\nDon't use this:\ngit push --force\n'@",
    "git commit -m @'\nDon't use `npx playwright test`: it skips the lock.\n'@",
    "gh pr create --title x --body @'\nThe hook doesn't allow `git push --force`.\n'@",
    "$body = @'\nThat's it\nnpx playwright test\n'@\ngh pr create --body $body",
    'git commit -m @"\nSays "hi\ngit push -f\n"@',
    "git commit -m 'don'\\''t `git push -f`'",
    'git push -o +x origin dev',
    'git push 2>&1',
    'timeout 300 npm run test:e2e',
  ])('lets through %s', (command) => {
    expect(guard(command)).toMatchObject({ status: 0, stderr: '' });
  });

  it('applies to the PowerShell tool too', () => {
    expect(guard('npx playwright test', 'PowerShell').status).toBe(2);
    expect(guard('git status; git push -f', 'PowerShell').status).toBe(2);
    expect(guard('npm run test:e2e', 'PowerShell').status).toBe(0);
  });

  it('ignores other tools', () => {
    expect(guard('git push -f', 'Read').status).toBe(0);
  });

  it('never blocks on input it cannot read', () => {
    expect(run('guard-bash', 'not json').status).toBe(0);
    expect(run('guard-bash', '').status).toBe(0);
    expect(run('guard-bash', { tool_name: 'Bash' }).status).toBe(0);
  });

  it('reads input with a byte order mark, which a PowerShell pipe adds', () => {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f' } });
    expect(run('guard-bash', `${String.fromCharCode(0xfeff)}${input}\r\n`).status).toBe(2);
  });

  it('is turned off by STUDIO_HOOKS_OFF, by name', () => {
    expect(guard('git push -f', 'Bash', 'guard-bash').status).toBe(0);
    expect(guard('git push -f', 'Bash', 'post-edit, guard-bash').status).toBe(0);
    expect(guard('git push -f', 'Bash', 'post-edit').status).toBe(2);
  });
});

describe('post-edit', () => {
  let root: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const edit = (path: string, off?: string) =>
    run('post-edit', { hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: join(root, path) } }, { off });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'post-edit-'));
    write('AGENTS.md', 'Root.\n');
    // A stand-in for the checkout's own check: it fails while the file `broken` exists.
    write('scripts/check-agent-docs.mjs', "import { existsSync } from 'node:fs';\nif (existsSync('broken')) { console.error('out of sync: reason'); process.exit(1); }\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    'AGENTS.md',
    'CLAUDE.md',
    'plugins/x/AGENTS.md',
    'tests/e2e/CLAUDE.md',
    '.github/copilot-instructions.md',
    '.github/instructions/graph.instructions.md',
    '.claude/agents/graph-reviewer.md',
    '.claude/skills/new-node/SKILL.md',
    'docs/agents/checklists/graph-review.md',
    '.gemini/settings.json',
    '.mcp.json',
    'package.json',
  ])('reports with exit 2 when %s leaves check:agents failing', (path) => {
    write('broken', '');
    const { status, stderr } = edit(path);
    expect(status).toBe(2);
    expect(stderr).toContain('out of sync: reason');
  });

  it('does not run the check of the checkout around a worktree without one, and still reminds', () => {
    write('broken', '');
    write('.claude/worktrees/old/.git', 'gitdir: elsewhere');
    expect(edit('.claude/worktrees/old/AGENTS.md')).toMatchObject({ status: 0, stderr: '' });
    const reminder = edit('.claude/worktrees/old/src/nodes/catalog.ts');
    expect(reminder.status).toBe(0);
    expect(reminder.stdout).toContain('format change');
  });

  it('stays silent when the check passes', () => {
    expect(edit('AGENTS.md')).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it.each(['src/runtime/nodes/x.ts', 'README.md', 'docs/plugins.md', '.claude/skills/new-node/notes.md'])('does not run the check for %s', (path) => {
    write('broken', '');
    expect(edit(path)).toMatchObject({ status: 0, stderr: '' });
  });

  it.each(['src/nodes/catalog.ts', 'plugins/jsartoolkit-nft/catalog.ts'])('reminds of the format change rule when %s changes', (path) => {
    const { status, stdout, stderr } = edit(path);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const { hookSpecificOutput } = JSON.parse(stdout);
    expect(hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(hookSpecificOutput.additionalContext).toContain('format change');
    expect(hookSpecificOutput.additionalContext).toContain('GRAPH_VERSION');
  });

  it('lets through a file outside any checkout', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
    writeFileSync(join(elsewhere, 'CLAUDE.md'), '');
    const result = run('post-edit', { tool_name: 'Write', cwd: elsewhere, tool_input: { file_path: join(elsewhere, 'CLAUDE.md') } });
    rmSync(elsewhere, { recursive: true, force: true });
    expect(result).toMatchObject({ status: 0, stderr: '' });
  });

  it('resolves a relative path against the cwd of its input', () => {
    write('broken', '');
    const result = run('post-edit', { tool_name: 'Edit', cwd: root, tool_input: { file_path: 'AGENTS.md' } });
    expect(result.status).toBe(2);
  });

  it('never blocks on input it cannot read', () => {
    expect(run('post-edit', 'not json').status).toBe(0);
    expect(run('post-edit', { tool_name: 'Edit' }).status).toBe(0);
  });

  it('is turned off by STUDIO_HOOKS_OFF', () => {
    write('broken', '');
    expect(edit('AGENTS.md', 'post-edit')).toMatchObject({ status: 0, stderr: '' });
  });
});

describe('session-context', () => {
  let root: string;
  const git = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const context = (off?: string) => {
    const result = run('session-context', { hook_event_name: 'SessionStart', source: 'startup', cwd: root }, { off });
    return { ...result, text: result.stdout ? (JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string) : '' };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports the branch, how far it is from origin/dev, and missing assets', () => {
    git('init', '-q', '-b', 'feat/x');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const { status, text } = context();
    expect(status).toBe(0);
    expect(text).toContain('feat/x');
    expect(text).toMatch(/1 ahead.*0 behind/);
    expect(text).toContain('npm run assets');
  });

  it('says nothing about assets once they are there', () => {
    git('init', '-q', '-b', 'feat/x');
    mkdirSync(join(root, 'public/data'), { recursive: true });
    writeFileSync(join(root, 'public/data/camera_para.dat'), '');
    expect(context().text).not.toContain('npm run assets');
  });

  it('works without origin/dev', () => {
    git('init', '-q', '-b', 'feat/x');
    const { status, text } = context();
    expect(status).toBe(0);
    expect(text).toContain('feat/x');
    expect(text).not.toContain('ahead');
  });

  it('says nothing outside a git repository', () => {
    expect(context()).toMatchObject({ status: 0, stdout: '' });
  });

  it('never blocks on input it cannot read', () => {
    expect(run('session-context', 'not json').status).toBe(0);
  });

  it('is turned off by STUDIO_HOOKS_OFF', () => {
    git('init', '-q', '-b', 'feat/x');
    expect(context('session-context')).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('scripts/agent-files.mjs', () => {
  it('counts as an agent file everything the check reads', async () => {
    const { pointerFiles, nestedAgentFolders, isAgentFile } = await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/agent-files.mjs')).href);
    const nested = (nestedAgentFolders() as string[]).flatMap((folder) => [`${folder}/AGENTS.md`, `${folder}/CLAUDE.md`]);
    expect(nested.length).toBeGreaterThan(0);
    for (const file of [...(pointerFiles() as string[]), ...nested, 'AGENTS.md', '.gemini/settings.json', '.mcp.json', 'package.json']) {
      expect(isAgentFile(file), file).toBe(true);
    }
  });

  it.each(['public/data', 'tests/fixtures'])('does not report an agent file under %s, and still reports the folders of ours', async (generated) => {
    const { nestedAgentFolders } = await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/agent-files.mjs')).href);
    const root = mkdtempSync(join(tmpdir(), 'agent-folders-'));
    try {
      // `docs/data` and `other/tests/fixtures` share a name with a generated folder, not its path.
      for (const folder of [generated, `${generated}/deeper`, 'src/runtime', 'tests/e2e', 'docs/data', 'other/tests/fixtures']) {
        mkdirSync(join(root, folder), { recursive: true });
        writeFileSync(join(root, folder, 'AGENTS.md'), 'x');
      }
      expect((nestedAgentFolders(root) as string[]).sort()).toEqual(['docs/data', 'other/tests/fixtures', 'src/runtime', 'tests/e2e']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('.claude/settings.json', () => {
  type Hook = { type: string; command: string; args: string[]; shell?: string };
  type HookEvents = Record<string, { matcher?: string; hooks: Hook[] }[]>;

  const SCRIPT = /^\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/[a-z-]+\.mjs$/;
  const scriptPath = (name: string) => `\${CLAUDE_PROJECT_DIR}/.claude/hooks/${name}.mjs`;

  /** What is wrong with the declared hooks: each must run a script of .claude/hooks that exists, with node, without a shell. */
  function hookProblems(events: HookEvents) {
    const problems: string[] = [];
    for (const [event, list] of Object.entries(events)) {
      for (const { command, args, shell } of list.flatMap((group) => group.hooks)) {
        const script = args?.[0] ?? '';
        if (command !== 'node') problems.push(`${event}: runs "${command}", not node`);
        if (shell !== undefined) problems.push(`${event}: declares the shell "${shell}"`);
        if (!SCRIPT.test(script)) problems.push(`${event}: "${script}" is not a script of .claude/hooks`);
        else if (!existsSync(script.replace('${CLAUDE_PROJECT_DIR}/', ''))) problems.push(`${event}: "${script}" does not exist`);
      }
    }
    return problems;
  }

  const settings: { hooks: HookEvents } = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));

  it('declares the three events and nothing else', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart']);
  });

  it.each([
    ['SessionStart', undefined, 'session-context'],
    ['PreToolUse', 'Bash|PowerShell', 'guard-bash'],
    ['PostToolUse', 'Edit|Write', 'post-edit'],
  ])('declares %s, matching %s, on the %s script', (event, matcher, script) => {
    const entry = settings.hooks[event].find((candidate) => candidate.matcher === matcher);
    expect(entry?.hooks.map((declared) => declared.args[0])).toContain(scriptPath(script));
  });

  it('runs every declared hook on a script that exists, without a shell', () => {
    expect(hookProblems(settings.hooks)).toEqual([]);
  });

  describe('reports a hook after the first of its event', () => {
    const missing = scriptPath('no-such-script');

    it('a second hook of the group, whose script does not exist', () => {
      const events = structuredClone(settings.hooks);
      events.PreToolUse[0].hooks.push({ type: 'command', command: 'node', args: [missing] });
      expect(hookProblems(events)).toEqual([`PreToolUse: "${missing}" does not exist`]);
    });

    it('a second group of the event, whose script does not exist', () => {
      const events = structuredClone(settings.hooks);
      events.PostToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'node', args: [missing] }] });
      expect(hookProblems(events)).toEqual([`PostToolUse: "${missing}" does not exist`]);
    });

    it('a second hook that runs a shell', () => {
      const events = structuredClone(settings.hooks);
      events.SessionStart[0].hooks.push({ type: 'command', command: 'bash', args: [scriptPath('guard-bash')] });
      expect(hookProblems(events)).toEqual(['SessionStart: runs "bash", not node']);
    });

    it('a second hook that declares a shell', () => {
      const events = structuredClone(settings.hooks);
      events.SessionStart[0].hooks.push({ type: 'command', command: 'node', args: [scriptPath('guard-bash')], shell: 'bash' });
      expect(hookProblems(events)).toEqual(['SessionStart: declares the shell "bash"']);
    });
  });

  it('holds no personal rule: only hooks and the schema', () => {
    expect(Object.keys(settings).sort()).toEqual(['$schema', 'hooks']);
  });
});
