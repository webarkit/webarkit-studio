/**
 * Trackability check for NFT datasets (#10): reads the feature points the NFT
 * generator wrote (.fset3 for detection, .fset for tracking) and rates how
 * well the marker will track. NFT needs texture-rich, non-repetitive images
 * with features spread over the whole marker; generated images often are not.
 *
 * Pure functions over bytes, so the CLI (scripts/trackability.mjs), the MCP
 * server (#8) and the editor can share them.
 *
 * File layouts (little-endian), from WebARKitLib:
 * - .fset3 (`kpmSaveRefDataSet`, FREAK build): int num; num × { float x, y
 *   (pixels of the reference image); float X, Y (mm, (x + 0.5) / dpi × 25.4); uchar v[96]; float angle,
 *   scale; int maxima; int pageNo, refImageNo }; int pageNum; pageNum × { int
 *   pageNo, imageNum; imageNum × { int width, height, imageNo } }.
 * - .fset (`ar2SaveFeatureSet`): int num; num × { int scale; float maxdpi,
 *   mindpi; int num; num × { int x, y; float mx, my, maxSim } }.
 *
 * Pixel positions in the .fset3 are those of `KpmProcFullSize`, the mode
 * webarkit/Nft-Marker-Creator-App writes (other modes store downsampled
 * positions, and the coverage and size here would be wrong).
 */

const FREAK_BYTES = 96;
const FSET3_POINT_BYTES = 8 + 8 + FREAK_BYTES + 12 + 8;
const FSET_POINT_BYTES = 20;

export interface Fset3Point {
  /** Position in pixels of reference image `image`. */
  x: number;
  y: number;
  /** Position on the marker, in millimetres. */
  mmX: number;
  mmY: number;
  image: number;
  descriptor: Uint8Array;
}

export interface Fset3 {
  points: Fset3Point[];
  /** Reference images (one per scale) indexed by image number; image 0 is the largest. */
  images: Array<{ width: number; height: number }>;
}

export interface Fset {
  /** `scale` is the .iset scale the points belong to; 0 is the largest image. */
  scales: Array<{ scale: number; points: Array<{ x: number; y: number }>; maxdpi: number; mindpi: number }>;
}

class Reader {
  private readonly view: DataView;
  offset = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly kind: string,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) throw new Error(`${this.kind}: truncated file at byte ${this.offset}`);
  }
  count(): number {
    const n = this.int();
    if (n < 0) throw new Error(`${this.kind}: negative count at byte ${this.offset - 4}`);
    return n;
  }
  int(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  float(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  slice(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  end(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error(`${this.kind}: ${this.bytes.byteLength - this.offset} unexpected bytes after the data`);
    }
  }
}

export function parseFset3(bytes: Uint8Array): Fset3 {
  const r = new Reader(bytes, '.fset3');
  const num = r.count();
  r.need(num * FSET3_POINT_BYTES);
  const points: Fset3Point[] = [];
  for (let i = 0; i < num; i++) {
    const x = r.float();
    const y = r.float();
    const mmX = r.float();
    const mmY = r.float();
    const descriptor = r.slice(FREAK_BYTES);
    r.offset += 12; // angle, scale, maxima
    r.int(); // pageNo: the generator writes one page (number 1) per dataset
    points.push({ x, y, mmX, mmY, image: r.int(), descriptor });
  }
  const images: Fset3['images'] = [];
  const pageNum = r.count();
  for (let p = 0; p < pageNum; p++) {
    r.int(); // pageNo
    const imageNum = r.count();
    for (let i = 0; i < imageNum; i++) {
      const width = r.int();
      const height = r.int();
      const imageNo = r.int();
      if (imageNo < 0 || imageNo >= imageNum) throw new Error(`.fset3: image number ${imageNo} out of range`);
      if (width <= 0 || height <= 0) throw new Error(`.fset3: reference image ${imageNo} has size ${width} × ${height}`);
      if (images[imageNo]) throw new Error(`.fset3: reference image ${imageNo} twice`);
      images[imageNo] = { width, height };
    }
  }
  r.end();
  if (!images[0]) throw new Error('.fset3: no reference image 0');
  for (const p of points) {
    if (!images[p.image]) throw new Error(`.fset3: point on unknown reference image ${p.image}`);
  }
  return { points, images };
}

export function parseFset(bytes: Uint8Array): Fset {
  const r = new Reader(bytes, '.fset');
  const scales: Fset['scales'] = [];
  const num = r.count();
  for (let i = 0; i < num; i++) {
    const scale = r.int();
    const maxdpi = r.float();
    const mindpi = r.float();
    const n = r.count();
    r.need(n * FSET_POINT_BYTES);
    const points: Array<{ x: number; y: number }> = [];
    for (let j = 0; j < n; j++) {
      points.push({ x: r.int(), y: r.int() });
      r.offset += 12; // mx, my, maxSim
    }
    scales.push({ scale, points, maxdpi, mindpi });
  }
  r.end();
  return { scales };
}

/** A metric fails below `fail` and warns below `warn` (above them for repetition). */
export interface Limits {
  warn: number;
  fail: number;
}

export interface TrackabilityThresholds {
  /** FREAK points on the largest reference image (minimum). */
  detectionPoints: Limits;
  /** Share of grid cells holding a FREAK point, over every scale (minimum). */
  detectionCoverage: Limits;
  /** Share of FREAK points whose descriptor reappears elsewhere on the marker (maximum). */
  repetition: Limits;
  /** Tracking points at the largest scale (minimum). */
  trackingPoints: Limits;
  /** Share of grid cells holding a tracking point at the largest scale (minimum). */
  trackingCoverage: Limits;
  /** Grid size for the coverage checks (grid × grid cells). */
  grid: number;
  /** Two FREAK descriptors within this Hamming distance (of 768 bits) count as the same. */
  repeatBits: number;
  /** Only descriptors at least this far apart (share of the image width) count as a repetition. */
  repeatDistance: number;
}

/**
 * Calibrated on the pinball and kuva datasets (good) and on generated
 * checkerboard, gradient, random-disc and half-blank images: the measured
 * values are in docs/agents/creative-tools.md ("Calibration").
 */
export const DEFAULT_TRACKABILITY: TrackabilityThresholds = {
  detectionPoints: { warn: 250, fail: 100 },
  detectionCoverage: { warn: 0.75, fail: 0.5 },
  repetition: { warn: 0.4, fail: 0.7 },
  trackingPoints: { warn: 50, fail: 20 },
  trackingCoverage: { warn: 0.5, fail: 0.25 },
  grid: 8,
  repeatBits: 64,
  repeatDistance: 0.1,
};

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type CheckId =
  | 'detection.points'
  | 'detection.coverage'
  | 'detection.repetition'
  | 'tracking.points'
  | 'tracking.coverage';

export interface TrackabilityCheck {
  id: CheckId;
  label: string;
  value: number;
  limits: Limits;
  /** `min`: the value must stay above the limits; `max`: below them. */
  direction: 'min' | 'max';
  status: CheckStatus;
  /** What to change in the image when the check does not pass. */
  hint: string;
}

export interface TrackabilityReport {
  verdict: 'good' | 'fair' | 'poor';
  /**
   * Size of the largest reference image, in millimetres as the jsartoolkitNFT
   * facade reports it (pixels / integer dpi × 25.4); dpi and millimetres are
   * null without points to measure them.
   */
  marker: { widthPx: number; heightPx: number; dpi: number | null; widthMm: number | null; heightMm: number | null };
  checks: TrackabilityCheck[];
}

const LABELS: Record<CheckId, string> = {
  'detection.points': 'Detection points',
  'detection.coverage': 'Detection coverage',
  'detection.repetition': 'Repetition',
  'tracking.points': 'Tracking points',
  'tracking.coverage': 'Tracking coverage',
};

const HINTS: Record<CheckId, string> = {
  'detection.points': 'Too few corners to find the marker: add texture, contrast and fine detail.',
  'detection.coverage': 'Features sit in one part of the marker: add texture to the empty areas.',
  'detection.repetition': 'The same pattern repeats: break up tiles, stripes and grids with unique details.',
  'tracking.points': 'Too few points to follow the marker: add texture and avoid flat colour and soft gradients.',
  'tracking.coverage': 'Tracking points sit in one part of the marker: add texture to the empty areas.',
};

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, i) => {
  let c = 0;
  for (let v = i; v; v >>= 1) c += v & 1;
  return c;
});

function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

/** Share of grid cells holding at least one point, positions normalised to [0, 1). */
function coverage(points: Iterable<{ u: number; v: number }>, grid: number): number {
  const cells = new Set<number>();
  for (const { u, v } of points) {
    const cx = Math.min(grid - 1, Math.max(0, Math.floor(u * grid)));
    const cy = Math.min(grid - 1, Math.max(0, Math.floor(v * grid)));
    cells.add(cy * grid + cx);
  }
  return cells.size / (grid * grid);
}

/**
 * Share of the points with a near-identical descriptor at least `minDistance` pixels away.
 * Quadratic in the points of one image: about 75 ms for pinball's 636.
 */
function repetition(points: Fset3Point[], maxBits: number, minDistance: number): number {
  if (points.length === 0) return 0;
  const min2 = minDistance * minDistance;
  let repeated = 0;
  for (const a of points) {
    for (const b of points) {
      if (a === b || (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < min2) continue;
      if (hamming(a.descriptor, b.descriptor) <= maxBits) {
        repeated++;
        break;
      }
    }
  }
  return repeated / points.length;
}

function rate(value: number, limits: Limits, direction: 'min' | 'max'): CheckStatus {
  if (!Number.isFinite(value)) return 'fail';
  if (direction === 'min') return value < limits.fail ? 'fail' : value < limits.warn ? 'warn' : 'pass';
  return value > limits.fail ? 'fail' : value > limits.warn ? 'warn' : 'pass';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

const LIMIT_KEYS = ['detectionPoints', 'detectionCoverage', 'repetition', 'trackingPoints', 'trackingCoverage'] as const;

/** Throws on thresholds that would make a check meaningless (NaN compares false, so it would pass). */
export function validateThresholds(t: TrackabilityThresholds): void {
  const number = (name: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`trackability: ${name} must be a number >= 0`);
  };
  if (!Number.isInteger(t.grid) || t.grid < 1) throw new Error('trackability: grid must be an integer >= 1');
  number('repeatBits', t.repeatBits);
  number('repeatDistance', t.repeatDistance);
  for (const key of LIMIT_KEYS) {
    number(`${key}.warn`, t[key]?.warn);
    number(`${key}.fail`, t[key]?.fail);
  }
}

export function checkTrackability(
  dataset: { fset3: Uint8Array; fset: Uint8Array },
  thresholds: TrackabilityThresholds = DEFAULT_TRACKABILITY,
): TrackabilityReport {
  validateThresholds(thresholds);
  const fset3 = parseFset3(dataset.fset3);
  const fset = parseFset(dataset.fset);
  const t = thresholds;
  const base = fset3.images[0];
  // Points the generator could not place (non-finite) are not features.
  const points = fset3.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.mmX));
  const largest = points.filter((p) => p.image === 0);
  const tracking = fset.scales.find((s) => s.scale === 0)?.points ?? [];

  const values: Record<CheckId, number> = {
    'detection.points': largest.length,
    'detection.coverage': round(
      coverage(
        points.map((p) => ({ u: p.x / fset3.images[p.image].width, v: p.y / fset3.images[p.image].height })),
        t.grid,
      ),
      3,
    ),
    'detection.repetition': round(repetition(largest, t.repeatBits, t.repeatDistance * base.width), 3),
    'tracking.points': tracking.length,
    // The .fset's largest scale is the same image as the .fset3's (both come from the .iset's first scale).
    'tracking.coverage': round(coverage(tracking.map((p) => ({ u: p.x / base.width, v: p.y / base.height })), t.grid), 3),
  };
  const limits: Record<CheckId, [Limits, 'min' | 'max']> = {
    'detection.points': [t.detectionPoints, 'min'],
    'detection.coverage': [t.detectionCoverage, 'min'],
    'detection.repetition': [t.repetition, 'max'],
    'tracking.points': [t.trackingPoints, 'min'],
    'tracking.coverage': [t.trackingCoverage, 'min'],
  };
  const checks = (Object.keys(LABELS) as CheckId[]).map((id): TrackabilityCheck => {
    const [l, direction] = limits[id];
    return { id, label: LABELS[id], value: values[id], limits: l, direction, status: rate(values[id], l, direction), hint: HINTS[id] };
  });

  // The dataset does not store its dpi; recover it from the millimetre positions, truncated as the core does.
  const measured = median(largest.filter((p) => p.mmX > 0).map((p) => (25.4 * (p.x + 0.5)) / p.mmX));
  const dpi = measured === null ? null : Math.trunc(round(measured, 3));
  return {
    verdict: checks.some((c) => c.status === 'fail') ? 'poor' : checks.some((c) => c.status === 'warn') ? 'fair' : 'good',
    marker: {
      widthPx: base.width,
      heightPx: base.height,
      dpi,
      widthMm: dpi ? round((base.width / dpi) * 25.4, 1) : null,
      heightMm: dpi ? round((base.height / dpi) * 25.4, 1) : null,
    },
    checks,
  };
}

export function formatTrackability(report: TrackabilityReport): string {
  const { marker } = report;
  const mm = marker.widthMm === null ? '' : `, ${marker.widthMm} × ${marker.heightMm} mm at ${marker.dpi} dpi`;
  const lines = [`Trackability: ${report.verdict}`, `Marker: ${marker.widthPx} × ${marker.heightPx} px${mm}`];
  const width = Math.max(...report.checks.map((c) => c.label.length));
  for (const c of report.checks) {
    const op = c.direction === 'min' ? 'below' : 'above';
    lines.push(
      `  ${c.status.toUpperCase().padEnd(4)}  ${c.label.padEnd(width)}  ${String(c.value).padStart(6)}` +
        `  (warn ${op} ${c.limits.warn}, fail ${op} ${c.limits.fail})`,
    );
    if (c.status !== 'pass') lines.push(`        ${c.hint}`);
  }
  return lines.join('\n');
}
