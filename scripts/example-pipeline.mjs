// The creative-tool pipeline example of #10 (docs/agents/creative-tools.md), without any
// creative tool. Exit code 0 on success, 2 on a usage or read error.
//
//   npm run example:marker -- [--out generated/scribbles.jpg] [--seed 7] [--width 900]
//                             [--height 1200] [--dpi 150] [--strokes 500]
//     Draws a marker image (random scribbles) and writes <out> and <name>.provenance.json.
//
//   npm run example:project -- <dataset> [--model public/models/cube.glb] [--scale 60]
//                              [--out <dataset>.zip]
//     Packs the NFT dataset (<dataset>.iset / .fset / .fset3), a glTF model and a graph that
//     shows the model on the marker into a project file for the studio's Import….
//
// Between the two, generate the dataset with the NFT generator and check it with
// `npm run trackability`. The logic lives in tests/helpers/example-pipeline.ts, loaded
// through tsx. Generated files are not committed (generated/ is ignored).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

function fail(message) {
  console.error(`example-pipeline: ${message}`);
  process.exit(2);
}

const USAGE = 'usage: example-pipeline marker [--out <file.jpg>] [--seed n] … | project <dataset> [--model <file.glb>] [--out <file.zip>]';
const OPTIONS = {
  marker: { out: 'string', seed: 'string', width: 'string', height: 'string', dpi: 'string', strokes: 'string' },
  project: { out: 'string', model: 'string', scale: 'string' },
};

const [command, ...rest] = process.argv.slice(2);
if (!OPTIONS[command]) fail(USAGE);
let args;
try {
  args = parseArgs({
    args: rest,
    allowPositionals: true,
    options: Object.fromEntries(Object.entries(OPTIONS[command]).map(([k, type]) => [k, { type }])),
  });
} catch (err) {
  fail(err.message);
}

function integer(flag, fallback, min = 1) {
  const raw = args.values[flag];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) fail(`--${flag} must be an integer >= ${min}`);
  return value;
}

function write(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`wrote ${file}`);
}

const pipeline = await tsImport('../tests/helpers/example-pipeline.ts', import.meta.url);

if (command === 'marker') {
  if (args.positionals.length) fail(USAGE);
  const d = pipeline.DEFAULT_MARKER;
  const options = {
    seed: integer('seed', d.seed, 0),
    width: integer('width', d.width),
    height: integer('height', d.height),
    dpi: integer('dpi', d.dpi),
    strokes: integer('strokes', d.strokes, 0),
  };
  const out = args.values.out ?? 'generated/scribbles.jpg';
  write(out, pipeline.scribbleMarker(options));
  const provenance = join(dirname(out), `${basename(out, extname(out))}.provenance.json`);
  write(provenance, `${JSON.stringify(pipeline.markerProvenance(options), null, 2)}\n`);
} else {
  if (args.positionals.length !== 1) fail(USAGE);
  const dataset = args.positionals[0].replace(/\.(iset|fset3?)$/i, '');
  const modelPath = args.values.model ?? 'public/models/cube.glb';
  let scale = 60;
  if (args.values.scale !== undefined) {
    scale = Number(args.values.scale);
    if (!Number.isFinite(scale) || scale <= 0) fail('--scale must be a number > 0');
  }
  const read = (file) => {
    try {
      return new Uint8Array(readFileSync(file));
    } catch (err) {
      fail(err.message);
    }
  };
  const { graph, assets } = pipeline.buildExampleProject({
    dataset: {
      name: basename(dataset),
      iset: read(`${dataset}.iset`),
      fset: read(`${dataset}.fset`),
      fset3: read(`${dataset}.fset3`),
    },
    model: { name: basename(modelPath), bytes: read(modelPath) },
    scale,
  });
  const { packProject } = await tsImport('../src/export/project.ts', import.meta.url);
  write(args.values.out ?? `${dataset}.zip`, await packProject(graph, assets));
}
