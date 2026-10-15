/**
 * ArtkSession.process() with the Node build of @webarkit/jsartoolkit-nft on a
 * 320×240 frame (the processing size the controller node uses). Node WASM, no
 * SIMD build: compare runs with each other, not with a phone.
 * Needs `npm run assets`.
 */
import { Bench } from 'tinybench';
import { ArtkSession } from '../../src/runtime/trackers/artk-session';
import { CAMERA, KUVA, nodeControllerFactory, PINBALL } from '../helpers/artk-node';
import { blank, FIXTURE_PHOTO, loadJpeg, resize } from '../helpers/frames';

const W = 320;
const H = 240;

async function session(datasets: string[], detectionInterval: number) {
  return ArtkSession.create(nodeControllerFactory, {
    width: W,
    height: H,
    cameraUrl: CAMERA,
    datasetUrls: datasets,
    filter: null,
    settings: { continuousDetection: true, detectionInterval, logLevel: 3, near: 10, far: 10000 },
  });
}

export async function trackerBench(): Promise<Bench> {
  const photo = resize(loadJpeg(FIXTURE_PHOTO), W, H);
  const empty = blank(W, H);
  const bench = new Bench({ name: `ArtkSession.process() — ${W}×${H}, Node build`, time: 1500, warmupIterations: 10 });

  const one = await session([PINBALL], 300);
  const two = await session([PINBALL, KUVA], 300);
  const search = await session([PINBALL, KUVA], 0);
  for (let i = 0; i < 5; i++) one.process(photo), two.process(photo);

  bench
    .add('1 marker, tracked (AR2)', () => void one.process(photo))
    .add('2 markers, tracked (AR2)', () => void two.process(photo))
    .add('2 datasets, nothing visible (KPM every frame)', () => void search.process(empty));
  return bench;
}
