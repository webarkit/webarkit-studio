import { describe, expect, it } from 'vitest';
import { filterConfig, settingsPatch } from '../../src/runtime/trackers/nft-session';
import { selectMarker } from '../../src/runtime/nodes/tracking';
import { formatValue } from '../../src/runtime/nodes/debug';
import { artkSettings, letterbox } from '../../src/runtime/nodes/jsartoolkit-nft';
import type { RuntimeContext } from '../../src/runtime/types';
import type { TrackedMarkerValue } from '../../src/runtime/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('tracker facade mapping', () => {
  it('maps the filter slot: none without a filter node, native, One Euro with its params', () => {
    expect(filterConfig(null)).toBe('none');
    expect(filterConfig({ kind: 'native', library: 'jsartoolkitNFT' })).toBe('native');
    expect(filterConfig({ kind: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 5 })).toEqual({
      type: 'oneEuro', minCutOff: 0.0001, beta: 0.01, warmUp: 5,
    });
  });

  it('maps Controller Settings onto a configure() patch', () => {
    const base = { continuousDetection: true, detectionInterval: 300, logLevel: 2, near: 10, far: 10000 };
    expect(settingsPatch(base)).toEqual(base);
    expect(settingsPatch({ ...base, lostTimeout: 500, ar2: {} })).toEqual({ ...base, lostTimeout: 500 });
    expect(settingsPatch({ ...base, ar2: { trackingThresh: 3 } })).toEqual({ ...base, ar2: { trackingThresh: 3 } });
  });
});

describe('letterbox', () => {
  it('fits a 4:3 video exactly into 320 × 240', () => {
    expect(letterbox(640, 480)).toEqual({
      frameWidth: 320, frameHeight: 240, videoWidth: 640, videoHeight: 480, x: 0, y: 0, width: 320, height: 240, rotated: false,
    });
  });

  it('letterboxes other aspects into 4:3, with integer sizes for odd videos', () => {
    for (const [vw, vh] of [[1280, 720], [641, 359], [480, 640], [1001, 333]]) {
      const g = letterbox(vw, vh);
      for (const v of [g.frameWidth, g.frameHeight, g.width, g.height]) expect(Number.isInteger(v)).toBe(true);
      expect(g.width).toBeLessThanOrEqual(g.frameWidth);
      expect(g.height).toBeLessThanOrEqual(g.frameHeight);
      expect(Math.max(g.frameWidth, (g.frameHeight / 3) * 4)).toBeLessThanOrEqual(321);
      expect(g.x).toBe((g.frameWidth - g.width) / 2);
      expect(g.y).toBe((g.frameHeight - g.height) / 2);
    }
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
    expect(first).toEqual({ continuousDetection: true, detectionInterval: 300, logLevel: 2, near: 10, far: 10000, ar2: {} });
    params.near = 50;
    const second = (node.onParamChange!('near', 50) as { settings: unknown }).settings;
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ near: 50, far: 10000 });
  });
});
