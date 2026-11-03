/**
 * Frames without a browser, for tracking_run (#8) and the Node tests: decode a
 * JPEG, scale it, place it in a tracker's processing frame, or make a blank
 * frame (marker out of view).
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function loadJpeg(path: string): RgbaFrame {
  const img = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
}

/** Box-filter downscale (each output pixel averages the source pixels it covers). */
export function resize(src: RgbaFrame, width: number, height: number): RgbaFrame {
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

export function blank(width: number, height: number, gray = 128): RgbaFrame {
  const data = new Uint8ClampedArray(width * height * 4).fill(gray);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

/**
 * The image placed in a processing frame as the controller draws the video
 * (letterbox): scaled into `width` × `height` at `x`, `y` of a black
 * `frameWidth` × `frameHeight` frame.
 */
export function letterboxFrame(
  image: RgbaFrame,
  g: { frameWidth: number; frameHeight: number; x: number; y: number; width: number; height: number },
): RgbaFrame {
  const scaled = resize(image, g.width, g.height);
  const data = new Uint8ClampedArray(g.frameWidth * g.frameHeight * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let y = 0; y < g.height; y++) {
    const row = scaled.data.subarray(y * g.width * 4, (y + 1) * g.width * 4);
    data.set(row, ((g.y + y) * g.frameWidth + g.x) * 4);
  }
  return { data, width: g.frameWidth, height: g.frameHeight };
}
