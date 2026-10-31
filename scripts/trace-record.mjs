// Records a tracking trace in Node (Node build of jsartoolkit-nft, deterministic frames,
// see tests/helpers/trace-recorder.ts). Needs `npm run assets`; run from the repository root.
//
//   npm run trace:record -- --out a.jsonl                      the golden run's frames and settings
//   npm run trace:record -- --out b.jsonl --filter oneEuro     same, with a filter (none | native | oneEuro)
//   npm run trace:record -- --out c.jsonl --replay a.jsonl     replay a trace's frames and settings
//   npm run trace:record -- --out d.jsonl --settings '{"lostTimeout":100}'   merge settings
//   npm run trace:record -- --out golden.jsonl --golden        the golden run of #5 (ArtkSession, 1.14.0)
//
// --filter and --settings override the replayed trace's when both are given.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

function fail(message) {
  console.error(`trace-record: ${message}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      out: { type: 'string' },
      filter: { type: 'string' },
      settings: { type: 'string' },
      replay: { type: 'string' },
      golden: { type: 'boolean' },
    },
  });
} catch (err) {
  fail(err.message);
}
const { out, filter, settings, replay, golden } = args.values;
if (!out) fail('--out <file.jsonl> is required');

// Catalog defaults of the filter nodes (src/nodes/catalog.ts).
const FILTERS = {
  none: null,
  native: { kind: 'native', library: 'jsartoolkitNFT' },
  oneEuro: { kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 5 },
};
if (filter !== undefined && !(filter in FILTERS)) fail(`--filter must be one of ${Object.keys(FILTERS).join(', ')}`);

const { parseTrace, serializeTrace, traceFrames } = await tsImport('../src/runtime/trackers/trace.ts', import.meta.url);
const recorder = await tsImport('../tests/helpers/trace-recorder.ts', import.meta.url);
const { GOLDEN_SETTINGS } = await tsImport('../tests/helpers/golden.ts', import.meta.url);

let trace;
try {
  if (golden) {
    trace = recorder.goldenToTrace();
  } else {
    const base = replay ? parseTrace(readFileSync(replay, 'utf8')) : null;
    const overrides = {};
    if (filter !== undefined) overrides.filter = FILTERS[filter];
    if (settings !== undefined) overrides.settings = { ...(base?.header.settings ?? GOLDEN_SETTINGS), ...JSON.parse(settings) };
    trace = base ? await recorder.replayTrace(base, overrides) : await recorder.recordTrace(overrides);
  }
} catch (err) {
  fail(err.message);
}
writeFileSync(out, serializeTrace(trace));
const { tracker, filter: f } = trace.header;
console.log(`✓ ${out}: ${traceFrames(trace).length} frames, ${tracker.name} ${tracker.version}, filter ${f ? f.kind : 'none'}`);
