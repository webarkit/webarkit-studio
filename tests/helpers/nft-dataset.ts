/**
 * Writes synthetic NFT feature files in the binary layout of the NFT generator
 * (WebARKitLib `kpmSaveRefDataSet` for .fset3, `ar2SaveFeatureSet` for .fset),
 * so the trackability tests do not need generated datasets.
 */

/** One FREAK point of the .fset3: position in pixels of reference image `image`. */
export interface Fset3PointSpec {
  x: number;
  y: number;
  image?: number;
  /** 96-byte FREAK descriptor; defaults to one derived from the point index. */
  descriptor?: Uint8Array;
}

export interface Fset3Spec {
  /** Reference images (scales), largest first. */
  images: Array<{ width: number; height: number }>;
  points: Fset3PointSpec[];
  /** Millimetres per pixel of image 0 (coord3D = coord2D × mmPerPx × scale). */
  mmPerPx?: number;
}

/** A descriptor that differs from every other index's in many bits. */
export function descriptorFor(seed: number): Uint8Array {
  const d = new Uint8Array(96);
  let s = Math.imul(seed + 1, 2654435761) >>> 0;
  for (let i = 0; i < 96; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    d[i] = s >>> 24;
  }
  return d;
}

export function writeFset3({ images, points, mmPerPx = 0.25 }: Fset3Spec): Uint8Array {
  const bytes = new Uint8Array(4 + points.length * 132 + 4 + 8 + images.length * 12);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setInt32(o, points.length, true);
  o += 4;
  points.forEach((p, i) => {
    const image = p.image ?? 0;
    const scale = images[0].width / images[image].width;
    view.setFloat32(o, p.x, true);
    view.setFloat32(o + 4, p.y, true);
    view.setFloat32(o + 8, p.x * scale * mmPerPx, true);
    view.setFloat32(o + 12, (images[image].height - p.y) * scale * mmPerPx, true);
    bytes.set(p.descriptor ?? descriptorFor(i), o + 16);
    // angle, scale and maxima of the FREAK feature are not read.
    view.setInt32(o + 124, 0, true);
    view.setInt32(o + 128, image, true);
    o += 132;
  });
  view.setInt32(o, 1, true);
  view.setInt32(o + 4, 0, true);
  view.setInt32(o + 8, images.length, true);
  o += 12;
  images.forEach((img, i) => {
    view.setInt32(o, img.width, true);
    view.setInt32(o + 4, img.height, true);
    view.setInt32(o + 8, i, true);
    o += 12;
  });
  return bytes;
}

/** One scale of the .fset: integer pixel positions in that scale's image. */
export interface FsetScaleSpec {
  points: Array<{ x: number; y: number }>;
  maxdpi?: number;
  mindpi?: number;
}

export function writeFset(scales: FsetScaleSpec[]): Uint8Array {
  const size = 4 + scales.reduce((n, s) => n + 16 + s.points.length * 20, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setInt32(o, scales.length, true);
  o += 4;
  scales.forEach((s, i) => {
    view.setInt32(o, i, true);
    view.setFloat32(o + 4, s.maxdpi ?? 100, true);
    view.setFloat32(o + 8, s.mindpi ?? 50, true);
    view.setInt32(o + 12, s.points.length, true);
    o += 16;
    for (const p of s.points) {
      view.setInt32(o, p.x, true);
      view.setInt32(o + 4, p.y, true);
      // mx, my and maxSim are not read.
      o += 20;
    }
  });
  return bytes;
}

/** `n` points on a regular grid covering a `width` × `height` image. */
export function gridPoints(n: number, width: number, height: number): Array<{ x: number; y: number }> {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => ({
    x: Math.floor(((i % cols) + 0.5) * (width / cols)),
    y: Math.floor((Math.floor(i / cols) + 0.5) * (height / rows)),
  }));
}
