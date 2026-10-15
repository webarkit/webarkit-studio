/**
 * Test frames without a browser: decode the fixture photo, scale it to the
 * processing size, or make a blank frame (marker out of view).
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const FIXTURE_PHOTO = 'tests/fixtures/pinball-demo.jpg';

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
 * Separable bicubic downscale (Keys kernel, a = -0.5, widened by the scale
 * factor like ffmpeg's swscale). Sharper than resize(): keeps the fine detail
 * KPM feature matching needs when the frame goes through a video codec path.
 */
export function resizeBicubic(src: RgbaFrame, width: number, height: number): RgbaFrame {
  const kernel = (x: number) => {
    const a = -0.5;
    x = Math.abs(x);
    if (x <= 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
    if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
    return 0;
  };
  /** Weights per output index along one axis: [start, weights[]]. */
  const plan = (inSize: number, outSize: number) => {
    const scale = inSize / outSize;
    const support = 2 * Math.max(1, scale);
    return Array.from({ length: outSize }, (_, o) => {
      const center = (o + 0.5) * scale - 0.5;
      const start = Math.floor(center - support) + 1;
      const end = Math.floor(center + support);
      const weights: number[] = [];
      let sum = 0;
      for (let i = start; i <= end; i++) {
        const w = kernel((i - center) / Math.max(1, scale));
        weights.push(w);
        sum += w;
      }
      return { start, weights: weights.map((w) => w / sum) };
    });
  };
  const clamp = (v: number, max: number) => (v < 0 ? 0 : v > max ? max : v);
  const px = plan(src.width, width);
  const py = plan(src.height, height);
  // Horizontal pass into a float buffer (src.height × width), then vertical.
  const tmp = new Float32Array(src.height * width * 3);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < width; x++) {
      const { start, weights } = px[x];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = (y * src.width + clamp(start + k, src.width - 1)) * 4;
        r += src.data[i] * weights[k];
        g += src.data[i + 1] * weights[k];
        b += src.data[i + 2] * weights[k];
      }
      const o = (y * width + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { start, weights } = py[y];
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = (clamp(start + k, src.height - 1) * width + x) * 3;
        r += tmp[i] * weights[k];
        g += tmp[i + 1] * weights[k];
        b += tmp[i + 2] * weights[k];
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}
