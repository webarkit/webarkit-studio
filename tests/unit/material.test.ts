import { describe, expect, it } from 'vitest';
import { MATERIAL_SIDES, MAX_EMISSIVE_INTENSITY, MAX_REPEAT, MIN_REPEAT, normalizeMaterial, normalizeTexture, TEXTURE_WRAPS, materialSpec, textureSpec } from '../../src/core/material';

const PARAMS = { color: '#808080', metalness: 0.5, roughness: 0.25, emissive: '#000000', emissiveIntensity: 1, opacity: 1, side: 'front', unlit: false };

describe('materialSpec (#133)', () => {
  it('reads the params: colours as sRGB rgba, numbers as they are', () => {
    expect(materialSpec(PARAMS)).toEqual({
      color: [128 / 255, 128 / 255, 128 / 255],
      metalness: 0.5,
      roughness: 0.25,
      emissive: [0, 0, 0],
      emissiveIntensity: 1,
      opacity: 1,
      side: 'front',
      unlit: false,
    });
  });

  it('clamps metalness, roughness and opacity to 0..1, and emissiveIntensity to 0..MAX_EMISSIVE_INTENSITY', () => {
    const s = materialSpec({ ...PARAMS, metalness: 2, roughness: -1, opacity: 1.5, emissiveIntensity: 1e9 });
    expect([s.metalness, s.roughness, s.opacity, s.emissiveIntensity]).toEqual([1, 0, 1, MAX_EMISSIVE_INTENSITY]);
    expect(materialSpec({ ...PARAMS, emissiveIntensity: -3 }).emissiveIntensity).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, 'abc', null, undefined])('gives each number param its default for %s', (bad) => {
    const s = materialSpec({ ...PARAMS, metalness: bad, roughness: bad, opacity: bad, emissiveIntensity: bad });
    expect([s.metalness, s.roughness, s.opacity, s.emissiveIntensity]).toEqual([0, 1, 1, 1]);
  });

  it.each(['sideways', '__proto__', 'constructor', 'toString', 42])('gives side front for an unknown value (%s)', (side) => {
    expect(materialSpec({ ...PARAMS, side }).side).toBe('front');
  });

  it('knows the three sides', () => {
    expect(MATERIAL_SIDES).toEqual(['front', 'back', 'double']);
    for (const side of MATERIAL_SIDES) expect(materialSpec({ ...PARAMS, side }).side).toBe(side);
  });

  it('reads a malformed colour as opaque white, as hexToRgba does', () => {
    expect(materialSpec({ ...PARAMS, color: 'red', emissive: 12 }).color).toEqual([1, 1, 1]);
  });

  it('takes the colour and emissive inputs over the params, the colour input\'s alpha times opacity', () => {
    const s = materialSpec({ ...PARAMS, opacity: 0.5 }, { color: [1, 0, 0, 0.5], emissive: [0, 1, 0, 1] });
    expect(s.color).toEqual([1, 0, 0]);
    expect(s.emissive).toEqual([0, 1, 0]);
    expect(s.opacity).toBe(0.25);
  });

  it('ignores an input that is not an rgba value, and clamps one that is', () => {
    expect(materialSpec(PARAMS, { color: 'nope', emissive: [1, 2, 3] }).color).toEqual([128 / 255, 128 / 255, 128 / 255]);
    expect(materialSpec(PARAMS, { color: [2, -1, 0.5, 3] })).toMatchObject({ color: [1, 0, 0.5], opacity: 1 });
  });
});

describe('normalizeMaterial', () => {
  it('is idempotent, and is what materialSpec returns', () => {
    const s = materialSpec({ ...PARAMS, metalness: 7 });
    expect(normalizeMaterial(s)).toEqual(s);
  });

  it('makes a hand-built spec safe: the adapters call it on everything they are given', () => {
    const s = normalizeMaterial({ color: [2, NaN, -1], metalness: NaN, roughness: 9, emissive: [0, 0, 0], emissiveIntensity: Infinity, opacity: -1, side: 'nope' as never, unlit: 1 as never });
    expect(s).toEqual({ color: [1, 0, 0], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 0, side: 'front', unlit: true });
  });
});

describe('textureSpec (#133)', () => {
  it('reads the params', () => {
    expect(textureSpec({ url: 'x.png', wrap: 'mirror', repeatU: 2, repeatV: 3 })).toEqual({ wrap: 'mirror', repeatU: 2, repeatV: 3 });
  });

  it('knows the three wraps, and gives repeat for an unknown one', () => {
    expect(TEXTURE_WRAPS).toEqual(['clamp', 'repeat', 'mirror']);
    for (const wrap of ['spiral', '__proto__', 'hasOwnProperty', undefined]) expect(textureSpec({ wrap, repeatU: 1, repeatV: 1 }).wrap).toBe('repeat');
  });

  it('keeps repeat within MIN_REPEAT..MAX_REPEAT, and 1 for a value that is not a finite number', () => {
    expect(textureSpec({ wrap: 'repeat', repeatU: 0, repeatV: 1e9 })).toMatchObject({ repeatU: MIN_REPEAT, repeatV: MAX_REPEAT });
    expect(textureSpec({ wrap: 'repeat', repeatU: -2, repeatV: NaN })).toMatchObject({ repeatU: MIN_REPEAT, repeatV: 1 });
    expect(normalizeTexture({ wrap: 'clamp', repeatU: Infinity, repeatV: 2 })).toEqual({ wrap: 'clamp', repeatU: 1, repeatV: 2 });
  });
});
