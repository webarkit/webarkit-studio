/**
 * Compiling a script node's code (#35, #36), shared by every script node so their errors read the same.
 *
 * `new Function` throws a SyntaxError with no position (V8, SpiderMonkey and JavaScriptCore alike). The line comes
 * from acorn, which parses the same function and says where: the same answer in every browser. acorn is loaded
 * with a dynamic import, only on a syntax error: a script that compiles never loads it, and an exported app pays for
 * it only when a script has one. So the error comes first, without its line, and `locate()` adds the line after.
 */

/** A syntax error in a script: its message now, and its line in the script once acorn answers (null if it cannot). */
export class ScriptSyntaxError extends Error {
  constructor(
    message: string,
    readonly locate: () => Promise<number | null>,
  ) {
    super(message);
  }
}

/**
 * `new Function(...params, body)`, where the script's first line is line `firstLine` of the function as the
 * engine numbers it (it puts two lines before the body: "function anonymous(…" and ") {"). A syntax error is
 * rethrown as a ScriptSyntaxError; any other error as it is.
 */
export function compileScript<T>(params: readonly string[], body: string, firstLine: number, textLines: number): T {
  try {
    return new Function(...params, body) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ScriptSyntaxError(err.message, async () => {
      const line = await syntaxErrorLine(params, body);
      // An error past the script's end (a brace left open is found at the code that follows it): its last line.
      return line === null ? null : Math.min(Math.max(line - firstLine + 1, 1), textLines);
    });
  }
}

/** The line, in the function as `new Function` numbers it, where acorn finds the syntax error; null if it finds none. */
async function syntaxErrorLine(params: readonly string[], body: string): Promise<number | null> {
  let parse: typeof import('acorn').parse;
  try {
    ({ parse } = await import('acorn'));
  } catch {
    return null; // not loaded (offline, a missing chunk): the error stays without its line
  }
  // The source V8 builds for new Function: the same lines, so the same numbers.
  const source = `(function anonymous(${params.join(',')}\n) {\n${body}\n})`;
  try {
    parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    return null;
  } catch (err) {
    const loc = (err as { loc?: { line: number } }).loc;
    return loc ? loc.line : null;
  }
}

/**
 * Shows a compile error now and, for a syntax error, again with its line when acorn answers: `show` gets the
 * message ("line N: message" once known), and `current` says whether that error is still the one shown.
 */
export function reportCompileError(err: unknown, show: (message: string) => void, current: (message: string) => boolean): void {
  const message = (err as Error).message;
  show(message);
  if (!(err instanceof ScriptSyntaxError)) return;
  void err.locate().then((line) => {
    if (line !== null && current(message)) show(`line ${line}: ${message}`);
  });
}

/** The number of lines of a script, not counting blank lines at its end. */
export const scriptLines = (text: string): number => text.replace(/\s+$/, '').split('\n').length;
