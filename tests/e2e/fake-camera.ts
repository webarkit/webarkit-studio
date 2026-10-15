/**
 * Writes a Y4M video for Chromium's fake camera
 * (--use-file-for-fake-video-capture), from the test photo, in pure JS: no
 * ffmpeg needed. Chromium loops the file, so the marker cycles:
 * `markerSeconds` visible, then `blankSeconds` of grey (marker lost).
 */
import { mkdirSync, openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { blank, FIXTURE_PHOTO, loadJpeg, resizeBicubic, type RgbaFrame } from '../helpers/frames';

/**
 * RGBA → planar YUV 4:2:0, BT.601 *limited* range (Y 16–235, UV 16–240): Chromium
 * decodes Y4M as limited range, so full-range values would be clipped.
 */
function toI420(frame: RgbaFrame): Uint8Array {
  const { width: w, height: h, data } = frame;
  const out = new Uint8Array(w * h * 1.5);
  const uOff = w * h;
  const vOff = uOff + (w / 2) * (h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[y * w + x] = 16 + (219 / 255) * (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y + dy) * w + (x + dx)) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const c = (y / 2) * (w / 2) + x / 2;
      out[uOff + c] = 128 + (224 / 255) * (-0.168736 * r - 0.331264 * g + 0.5 * b);
      out[vOff + c] = 128 + (224 / 255) * (0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  return out;
}

export interface FakeCameraOptions {
  path: string;
  width?: number;
  height?: number;
  fps?: number;
  markerSeconds?: number;
  blankSeconds?: number;
}

export function writeFakeCamera({ path, width = 640, height = 480, fps = 15, markerSeconds = 4, blankSeconds = 2 }: FakeCameraOptions): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const marker = toI420(resizeBicubic(loadJpeg(FIXTURE_PHOTO), width, height));
  const grey = toI420(blank(width, height));
  const fd = openSync(path, 'w');
  writeSync(fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg XYSCSS=420JPEG XCOLORRANGE=LIMITED\n`);
  const frameHeader = Buffer.from('FRAME\n');
  for (let i = 0; i < fps * markerSeconds; i++) writeSync(fd, frameHeader), writeSync(fd, marker);
  for (let i = 0; i < fps * blankSeconds; i++) writeSync(fd, frameHeader), writeSync(fd, grey);
  closeSync(fd);
}
