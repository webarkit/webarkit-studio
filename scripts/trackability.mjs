// Rates how well an NFT dataset will track (#10): feature-point density, coverage and
// repetition, read from the .fset3 and .fset the NFT generator wrote. Exit code 0 for a
// good or fair dataset, 1 for a poor one, 2 on a usage or read error.
//
//   npm run trackability -- <dataset> [--json] [--grid 8] [--repeat-bits 64] [--repeat-distance 0.1]
//                           [--<check>-warn <value>] [--<check>-fail <value>]
//
// <dataset> is the path without extension (public/data/DataNFT/pinball) or any of its
// .iset / .fset / .fset3 files. <check> is detection-points, detection-coverage,
// repetition, tracking-points or tracking-coverage.
//
// The check lives in plugins/jsartoolkit-nft/, loaded through tsx. The MCP server's
// trackability_check calls the same checkDatasetFiles.
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const LIMITS = {
  'detection-points': 'detectionPoints',
  'detection-coverage': 'detectionCoverage',
  repetition: 'repetition',
  'tracking-points': 'trackingPoints',
  'tracking-coverage': 'trackingCoverage',
};
const NUMBERS = { grid: 'grid', 'repeat-bits': 'repeatBits', 'repeat-distance': 'repeatDistance' };

function fail(message) {
  console.error(`trackability: ${message}`);
  process.exit(2);
}

const limitFlags = Object.keys(LIMITS).flatMap((f) => [`${f}-warn`, `${f}-fail`]);
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      ...Object.fromEntries([...Object.keys(NUMBERS), ...limitFlags].map((f) => [f, { type: 'string' }])),
    },
  });
} catch (err) {
  fail(err.message);
}
if (args.positionals.length !== 1) fail('usage: trackability <dataset> [--json] [--<threshold> <value>]');

const { DEFAULT_TRACKABILITY, formatTrackability, validateThresholds } = await tsImport('../plugins/jsartoolkit-nft/trackability.ts', import.meta.url);
const { checkDatasetFiles } = await tsImport('../plugins/jsartoolkit-nft/trackability-files.ts', import.meta.url);

function number(flag) {
  const value = Number(args.values[flag]);
  if (!Number.isFinite(value) || value < 0) fail(`--${flag} must be a number >= 0`);
  return value;
}

const thresholds = structuredClone(DEFAULT_TRACKABILITY);
for (const [flag, key] of Object.entries(NUMBERS)) {
  if (args.values[flag] !== undefined) thresholds[key] = number(flag);
}
for (const [flag, key] of Object.entries(LIMITS)) {
  for (const level of ['warn', 'fail']) {
    if (args.values[`${flag}-${level}`] !== undefined) thresholds[key][level] = number(`${flag}-${level}`);
  }
}

try {
  validateThresholds(thresholds);
} catch (err) {
  fail(err.message.replace(/^trackability: /, '--'));
}

let report;
try {
  report = checkDatasetFiles(args.positionals[0], thresholds);
} catch (err) {
  fail(err.message);
}

console.log(args.values.json ? JSON.stringify(report, null, 1) : formatTrackability(report));
process.exit(report.verdict === 'poor' ? 1 : 0);
