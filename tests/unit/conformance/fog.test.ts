/**
 * Renderer conformance, fog (#129, Phase 5): the formulas each engine's shaders use at these versions, read from
 * the packages' shader sources (so an engine update that changes them fails here), and what they give for the
 * same parameters: at the centre of the view, and off-axis with the studio's AR projection, where Three.js's view
 * depth and Babylon.js's radial distance part. The browser check is tests/e2e/conformance.spec.ts ("fog").
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { AR_PROJECTION } from './ar-projection';

const read = (path: string) => readFileSync(path, 'utf8');
const THREE_FOG = 'node_modules/three/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js';
const THREE_FOG_VERTEX = 'node_modules/three/src/renderers/shaders/ShaderChunk/fog_vertex.glsl.js';
const THREE_PHYSICAL = 'node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js';
const BABYLON_FOG = 'node_modules/@babylonjs/core/Shaders/ShadersInclude/fogFragmentDeclaration.js';
const BABYLON_PBR = 'node_modules/@babylonjs/core/Shaders/pbr.fragment.js';

/** Fog amount (0: none, 1: fog colour only) as each engine computes it. */
export const threeFog = {
  linear: (d: number, near: number, far: number) => {
    const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
    return t * t * (3 - 2 * t); // GLSL smoothstep
  },
  exp2: (d: number, density: number) => 1 - Math.exp(-density * density * d * d),
};
export const babylonFog = {
  linear: (d: number, start: number, end: number) => 1 - Math.min(1, Math.max(0, (end - d) / (end - start))),
  exp: (d: number, density: number) => 1 - Math.min(1, Math.max(0, Math.exp(-d * density))),
  exp2: (d: number, density: number) => 1 - Math.min(1, Math.max(0, Math.exp(-d * d * density * density))),
};

/** Radial distance over view depth for the ray through a point in normalised device coordinates. */
export function radialOverDepth(ndcX: number, ndcY: number, p: readonly number[] = AR_PROJECTION): number {
  // clip.x = p0·x + p8·z and w = -z, so x / -z = (ndcX + p8) / p0; likewise y.
  const tx = (ndcX + p[8]) / p[0];
  const ty = (ndcY + p[9]) / p[5];
  return Math.hypot(1, tx, ty);
}

describe('fog conformance: the formulas in the shader sources', () => {
  test('Three.js: linear is smoothstep(near, far, depth), exp2 is 1 − exp(−ρ²d²)', () => {
    const src = read(THREE_FOG);
    expect(src).toContain('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );');
    expect(src).toContain('float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );');
    expect(src).not.toMatch(/exp\(\s*-\s*fogDensity\s*\*\s*vFogDepth\s*\)/); // no plain exponential mode
  });

  test('Three.js: the depth is the view-space depth, not the distance', () => {
    expect(read(THREE_FOG_VERTEX)).toContain('vFogDepth = - mvPosition.z;');
  });

  test('Babylon.js: linear, exp and exp2 on the radial distance', () => {
    const src = read(BABYLON_FOG);
    expect(src).toContain('float fogDistance=length(vFogDistance)');
    expect(src).toContain('fogCoeff=(fogEnd-fogDistance)/(fogEnd-fogStart)');
    expect(src).toContain('fogCoeff=1.0/pow(E,fogDistance*fogDensity)');
    expect(src).toContain('fogCoeff=1.0/pow(E,fogDistance*fogDistance*fogDensity*fogDensity)');
  });

  test('Three.js mixes fog after tone mapping and the colour-space encode; Babylon.js PBR before image processing', () => {
    const three = read(THREE_PHYSICAL);
    expect(three.indexOf('#include <colorspace_fragment>')).toBeLessThan(three.indexOf('#include <fog_fragment>'));
    expect(three.indexOf('#include <tonemapping_fragment>')).toBeLessThan(three.indexOf('#include <fog_fragment>'));
    const babylon = read(BABYLON_PBR);
    expect(babylon.indexOf('#include<fogFragment>')).toBeGreaterThan(-1);
    expect(babylon.indexOf('#include<fogFragment>')).toBeLessThan(babylon.indexOf('#include<pbrBlockImageProcessing>'));
  });
});

/** Largest difference of the fog amount over depths 0..2·far (or 0..4/ρ), for each engine's formula. */
function worst(f: (d: number) => number, g: (d: number) => number, max: number): number {
  let w = 0;
  for (let i = 0; i <= 4000; i++) {
    const d = (max * i) / 4000;
    w = Math.max(w, Math.abs(f(d) - g(d)));
  }
  return w;
}

describe('fog conformance: the same parameters on both', () => {
  test('linear, centre of the view: not equivalent, smoothstep against a straight ramp (up to 0.0962 of the fog)', () => {
    const w = worst((d) => threeFog.linear(d, 100, 1000), (d) => babylonFog.linear(d, 100, 1000), 1100);
    expect(w).toBeCloseTo(0.0962, 3);
    expect(w * 255).toBeGreaterThan(3); // above the "same formula" tolerance of 3/255 at full contrast
  });

  test('exp2, centre of the view: the same formula with the same density', () => {
    for (const density of [0.001, 0.003, 0.01]) {
      expect(worst((d) => threeFog.exp2(d, density), (d) => babylonFog.exp2(d, density), 4 / density)).toBeLessThan(1e-12);
    }
  });

  test('exp2, off-axis with the AR projection: Babylon.js sees more fog at the edge and the corner', () => {
    const edge = Math.max(radialOverDepth(1, 0), radialOverDepth(-1, 0));
    const corner = Math.max(...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => radialOverDepth(x, y)));
    // The distance is k times the depth; the residual's maximum does not depend on the density.
    const residual = (k: number) => worst((d) => threeFog.exp2(d, 0.01), (d) => babylonFog.exp2(k * d, 0.01), 400);
    expect(edge).toBeCloseTo(1.1321, 3);
    expect(corner).toBeCloseTo(1.1995, 3);
    // As a fog amount (0..1): 0.0911 at the edge is 23/255 at full contrast, 0.1331 at the corner 34/255.
    expect(residual(edge)).toBeCloseTo(0.0911, 3);
    expect(residual(corner)).toBeCloseTo(0.1331, 3);
    // So not a fixed, parameter-independent mapping: equivalent at the centre only.
    expect(residual(edge) * 255).toBeGreaterThan(3);
  });

  test('exp: Babylon.js only (FOGMODE_EXP); Three.js has no plain exponential fog', () => {
    expect(babylonFog.exp(100, 0.01)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect('exp' in threeFog).toBe(false);
  });
});
