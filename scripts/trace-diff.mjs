// Compares two tracking traces (JSONL, src/runtime/trackers/trace.ts): pose deltas,
// found / lost timing and jitter per target. Exit code 0 when they match within the
// thresholds, 1 above them, 2 on a usage or read error.
//
//   npm run trace:diff -- a.jsonl b.jsonl [--json] [--translation-mm 1] [--rotation-deg 0.5]
//                         [--transition-ms 0] [--found-frames 0] [--jitter-mm 0.5] [--jitter-deg 0.25]
//
// The comparison lives in tests/helpers/trace-diff.ts, loaded through tsx.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const FLAGS = {
  'translation-mm': 'translationMm',
  'rotation-deg': 'rotationDeg',
  'transition-ms': 'transitionMs',
  'found-frames': 'foundFrames',
  'jitter-mm': 'jitterMm',
  'jitter-deg': 'jitterDeg',
};

function fail(message) {
  console.error(`trace-diff: ${message}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean' }, ...Object.fromEntries(Object.keys(FLAGS).map((f) => [f, { type: 'string' }])) },
  });
} catch (err) {
  fail(err.message);
}
if (args.positionals.length !== 2) fail('usage: trace-diff <a.jsonl> <b.jsonl> [--json] [--<threshold> <value>]');

const { parseTrace } = await tsImport('../src/runtime/trackers/trace.ts', import.meta.url);
const { DEFAULT_THRESHOLDS, diffTraces, formatDiff } = await tsImport('../tests/helpers/trace-diff.ts', import.meta.url);

const thresholds = { ...DEFAULT_THRESHOLDS };
for (const [flag, key] of Object.entries(FLAGS)) {
  const raw = args.values[flag];
  if (raw === undefined) continue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${flag} must be a number >= 0`);
  thresholds[key] = value;
}

const [a, b] = args.positionals.map((file) => {
  try {
    return parseTrace(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: ${err.message}`);
  }
});

const diff = diffTraces(a, b, thresholds);
console.log(args.values.json ? JSON.stringify({ thresholds, ...diff }, null, 1) : formatDiff(diff));
process.exit(diff.failures.length ? 1 : 0);
