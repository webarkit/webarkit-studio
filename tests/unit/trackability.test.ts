import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACKABILITY,
  checkTrackability,
  formatTrackability,
  parseFset,
  parseFset3,
} from '../../plugins/jsartoolkit-nft/trackability';
import { descriptorFor, gridPoints, writeFset, writeFset3 } from '../helpers/nft-dataset';

const IMAGES = [
  { width: 400, height: 400 },
  { width: 200, height: 200 },
];

/** A dataset that passes every check: points everywhere, all descriptors distinct. */
function goodDataset() {
  return {
    fset3: writeFset3({ images: IMAGES, points: gridPoints(400, 400, 400), dpi: 127 }),
    fset: writeFset([{ points: gridPoints(100, 400, 400) }, { points: gridPoints(30, 200, 200) }]),
  };
}

const status = (report: ReturnType<typeof checkTrackability>, id: string) => report.checks.find((c) => c.id === id)?.status;

describe('NFT feature files', () => {
  it('reads the FREAK points and reference images of a .fset3', () => {
    const set = parseFset3(
      writeFset3({ images: IMAGES, points: [{ x: 10, y: 20 }, { x: 5, y: 6, image: 1 }], dpi: 127 }),
    );
    expect(set.images).toEqual([
      { width: 400, height: 400 },
      { width: 200, height: 200 },
    ]);
    expect(set.points).toHaveLength(2);
    expect(set.points[0]).toMatchObject({ x: 10, y: 20, image: 0 });
    expect(set.points[0].mmX).toBeCloseTo(2.1);
    expect(set.points[1]).toMatchObject({ x: 5, y: 6, image: 1 });
    expect(set.points[1].mmX).toBeCloseTo(2.2);
    expect(set.points[0].descriptor).toEqual(descriptorFor(0));
  });

  it('reads the points of every scale of a .fset', () => {
    const set = parseFset(writeFset([{ points: [{ x: 1, y: 2 }], maxdpi: 120, mindpi: 60 }, { points: [] }]));
    expect(set.scales).toHaveLength(2);
    expect(set.scales[0]).toEqual({ scale: 0, points: [{ x: 1, y: 2 }], maxdpi: 120, mindpi: 60 });
    expect(set.scales[1].points).toEqual([]);
  });

  it('rejects truncated files', () => {
    const fset3 = writeFset3({ images: IMAGES, points: gridPoints(4, 400, 400) });
    expect(() => parseFset3(fset3.subarray(0, fset3.byteLength - 1))).toThrow(/\.fset3/);
    const fset = writeFset([{ points: gridPoints(4, 400, 400) }]);
    expect(() => parseFset(fset.subarray(0, 30))).toThrow(/\.fset\b/);
  });

  it('rejects negative counts', () => {
    const fset = writeFset([{ points: [] }]);
    new DataView(fset.buffer).setInt32(0, -1, true);
    expect(() => parseFset(fset)).toThrow(/negative count/);
  });

  it('rejects points on an unknown reference image', () => {
    const fset3 = writeFset3({ images: IMAGES, points: [{ x: 1, y: 1 }] });
    new DataView(fset3.buffer).setInt32(4 + 128, 5, true);
    expect(() => parseFset3(fset3)).toThrow(/unknown reference image 5/);
  });

  it('rejects reference images that are missing, repeated or empty', () => {
    const at = (bytes: Uint8Array, offset: number, value: number) => {
      new DataView(bytes.buffer).setInt32(offset, value, true);
      return bytes;
    };
    // The image table starts after the count, the points, pageNum, pageNo and imageNum.
    const table = 4 + 12;
    // Image numbers 1, 1.
    expect(() => parseFset3(at(writeFset3({ images: IMAGES, points: [] }), table + 8, 1))).toThrow(/reference image 1 twice/);
    // An empty image table.
    expect(() => parseFset3(at(writeFset3({ images: IMAGES, points: [] }), table - 4, 0).subarray(0, table))).toThrow(
      /no reference image 0/,
    );
    expect(() => parseFset3(at(writeFset3({ images: IMAGES, points: [] }), table, 0))).toThrow(/size 0 × 400/);
    expect(() => parseFset3(at(writeFset3({ images: IMAGES, points: [] }), table + 8, 7))).toThrow(/image number 7/);
  });

  it('rejects trailing bytes', () => {
    const fset = writeFset([{ points: [] }]);
    const longer = new Uint8Array(fset.byteLength + 4);
    longer.set(fset);
    expect(() => parseFset(longer)).toThrow(/\.fset\b/);
  });
});

describe('trackability check', () => {
  it('rates a texture-rich, evenly covered dataset as good', () => {
    const report = checkTrackability(goodDataset());
    expect(report.verdict).toBe('good');
    expect(report.checks.map((c) => c.id)).toEqual([
      'detection.points',
      'detection.coverage',
      'detection.repetition',
      'tracking.points',
      'tracking.coverage',
    ]);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    // The size the jsartoolkitNFT facade reports: pixels / integer dpi × 25.4.
    expect(report.marker).toEqual({ widthPx: 400, heightPx: 400, dpi: 127, widthMm: 80, heightMm: 80 });
  });

  it('rates a dataset without feature points as poor', () => {
    const report = checkTrackability({
      fset3: writeFset3({ images: IMAGES, points: [] }),
      fset: writeFset([{ points: [] }]),
    });
    expect(report.verdict).toBe('poor');
    expect(status(report, 'detection.points')).toBe('fail');
    expect(status(report, 'tracking.points')).toBe('fail');
    expect(report.marker.widthMm).toBeNull();
    expect(report.marker.dpi).toBeNull();
  });

  it('flags points packed into one part of the marker', () => {
    // Detection points in the left quarter of the image, tracking points in the left eighth.
    const points = gridPoints(400, 100, 400);
    const report = checkTrackability({
      fset3: writeFset3({ images: IMAGES, points }),
      fset: writeFset([{ points: gridPoints(100, 50, 400) }]),
    });
    expect(status(report, 'detection.coverage')).toBe('fail');
    expect(status(report, 'tracking.coverage')).toBe('fail');
    expect(report.checks.find((c) => c.id === 'detection.coverage')?.value).toBeCloseTo(0.25);
  });

  it('flags a repeated pattern: the same descriptor at distant places', () => {
    // Four tiles of the same 100 descriptors.
    const points = gridPoints(400, 400, 400).map((p, i) => ({ ...p, descriptor: descriptorFor(i % 100) }));
    const report = checkTrackability({ fset3: writeFset3({ images: IMAGES, points }), fset: goodDataset().fset });
    expect(status(report, 'detection.repetition')).toBe('fail');
    expect(report.checks.find((c) => c.id === 'detection.repetition')?.value).toBe(1);
    expect(report.verdict).toBe('poor');
  });

  it('does not count similar descriptors of neighbouring points as repetition', () => {
    // Pairs of points 2 px apart share a descriptor; pairs are far apart from each other.
    const points = gridPoints(200, 400, 400).flatMap((p, i) => [
      { ...p, descriptor: descriptorFor(i) },
      { x: p.x + 2, y: p.y, descriptor: descriptorFor(i) },
    ]);
    const report = checkTrackability({ fset3: writeFset3({ images: IMAGES, points }), fset: goodDataset().fset });
    expect(report.checks.find((c) => c.id === 'detection.repetition')?.value).toBe(0);
  });

  it('only counts detection points of the largest reference image', () => {
    const points = gridPoints(400, 200, 200).map((p) => ({ ...p, image: 1 }));
    const report = checkTrackability({ fset3: writeFset3({ images: IMAGES, points }), fset: goodDataset().fset });
    expect(report.checks.find((c) => c.id === 'detection.points')?.value).toBe(0);
    // Coverage is measured on every scale, in normalised coordinates.
    expect(status(report, 'detection.coverage')).toBe('pass');
  });

  it('warns between the warning and failure thresholds', () => {
    const fset3 = writeFset3({ images: IMAGES, points: gridPoints(150, 400, 400) });
    const report = checkTrackability({ fset3, fset: goodDataset().fset });
    expect(status(report, 'detection.points')).toBe('warn');
    expect(report.verdict).toBe('fair');
  });

  it('takes custom thresholds', () => {
    const report = checkTrackability(goodDataset(), {
      ...DEFAULT_TRACKABILITY,
      detectionPoints: { warn: 1000, fail: 500 },
    });
    expect(status(report, 'detection.points')).toBe('fail');
  });

  it('rejects invalid thresholds instead of passing every check', () => {
    expect(() => checkTrackability(goodDataset(), { ...DEFAULT_TRACKABILITY, grid: 0 })).toThrow(/grid/);
    expect(() => checkTrackability(goodDataset(), { ...DEFAULT_TRACKABILITY, grid: 2.5 })).toThrow(/grid/);
    expect(() =>
      checkTrackability(goodDataset(), { ...DEFAULT_TRACKABILITY, repetition: { warn: Number.NaN, fail: 0.7 } }),
    ).toThrow(/repetition\.warn/);
    expect(() => checkTrackability(goodDataset(), { ...DEFAULT_TRACKABILITY, repeatBits: -1 })).toThrow(/repeatBits/);
  });

  it('ignores points with non-finite coordinates', () => {
    const points = [...gridPoints(400, 400, 400), { x: Number.NaN, y: 3 }, { x: Number.POSITIVE_INFINITY, y: 3 }];
    const report = checkTrackability({ fset3: writeFset3({ images: IMAGES, points }), fset: goodDataset().fset });
    expect(report.checks.find((c) => c.id === 'detection.points')?.value).toBe(400);
    expect(report.checks.find((c) => c.id === 'detection.coverage')?.value).toBe(1);
    expect(report.marker.widthMm).toBe(101.6);
  });

  it('rates the tracking points of the .fset scale 0, wherever it is stored', () => {
    const fset = writeFset([{ points: [] }, { points: gridPoints(100, 400, 400) }]);
    // Swap the scale indices: the second entry is scale 0.
    const view = new DataView(fset.buffer);
    view.setInt32(4, 1, true);
    view.setInt32(4 + 16, 0, true);
    const report = checkTrackability({ fset3: goodDataset().fset3, fset });
    expect(report.checks.find((c) => c.id === 'tracking.points')?.value).toBe(100);
  });

  it('formats a report with the verdict, every check and a hint for failures', () => {
    const text = formatTrackability(
      checkTrackability({ fset3: writeFset3({ images: IMAGES, points: [] }), fset: writeFset([{ points: [] }]) }),
    );
    expect(text).toMatch(/poor/i);
    for (const label of ['Detection points', 'Detection coverage', 'Repetition', 'Tracking points', 'Tracking coverage']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/texture/i);
  });
});
