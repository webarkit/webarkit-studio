import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHT_POSITION,
  DEFAULT_LIGHT_TARGET,
  LIGHT_KINDS,
  MAX_SPOT_ANGLE,
  MIN_SPOT_ANGLE,
  POINT_SPOT_INTENSITY_SCALE,
  SHADOW_MAP_SIZES,
  castsShadows,
  engineIntensity,
  lightKind,
  lightSpec,
  normalizeLight,
  normalizeShadowCatcher,
  shadowCatcherSpec,
} from '../../src/core/light';

const PARAMS = {
  kind: 'spot',
  color: '#ffffff',
  intensity: 2,
  position: [10, 20, 300],
  target: [0, 0, 0],
  distance: 0,
  angle: 30,
  penumbra: 0.25,
  castShadow: true,
  shadowMapSize: '1024',
  shadowBias: -0.0005,
};

describe('lightKind (#134)', () => {
  it('knows five kinds, and gives directional for anything else', () => {
    expect(LIGHT_KINDS).toEqual(['directional', 'hemisphere', 'ambient', 'point', 'spot']);
    for (const kind of LIGHT_KINDS) expect(lightKind(kind)).toBe(kind);
    for (const kind of ['__proto__', 'constructor', 'area', 3, undefined]) expect(lightKind(kind)).toBe('directional');
  });
});

describe('normalizeLight', () => {
  it("fills what an older caller does not give: a saved graph's directional keeps its direction", () => {
    const s = normalizeLight({ kind: 'directional', color: '#ffffff', intensity: 1.5 });
    expect(s).toMatchObject({ position: DEFAULT_LIGHT_POSITION, target: DEFAULT_LIGHT_TARGET, distance: 0, castShadow: false, shadowMapSize: 1024, shadowBias: -0.0005 });
    expect(DEFAULT_LIGHT_POSITION).toEqual([200, -300, 1000]);
    expect(DEFAULT_LIGHT_TARGET).toEqual([0, 0, 0]);
  });

  it('clamps the spot angle, the penumbra, the distance and the bias, and keeps intensity at least 0', () => {
    const s = normalizeLight({ kind: 'spot', color: '#fff', intensity: -1, angle: 0, penumbra: 2, distance: -5, shadowBias: 1 });
    expect([s.angle, s.penumbra, s.distance, s.intensity, s.shadowBias]).toEqual([MIN_SPOT_ANGLE, 1, 0, 0, 0.01]);
    expect(normalizeLight({ kind: 'spot', color: '#fff', intensity: 1, angle: 120 }).angle).toBe(MAX_SPOT_ANGLE);
  });

  it.each([NaN, Infinity, 'x', null])('gives each number its default for %s', (bad) => {
    const s = normalizeLight({ kind: 'spot', color: '#fff', intensity: bad as never, angle: bad as never, penumbra: bad as never, distance: bad as never, shadowBias: bad as never });
    expect([s.intensity, s.angle, s.penumbra, s.distance, s.shadowBias]).toEqual([1, 30, 0, 0, -0.0005]);
  });

  it('keeps a position or target that is not three finite numbers at its default', () => {
    const s = normalizeLight({ kind: 'point', color: '#fff', intensity: 1, position: [1, NaN, 2] as never, target: 'up' as never });
    expect([s.position, s.target]).toEqual([DEFAULT_LIGHT_POSITION, DEFAULT_LIGHT_TARGET]);
  });

  it('reads the map size from its options only (strings from a select, numbers), else 1024', () => {
    expect(SHADOW_MAP_SIZES).toEqual([512, 1024, 2048]);
    for (const size of [512, '2048', 2048]) expect(normalizeLight({ kind: 'spot', color: '#fff', intensity: 1, shadowMapSize: size as never }).shadowMapSize).toBe(Number(size));
    for (const size of [256, '__proto__', 'toString', 1e6]) expect(normalizeLight({ kind: 'spot', color: '#fff', intensity: 1, shadowMapSize: size as never }).shadowMapSize).toBe(1024);
  });

  it('casts shadows from directional and spot lights only (the ruling: no point-light shadows)', () => {
    for (const kind of LIGHT_KINDS) {
      const s = normalizeLight({ kind, color: '#fff', intensity: 1, castShadow: true });
      expect(s.castShadow, kind).toBe(kind === 'directional' || kind === 'spot');
      expect(castsShadows(kind), kind).toBe(kind === 'directional' || kind === 'spot');
    }
  });

  it('is idempotent', () => {
    const s = lightSpec(PARAMS);
    expect(normalizeLight(s)).toEqual(s);
  });
});

describe('lightSpec: scene.light params', () => {
  it('reads every param', () => {
    expect(lightSpec(PARAMS)).toEqual({
      kind: 'spot',
      color: '#ffffff',
      intensity: 2,
      position: [10, 20, 300],
      target: [0, 0, 0],
      distance: 0,
      angle: 30,
      penumbra: 0.25,
      castShadow: true,
      shadowMapSize: 1024,
      shadowBias: -0.0005,
    });
  });

  it('takes the colour as #rrggbb, a malformed one as white', () => {
    expect(lightSpec({ ...PARAMS, color: '#ABC' }).color).toBe('#aabbcc');
    expect(lightSpec({ ...PARAMS, color: 'red' }).color).toBe('#ffffff');
  });
});

describe('engineIntensity: the intensity an engine is given', () => {
  it('is the param for directional, hemisphere and ambient lights', () => {
    for (const kind of ['directional', 'hemisphere', 'ambient'] as const) expect(engineIntensity(kind, 1.5)).toBe(1.5);
  });

  it('is candela at mm for point and spot lights: the param is candela at metres, times 10⁶', () => {
    expect(POINT_SPOT_INTENSITY_SCALE).toBe(1e6);
    expect(engineIntensity('point', 2)).toBe(2e6);
    expect(engineIntensity('spot', 0.5)).toBe(5e5);
  });
});

describe('the shadow catcher (#134)', () => {
  it('reads width, depth and opacity, clamped', () => {
    expect(shadowCatcherSpec({ width: 210, depth: 297, opacity: 0.5 })).toEqual({ width: 210, depth: 297, opacity: 0.5 });
    expect(normalizeShadowCatcher({ width: 0, depth: Infinity, opacity: 2 })).toEqual({ width: 0.001, depth: 300, opacity: 1 });
  });

  it("takes the marker's size in mm when its markerInfo is wired", () => {
    expect(shadowCatcherSpec({ width: 10, depth: 10, opacity: 0.4 }, { widthMM: 211.6, heightMM: 288.2 })).toEqual({ width: 211.6, depth: 288.2, opacity: 0.4 });
    // A marker info with no usable size: the params.
    expect(shadowCatcherSpec({ width: 10, depth: 20, opacity: 0.4 }, { widthMM: 0, heightMM: NaN })).toEqual({ width: 10, depth: 20, opacity: 0.4 });
  });
});
