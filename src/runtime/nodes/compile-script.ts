/**
 * Compiling a script node's code (#35, #36), shared by every script node so their errors read the same.
 *
 * `new Function` throws a SyntaxError with no position (V8, SpiderMonkey and JavaScriptCore alike), so on a syntax
 * error the same function is parsed again with acorn, which says where: the line is then the script's own. acorn
 * parses the exact source the engine was given, so the answer does not depend on the browser.
 */
import { parse } from 'acorn';

/**
 * `new Function(...params, body)`, where the script's first line is line `firstLine` of the function as the
 * engine numbers it (it puts two lines before the body: "function anonymous(…" and ") {"). A syntax error is
 * rethrown as an Error "line N: message", N being the script's line (its last line, for a block left open).
 */
export function compileScript<T>(params: readonly string[], body: string, firstLine: number, textLines: number): T {
  try {
    return new Function(...params, body) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const line = syntaxErrorLine(params, body);
    if (line === null) throw err;
    // An error past the script's end (a brace left open is found at the code that follows it): its last line.
    const scriptLine = Math.min(Math.max(line - firstLine + 1, 1), textLines);
    throw new Error(`line ${scriptLine}: ${err.message}`);
  }
}

/** The line, in the function as `new Function` numbers it, where acorn finds the syntax error; null if it finds none. */
function syntaxErrorLine(params: readonly string[], body: string): number | null {
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

/** The number of lines of a script, not counting blank lines at its end. */
export const scriptLines = (text: string): number => text.replace(/\s+$/, '').split('\n').length;
