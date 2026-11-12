/**
 * Graph text written into the generated code (#64). A graph comes from anyone: its ids, names and params must stay
 * data. JSON leaves U+2028 and U+2029 as they are, but JavaScript reads them as line terminators: one in a `//`
 * comment ends it, and what follows would run.
 */

const LINE_SEPARATORS = /[\u2028\u2029]/g;
const escapeSeparator = (c: string) => (c === '\u2028' ? '\\u2028' : '\\u2029');

/** A JavaScript literal of a value: JSON, with U+2028 and U+2029 escaped, so that it is one token anywhere. */
export const literal = (value: unknown): string => (JSON.stringify(value) ?? 'undefined').replace(LINE_SEPARATORS, escapeSeparator);

/** Text on one line: every line terminator of any kind (\r, \n, U+2028, U+2029) becomes a space. */
export const oneLine = (text: string): string => text.replace(/[\r\n\u2028\u2029]+/g, ' ');

/** Text for a `//` or block comment: on one line, and no `*\/`. */
export const commentText = (text: string): string => oneLine(text).replace(/\*\//g, '* /');

/** Text inside a template literal: a literal string, with its backticks and `${` escaped. */
export const templateText = (text: string): string => literal(text).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
