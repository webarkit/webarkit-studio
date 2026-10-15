// Downloads the demo assets from the jsartoolkitNFT repository:
//  - public/data: camera calibration + pinball and kuva NFT datasets (demos)
//  - tests/fixtures: a photo of the printed pinball marker (tests, fake camera)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/webarkit/jsartoolkitNFT/master/examples';
const FILES = [
  ['Data/camera_para.dat', 'public/data/camera_para.dat'],
  ...['pinball', 'kuva'].flatMap((m) =>
    ['iset', 'fset', 'fset3'].map((ext) => [`DataNFT/${m}.${ext}`, `public/data/DataNFT/${m}.${ext}`]),
  ),
  ['node/pinball-demo.jpg', 'tests/fixtures/pinball-demo.jpg'],
];

const force = process.argv.includes('--force');
for (const [src, out] of FILES) {
  if (!force && existsSync(out)) {
    console.log(`= ${out}`);
    continue;
  }
  const res = await fetch(`${BASE}/${src}`);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${out}`);
}
console.log('Track the printed "pinball" marker used by the jsartoolkitNFT examples.');
