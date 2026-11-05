// PreToolUse on Bash and PowerShell: refuses what skips the e2e lock, and force pushes.
// It reads the command the way a shell splits it, so these words in a quoted string or a commit
// message pass. It does not look inside `sh -c "..."` or variables: CI is what enforces the rules.
import { report, runHook } from './lib.mjs';

/** Splits a command into its simple commands, each a list of words with the quotes removed. */
function simpleCommands(source) {
  // A here-document is text, not commands.
  const command = source.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, '');
  const commands = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      word ??= '';
      for (i++; i < command.length && command[i] !== c; i++) {
        if (c === '"' && command[i] === '\\' && i + 1 < command.length) i++;
        word += command[i];
      }
    } else if (c === '#' && word === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (c === '\\' && command[i + 1] === '\n') {
      i++;
    } else if (';&|()\n`'.includes(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand();
  return commands;
}

/** The program's name: `node_modules\.bin\playwright.cmd` → `playwright`. */
const programName = (word) =>
  word
    .split(/[\\/]/)
    .pop()
    .replace(/\.(cmd|ps1|exe)$/i, '');

/** Leaves out what comes before the program: `FOO=1`, `env`, `time`, `command`. */
function withoutPrefixes(words) {
  let start = 0;
  while (start < words.length && (/^\w+=/.test(words[start]) || ['env', 'time', 'command', 'sudo'].includes(words[start]))) start++;
  return words.slice(start);
}

const isPlaywright = (word) => /^(@playwright\/test|playwright)(@.+)?$/.test(word);

function runsPlaywrightTest(words) {
  const program = programName(words[0]);
  let rest = words.slice(1);
  if (program === 'npm') {
    if (rest[0] !== 'exec' && rest[0] !== 'x') return false;
    rest = rest.slice(1);
  } else if (!['npx', 'pnpx', 'bunx'].includes(program)) {
    return isPlaywright(program) && rest[0] === 'test';
  }
  rest = rest.filter((word) => !word.startsWith('-'));
  return isPlaywright(rest[0] ?? '') && rest[1] === 'test';
}

function forcePushes(words) {
  if (programName(words[0]) !== 'git') return false;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    // These global options take their value as the next word.
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i]) ? 2 : 1;
  }
  if (words[i] !== 'push') return false;
  return words.slice(i + 1).some((word) => /^--force(-with-lease|-if-includes)?(=|$)/.test(word) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(word) || word.startsWith('+'));
}

/** Why this command is refused, or null. */
function refusal(command) {
  for (const raw of simpleCommands(command)) {
    const words = withoutPrefixes(raw);
    if (!words.length) continue;
    if (runsPlaywrightTest(words)) {
      return 'Refused: `npx playwright test` skips the e2e lock shared by the worktrees. Use `npm run test:e2e -- <playwright args>` (AGENTS.md, "Commands").';
    }
    if (forcePushes(words)) {
      return 'Refused: this is a force push. Push without force, or ask the maintainer.';
    }
  }
  return null;
}

runHook('guard-bash', (input) => {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return;
  const reason = refusal(command);
  if (reason) report(reason);
});
