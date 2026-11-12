// PreToolUse on Bash and PowerShell: refuses what skips the e2e lock, and force pushes.
// It reads the command the way a shell splits it, so these words in a quoted string, a here-document
// or a commit message pass. It does not look inside `sh -c "..."`, `cmd /c ...`, variables or a quoted
// "$(...)", or at `node .../cli.js test`, and a wrapper's own options can hide the program (`sudo -u x`).
// False refusals stop real work, misses only lose a convenience: CI is what enforces the rules.
import { report, runHook } from './lib.mjs';

/** Text that is not commands: bash here-documents, whose opening line stays, and PowerShell here-strings. */
const withoutHereText = (source) =>
  source
    .replace(/@'\r?\n[\s\S]*?\r?\n'@/g, '""')
    .replace(/@"\r?\n[\s\S]*?\r?\n"@/g, '""')
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\s|$)/g, '$3');

/** Splits a command into its simple commands, each a list of words with the quotes removed. */
function simpleCommands(source) {
  const command = withoutHereText(source);
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
    const next = command[i + 1];
    if (c === "'" || c === '"') {
      word ??= '';
      for (i++; i < command.length && command[i] !== c; i++) {
        if (c === '"' && command[i] === '\\' && i + 1 < command.length) i++;
        word += command[i];
      }
    } else if (c === '#' && word === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (c === '\\' && (next === "'" || next === '"')) {
      word = (word ?? '') + next;
      i++;
    } else if ((c === '\\' || c === '`') && next === '\n') {
      // A line continuation, in bash or in PowerShell.
      endWord();
      i++;
    } else if (c === '`' && next === '\r' && command[i + 2] === '\n') {
      endWord();
      i += 2;
    } else if (c === '&' && (word?.endsWith('>') || next === '>')) {
      // A redirect (`2>&1`, `&>file`), not the end of a command.
      word = (word ?? '') + c;
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

/** The program's name: `node_modules\.bin\playwright.cmd` → `playwright`, `GIT` → `git`. */
const programName = (word) =>
  word
    .split(/[\\/]/)
    .pop()
    .replace(/\.(cmd|ps1|exe)$/i, '')
    .toLowerCase();

/** What can come before the program: shell keywords, and commands that run another command. */
const BEFORE_PROGRAM = new Set(['do', 'then', 'else', 'elif', '{', '!', 'env', 'time', 'command', 'sudo', 'exec', 'nohup', 'nice', 'timeout']);

/** Leaves out what comes before the program: `FOO=1`, `do`, `timeout 300`, `nice -n 5`. */
function withoutPrefixes(words) {
  let start = 0;
  while (start < words.length) {
    if (/^\w+=/.test(words[start])) {
      start++;
    } else if (BEFORE_PROGRAM.has(words[start])) {
      start++;
      while (start < words.length && (words[start].startsWith('-') || /^\d+[smhd]?$/.test(words[start]))) start++;
    } else {
      break;
    }
  }
  return words.slice(start);
}

/** Leaves out options, and the value of those that take the next word as one. */
function withoutOptions(words, takesValue) {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    if (takesValue.includes(words[i])) i++;
    else if (!words[i].startsWith('-')) kept.push(words[i]);
  }
  return kept;
}

const isPlaywright = (word) => /^(@playwright\/test|playwright)(@.+)?$/.test(word);
const VALUE_OPTIONS = ['-p', '--package', '-c', '--config'];

function runsPlaywrightTest(words) {
  const program = programName(words[0]);
  let rest = words.slice(1);
  if (program === 'npm') {
    if (rest[0] !== 'exec' && rest[0] !== 'x') return false;
    rest = rest.slice(1);
  } else if (!['npx', 'pnpx', 'bunx'].includes(program)) {
    return isPlaywright(program) && withoutOptions(rest, VALUE_OPTIONS)[0] === 'test';
  }
  rest = withoutOptions(rest, VALUE_OPTIONS);
  return isPlaywright(rest[0] ?? '') && rest[1] === 'test';
}

/** `git push` options whose next word is their value, not a refspec. */
const PUSH_VALUE_OPTIONS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];

function forcePushes(words) {
  if (programName(words[0]) !== 'git') return false;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    // These global options take their value as the next word.
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i]) ? 2 : 1;
  }
  if (words[i] !== 'push') return false;
  for (let j = i + 1; j < words.length; j++) {
    const word = words[j];
    if (PUSH_VALUE_OPTIONS.includes(word)) j++;
    else if (/^--(force|mirror)/.test(word) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(word) || word.startsWith('+')) return true;
  }
  return false;
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
