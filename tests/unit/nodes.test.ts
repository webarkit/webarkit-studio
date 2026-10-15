import { describe, expect, it } from 'vitest';
import { createPoseFilter } from '../../src/runtime/filters/pose-filter';
import { selectMarker } from '../../src/runtime/nodes/tracking';
import { formatValue } from '../../src/runtime/nodes/debug';
import { artkSettings } from '../../src/runtime/nodes/jsartoolkit-nft';
import type { RuntimeContext } from '../../src/runtime/types';
import type { TrackedMarkerValue } from '../../src/runtime/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translated = (x: number) => IDENTITY.map((v, i) => (i === 12 ? x : v));

describe('pose filters', () => {
  it('native filter has no JS implementation (the tracker handles it)', () => {
    expect(createPoseFilter({ kind: 'native', library: 'jsartoolkitNFT' })).toBeNull();
  });

  it('One Euro passes the warm-up frames through, then smooths jumps', () => {
    const f = createPoseFilter({ kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 2 })!;
    expect(f.filter(0, translated(0))[12]).toBe(0);
    expect(f.filter(16, translated(100))[12]).toBe(100); // still warm-up
    f.filter(32, translated(100));
    const smoothed = f.filter(48, translated(200))[12];
    expect(smoothed).toBeGreaterThan(100);
    expect(smoothed).toBeLessThan(200);
  });

  it('One Euro reset() restarts the warm-up', () => {
    const f = createPoseFilter({ kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 1 })!;
    f.filter(0, translated(0));
    f.filter(16, translated(0));
    f.reset();
    expect(f.filter(32, translated(500))[12]).toBe(500);
  });
});

const marker = (index: number, name: string, found = false): TrackedMarkerValue => ({
  index,
  name,
  found,
  pose: found ? IDENTITY : null,
  info: { id: index, name, width: 100, height: 100, dpi: 72, widthMM: 35.3, heightMM: 35.3 },
  onFound: { count: found ? 1 : 0, time: 0 },
  onLost: { count: 0, time: 0 },
});

describe('selectMarker', () => {
  const markers = [marker(0, 'pinball', true), marker(1, 'kuva'), marker(2, '7')];

  it('finds by name first, then by index', () => {
    expect(selectMarker(markers, 'kuva')?.index).toBe(1);
    expect(selectMarker(markers, ' 0 ')?.name).toBe('pinball');
    expect(selectMarker(markers, '7')?.index).toBe(2); // a marker named "7" wins over index 7
  });

  it('returns undefined for unknown names, out-of-range indexes and empty results', () => {
    expect(selectMarker(markers, 'missing')).toBeUndefined();
    expect(selectMarker(markers, '5')).toBeUndefined();
    expect(selectMarker([], '0')).toBeUndefined();
    expect(selectMarker(undefined, '0')).toBeUndefined();
  });
});

describe('Inspector formatValue', () => {
  it('formats scalars, matrices and events', () => {
    expect(formatValue(undefined)).toBe('— (no value)');
    expect(formatValue(1.23456)).toBe('1.235');
    expect(formatValue(IDENTITY).split('\n')).toHaveLength(4);
    expect(formatValue({ count: 0, time: 0 })).toBe('event: not fired yet');
    expect(formatValue({ count: 3, time: Date.now() })).toMatch(/^event fired 3×/);
  });

  it('shows one line per marker for a tracking result', () => {
    const text = formatValue([marker(0, 'pinball', true), marker(1, 'kuva')]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('pinball');
    expect(text).toContain('● tracked');
    expect(text).toContain('○ lost');
  });
});

describe('jsartoolkitNFT.settings', () => {
  it('emits near / far with the other settings, as a new object on every change', () => {
    const params = { continuousDetection: true, detectionInterval: 300, logLevel: '2', near: 10, far: 10000 };
    const node = artkSettings(params, {} as RuntimeContext);
    const first = (node.init!({}) as { settings: unknown }).settings;
    expect(first).toEqual({ continuousDetection: true, detectionInterval: 300, logLevel: 2, near: 10, far: 10000 });
    params.near = 50;
    const second = (node.onParamChange!('near', 50) as { settings: unknown }).settings;
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ near: 50, far: 10000 });
  });
});
