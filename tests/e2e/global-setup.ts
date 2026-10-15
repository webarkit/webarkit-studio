import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FAKE_CAMERA } from './paths';
import { writeFakeCamera } from './fake-camera';

export default function globalSetup() {
  // Datasets for the demos and the photo for the fake camera.
  if (!existsSync('public/data/DataNFT/kuva.iset') || !existsSync('tests/fixtures/pinball-demo.jpg')) {
    execFileSync(process.execPath, ['scripts/fetch-assets.mjs'], { stdio: 'inherit' });
  }
  writeFakeCamera({ path: FAKE_CAMERA });
}
