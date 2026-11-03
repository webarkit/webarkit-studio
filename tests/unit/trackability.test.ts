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
    fset3: writeFset3({ images: IMAGES, points: gridPoints(400, 400, 400), mmPerPx: 0.5 }),
    fset: writeFset([{ points: gridPoints(100, 400, 400) }, { points: gridPoints(30, 200, 200) }]),
  };
}

const status = (report: ReturnType<typeof checkTrackability>, id: string) => report.checks.find((c) => c.id === id)?.status;

describe('NFT feature files', () => {
  it('reads the FREAK points and reference images of a .fset3', () => {
    const set = parseFset3(
      writeFset3({ images: IMAGES, points: [{ x: 10, y: 20 }, { x: 5, y: 6, image: 1 }], mmPerPx: 0.5 }),
    );
    expect(set.images).toEqual([
      { width: 400, height: 400 },
      { width: 200, height: 200 },
    ]);
    expect(set.points).toHaveLength(2);
    expect(set.points[0]).toMatchObject({ x: 10, y: 20, image: 0, mmX: 5 });
    expect(set.points[1]).toMatchObject({ x: 5, y: 6, image: 1, mmX: 5 });
    expect(set.points[0].descriptor).toEqual(descriptorFor(0));
  });

  it('reads the points of every scale of a .fset', () => {
    const set = parseFset(writeFset([{ points: [{ x: 1, y: 2 }], maxdpi: 120, mindpi: 60 }, { points: [] }]));
    expect(set.scales).toHaveLength(2);
    expect(set.scales[0]).toEqual({ points: [{ x: 1, y: 2 }], maxdpi: 120, mindpi: 60 });
    expect(set.scales[1].points).toEqual([]);
  });

  it('rejects truncated files', () => {
    const fset3 = writeFset3({ images: IMAGES, points: gridPoints(4, 400, 400) });
    expect(() => parseFset3(fset3.subarray(0, fset3.byteLength - 1))).toThrow(/\.fset3/);
    const fset = writeFset([{ points: gridPoints(4, 400, 400) }]);
    expect(() => parseFset(fset.subarray(0, 30))).toThrow(/\.fset\b/);
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
    expect(report.marker).toEqual({ widthPx: 400, heightPx: 400, widthMm: 200, heightMm: 200 });
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
