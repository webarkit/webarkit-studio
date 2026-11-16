// Renderer conformance in the browser (#129; #130 makes it the suite every common scene node adds to): tables of cases,
// each run on both real adapters through tests/e2e/harness/conformance-harness.ts. Pixel tolerances are stated per
// table; the report (docs/proposals/scene-nodes-equivalence.md) explains each and names the Chromium revision they were
// measured on (1248).
//
// - "conformance: SceneHandle" is the table of the adapters as the studio's nodes drive them: a new common scene node
//   or adapter method adds one entry there (tests/e2e/AGENTS.md, "Conformance cases").
// - "conformance: lights in the current adapters" also goes through the adapters (buildWithAdapter): it holds the three
//   light kinds on scene.mesh, with the values each engine renders (alike since #131). It also checks that an
//   adopted hemisphere is aimed on the frame its parent turns (#145; the directions: tests/unit/conformance/hemisphere.test.ts).
// - The other tables are the report's experiments, built with each engine's own classes for what the adapters do not
//   have yet; a Phase 4 issue that implements one moves its case to the SceneHandle table.
// - Node cases (no WebGL): tests/unit/conformance/. Animations keep their own table on both engines:
//   tests/e2e/animations.spec.ts. Light kinds outside the catalog: tests/unit/light-kind.test.ts.
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { AdapterOp, Harness, SceneDesc, V3 } from './harness/conformance-harness';
import type { MaterialSpec, TextureSpec } from '../../src/core/material';
import type { LightSpec } from '../../src/core/light';
import type { GeometrySpec } from '../../src/core/geometry';
import { nonZeroScale, transformMatrix } from '../../src/core/math';

const ENGINES = ['three', 'babylon'] as const;
type Engine = (typeof ENGINES)[number];

/** "Same formula": per channel, in 8-bit sRGB (see the report). */
const SAME = 3;
/** "Same look": a translation that is not exact. */
const LOOK = 8;

let bundle = '';
test.beforeAll(async () => {
  const out = await build({
    entryPoints: [resolve('tests/e2e/harness/conformance-harness.ts')],
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0].text;
});

/**
 * exactSrgb: Babylon.js's useExactSrgbConversions forced on or off; left out, the adapter's own, which is on since #131
 * (the translation the report asked for). The report's experiments of the approximate encode force it off.
 */
async function open(page: Page, engine: Engine, size = 128, exactSrgb?: boolean) {
  await page.setContent('<!doctype html><title>conformance</title><body style="margin:0">');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ([e, s, x]) => {
      const w = window as never as { H: Harness; openConformance(e: string, s: number, o: object): Promise<Harness> };
      w.H = await w.openConformance(e, s, { exactSrgb: x });
    },
    [engine, size, exactSrgb] as const,
  );
}

/** Builds the scene, renders once, and returns the RGBA averages of the regions asked for. */
async function shoot(page: Page, desc: SceneDesc, regions: Record<string, [number, number, number, number]>): Promise<Record<string, number[]>> {
  return page.evaluate(
    async ([d, r]) => {
      const H = (window as never as { H: Harness }).H;
      await H.build(d);
      H.render();
      return Object.fromEntries(Object.entries(r).map(([k, [x, y, w, h]]) => [k, H.region(x, y, w, h)]));
    },
    [desc, regions] as const,
  );
}

/** Both engines' results, each from `run(engine)` in a fresh page; Babylon.js with exact sRGB (the adapter's own since #131). */
async function onBoth<T>(page: Page, size: number, run: (engine: Engine) => Promise<T>, exactSrgb = true): Promise<Record<Engine, T>> {
  const out = {} as Record<Engine, T>;
  for (const engine of ENGINES) {
    await open(page, engine, size, exactSrgb);
    out[engine] = await run(engine);
  }
  return out;
}

const rgb = (v: number[]) => v.slice(0, 3);
const maxDiff = (a: number[], b: number[]) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])));
const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/**
 * A glTF 2.0 JSON document (#153): a square of side 2 × `half` mm, one half-transparent PBR material (alphaMode BLEND), its
 * buffer a data: URI, so no binary asset. The square lies in glTF's XZ plane, facing glTF +Y, which the adapters turn
 * into marker +Z (Y_UP_TO_Z_UP): it faces the camera. Wound counter-clockwise seen from +Y.
 */
function transparentSquareGltf(half: number, baseColor: [number, number, number, number], roughness: number): object {
  const positions = new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 0, 0]); // two padding indices: 4-byte aligned, not read
  const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: baseColor, metallicFactor: 0, roughnessFactor: roughness }, alphaMode: 'BLEND' }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 12 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-half, 0, -half], max: [half, 0, half] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
}

/** The #153 scene: the square (30 mm half side, 80 mm away) under a directional light, an opaque box beside it. */
const GLTF_HIGHLIGHT_OPS: AdapterOp[] = [
  { op: 'createLight', id: 'sun', spec: { kind: 'directional', color: '#ffffff', intensity: 1 } },
  { op: 'addRoot', id: 'sun' },
  { op: 'loadModel', id: 'm', gltf: transparentSquareGltf(30, [0.75, 0.5, 0.25, 0.5], 0.3) },
  { op: 'setPosition', id: 'm', position: [0, 0, -80] },
  { op: 'addRoot', id: 'm' },
  { op: 'createPrimitive', id: 'b', spec: { shape: 'box', size: 20, color: '#808080' } },
  { op: 'setPosition', id: 'b', position: [50, 0, -80] },
  { op: 'addRoot', id: 'b' },
];

/**
 * The #155 scene: two half-transparent boxes, one in front of the other, overlapping at the centre, and an opaque box
 * above them (so a frame read is drawn). The harness's 90° view at 128 px shows 64 / d px per mm at d mm. The far box,
 * z −170..−110, shows its front face (110 mm away) at x 59..94 px, y 47..81; the near one, z −100..−60, at x 27..69,
 * y 43..85. Only their front faces are seen, and they do not intersect. Regions: `near` and `far` alone, `both`, and
 * the opaque `top` (x 55..73, y 18..37).
 */
const OVERLAP_OPS: AdapterOp[] = [
  { op: 'createPrimitive', id: 'far', spec: { shape: 'box', size: 60, color: '#808080' } },
  { op: 'setPosition', id: 'far', position: [21, 0, -140] },
  { op: 'addRoot', id: 'far' },
  { op: 'createPrimitive', id: 'near', spec: { shape: 'box', size: 40, color: '#808080' } },
  { op: 'setPosition', id: 'near', position: [-15, 0, -80] },
  { op: 'addRoot', id: 'near' },
  { op: 'setColor', id: 'far', color: [0.25, 0.5, 0.75, 0.5] },
  { op: 'setColor', id: 'near', color: [0.75, 0.5, 0.25, 0.5] },
  { op: 'createPrimitive', id: 'top', spec: { shape: 'box', size: 20, color: '#808080' } },
  { op: 'setPosition', id: 'top', position: [0, 40, -80] },
  { op: 'addRoot', id: 'top' },
];
const OVERLAP_REGIONS: Record<string, [number, number, number, number]> = { near: [34, 62, 4, 4], both: [62, 62, 4, 4], far: [84, 62, 4, 4], top: [62, 22, 4, 4] };

/** The clipping rule: a sample is only evidence if every channel lies in 30..225. */
const unclipped = (v: number[]) => v.slice(0, 3).every((c) => c >= 30 && c <= 225);

/** A plane filling the 90° view at 50 mm. */
const FILL = { shape: 'plane' as const, size: 120, position: [0, 0, -50] as [number, number, number] };
const CENTRE: [number, number, number, number] = [56, 56, 16, 16];

test.describe('conformance: calibration', () => {
  test('both renderers: state that decides colours, and a frame renders twice the same', async ({ page, browser }) => {
    const info: Record<string, unknown> = { browser: browser.version() };
    for (const engine of ENGINES) {
      await open(page, engine);
      info[engine] = await page.evaluate(async (d) => {
        const H = (window as never as { H: Harness }).H;
        await H.build(d);
        return { ...H.calibration(), repeatIdentical: H.repeatIdentical() };
      }, { size: 128, objects: [{ ...FILL, material: { kind: 'pbr', color: '#808080' } }], lights: [{ kind: 'directional', intensity: 1, direction: [0, -0.7071, -0.7071] }] } satisfies SceneDesc);
    }
    test.info().annotations.push({ type: 'calibration', description: JSON.stringify(info) });
    console.log('calibration', JSON.stringify(info));
    expect(browser.version()).toMatch(/^\d+\./);
    for (const engine of ENGINES) expect((info[engine] as { repeatIdentical: boolean }).repeatIdentical).toBe(true);
    const three = info.three as Record<string, unknown>;
    const babylon = info.babylon as Record<string, unknown>;
    expect(three.outputColorSpace).toBe('srgb');
    expect(three.toneMapping).toBe(0); // NoToneMapping
    expect(babylon.toneMappingEnabled).toBe(false);
    expect(babylon.exposure).toBe(1);
    expect(three.premultipliedAlpha).toBe(true);
    expect(three.toneMappingExposure).toBe(1);
    expect(three.clearAlpha).toBe(0);
    expect(babylon.premultipliedAlpha).toBe(true); // #144: its framebuffer holds colour × alpha, as Three.js's does
    expect(babylon.contrast).toBe(1);
    expect(babylon.clearColor).toEqual([0, 0, 0, 0]);
  });
});

test.describe('conformance: colour pipeline', () => {
  test('unlit: a hex colour comes out unchanged on both, when Babylon.js is given it in linear', async ({ page }) => {
    const r = await onBoth(page, 128, () =>
      shoot(page, { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#8040c0' } }], lights: [] }, { c: CENTRE }),
    );
    for (const engine of ENGINES) expect(maxDiff(r[engine].c, [128, 64, 192]), engine).toBeLessThanOrEqual(SAME);
  });

  test('unlit: the hex colour given to Babylon.js unconverted (Color3.FromHexString, as the adapter did before #131) comes out brighter', async ({ page }) => {
    await open(page, 'babylon', 128, false);
    const r = await shoot(page, { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#8040c0', rawHex: true } }], lights: [] }, { c: CENTRE });
    // Treated as linear and encoded to sRGB on output: 128 → 188, 64 → 137, 192 → 225.
    expect(maxDiff(r.c, [188, 137, 225])).toBeLessThanOrEqual(SAME);
  });

  test('emissive alone, no light: the same colour on both', async ({ page }) => {
    const r = await onBoth(page, 128, () =>
      shoot(page, { size: 128, objects: [{ ...FILL, material: { kind: 'pbr', color: '#000000', emissive: '#8040c0' } }], lights: [] }, { c: CENTRE }),
    );
    expect(maxDiff(r.three.c, [128, 64, 192])).toBeLessThanOrEqual(SAME);
    expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
  });
});

test.describe('conformance: output encode', () => {
  test('Babylon.js encodes with pow(x, 1/2.2) unless useExactSrgbConversions is on; Three.js uses the sRGB curve', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#303030' } }], lights: [] };
    const exact = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    await open(page, 'babylon', 128, false);
    const approx = await shoot(page, desc, { c: CENTRE });
    expect(maxDiff(exact.three.c, [48, 48, 48])).toBeLessThanOrEqual(1);
    expect(maxDiff(exact.babylon.c, exact.three.c)).toBeLessThanOrEqual(1);
    // pow(0.0296, 1/2.2) = 0.202 → 52: four levels brighter in the darks.
    expect(maxDiff(approx.c, [52, 52, 52])).toBeLessThanOrEqual(1);
  });
});

/** Directional light at 45° to a plane facing the camera; the plane diffuse only (no specular), so k is the diffuse's. */
const D45: [number, number, number] = [0, -0.7071068, -0.7071068];
const D60: [number, number, number] = [0, -0.8660254, -0.5];
const diffusePlane = (color: string, z = -50, size = 120) => ({ shape: 'plane' as const, size, position: [0, 0, z] as [number, number, number], material: { kind: 'pbr' as const, color, noSpecular: true } });

test.describe('conformance: lights (Babylon.js on PBRMaterial, exact sRGB)', () => {
  /** k: the factor on Babylon.js's intensity. Measured, then hard-coded: a refit would hide a change. */
  const K = { directional: 1, point: 1, spot: 1, hemisphere: 1 / Math.PI, ambient: 1 / Math.PI };
  const directionalCases: Array<{ name: string; desc: SceneDesc }> = [
    { name: 'grey, 45°, I 1', desc: { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'directional', intensity: 1, direction: D45 }] } },
    { name: 'grey, 45°, I 3', desc: { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'directional', intensity: 3, direction: D45 }] } },
    { name: 'grey, 60°, I 2', desc: { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'directional', intensity: 2, direction: D60 }] } },
    // Light #ff8040 at I 2 was rejected by the clipping rule (Three.js blue 16): this one keeps every channel in 30..225.
    { name: 'saturated albedo, coloured light, 45°, I 3', desc: { size: 128, objects: [diffusePlane('#40c080')], lights: [{ kind: 'directional', intensity: 3, direction: D45, color: '#ffc080' }] } },
    { name: 'white, 45°, I 1', desc: { size: 128, objects: [diffusePlane('#ffffff')], lights: [{ kind: 'directional', intensity: 1, direction: D45 }] } },
  ];
  for (const c of directionalCases) {
    test(`directional, k = 1: ${c.name}`, async ({ page }) => {
      const r = await onBoth(page, 128, () => shoot(page, { ...c.desc, babylonLightScale: K.directional }, { c: CENTRE, corner: [8, 8, 8, 8] }));
      for (const at of ['c', 'corner']) {
        expect(unclipped(r.three[at]), `three ${at} ${r.three[at]}`).toBe(true);
        expect(maxDiff(r.babylon[at], r.three[at]), `${at}: ${rgb(r.three[at])} / ${rgb(r.babylon[at])}`).toBeLessThanOrEqual(SAME);
      }
    });
  }

  test('directional: the interval of k the tolerance allows, and controls at 1.1 and at 0.4 (BABYLON_INTENSITY) that must fail', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'directional', intensity: 3, direction: D45 }] };
    const at = (k: number) => onBoth(page, 128, () => shoot(page, { ...desc, babylonLightScale: k }, { c: CENTRE }));
    const one = await at(1);
    const t = one.three.c[0];
    const b = toLinear(one.babylon.c[0]);
    // Babylon's linear output is proportional to k here (one light, no ambient): k such that encode(k·b) stays within t ± SAME.
    const interval = [toLinear(t - SAME) / b, toLinear(t + SAME) / b];
    test.info().annotations.push({ type: 'k interval (directional)', description: interval.map((v) => v.toFixed(3)).join('–') });
    console.log('k interval (directional)', interval.map((v) => v.toFixed(3)).join('–'));
    expect(interval[0]).toBeLessThan(1);
    expect(interval[1]).toBeGreaterThan(1);
    expect(interval[1]).toBeLessThan(1.1);
    for (const k of [1.1, 0.4]) {
      const control = await at(k);
      expect(maxDiff(control.babylon.c, control.three.c), `k ${k}`).toBeGreaterThan(SAME);
    }
  });

  test('hemisphere, k = 1/π: Babylon.js PBR does not divide a hemispheric light by π', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'hemisphere', intensity: 2, direction: [0, 1, 0], ground: '#000000' }] };
    const r = await onBoth(page, 128, () => shoot(page, { ...desc, babylonLightScale: K.hemisphere }, { c: CENTRE }));
    expect(unclipped(r.three.c)).toBe(true);
    expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
    const control = await onBoth(page, 128, () => shoot(page, { ...desc, babylonLightScale: 1 }, { c: CENTRE }));
    expect(maxDiff(control.babylon.c, control.three.c)).toBeGreaterThan(SAME);
  });

  test('ambient (a hemispheric light with the same sky and ground), k = 1/π', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080')], lights: [{ kind: 'ambient', intensity: 1 }], babylonLightScale: K.ambient };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    expect(unclipped(r.three.c)).toBe(true);
    expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
  });

  test('hemisphere facing the sky, k = 1/pi: the same; and PBRMaterial adds a specular term unless the light specular is black', async ({ page }) => {
    // Sky towards the camera, a dielectric at roughness 0.3 with its specular on.
    const desc = (specularBlack: boolean): SceneDesc => ({
      size: 128,
      objects: [{ ...diffusePlane('#808080'), material: { kind: 'pbr', color: '#808080', metalness: 0, roughness: 0.3 } }],
      lights: [{ kind: 'hemisphere', intensity: 2, direction: [0, 0, 1], ground: '#000000', specularBlack }],
      babylonLightScale: K.hemisphere,
    });
    const black = await onBoth(page, 128, () => shoot(page, desc(true), { c: CENTRE }));
    expect(unclipped(black.three.c)).toBe(true);
    expect(maxDiff(black.babylon.c, black.three.c)).toBeLessThanOrEqual(SAME);
    await open(page, 'babylon', 128, true);
    const white = await shoot(page, desc(false), { c: CENTRE });
    console.log('pbr hemisphere specular', rgb(black.three.c), rgb(black.babylon.c), rgb(white.c));
    expect(maxDiff(white.c, black.three.c)).toBeGreaterThan(LOOK); // measured 145 against 102
  });

  test('hemisphere, the ground colour alone (sky turned away), #444444 as sRGB on both, k = 1/pi', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#ffffff')], lights: [{ kind: 'hemisphere', intensity: 2, direction: [0, 0, -1], color: '#000000', ground: '#444444', specularBlack: true }], babylonLightScale: K.hemisphere };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    console.log('pbr ground', rgb(r.three.c), rgb(r.babylon.c));
    expect(unclipped(r.three.c)).toBe(true);
    expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
  });

  // A plane at d mm, a point light at the origin with intensity 2·d² (candela, mm): the same irradiance at the centre.
  for (const d of [20, 100, 500, 1000]) {
    test(`point, inverse square in mm, k = 1: plane at ${d} mm`, async ({ page }) => {
      const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080', -d, 3 * d)], lights: [{ kind: 'point', intensity: 2 * d * d, position: [0, 0, 0] }] };
      const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
      expect(unclipped(r.three.c)).toBe(true);
      expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
    });
  }

  // Three.js distance windows the light by (1 − (d/distance)⁴)²: Babylon.js's glTF falloff with range does the same.
  for (const d of [100, 200, 280, 300]) {
    test(`point, Three.js distance 300 = Babylon.js range 300 with the glTF falloff: plane at ${d} mm`, async ({ page }) => {
      const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080', -d, 3 * d)], lights: [{ kind: 'point', intensity: 2 * d * d, position: [0, 0, 0], distance: 300, falloff: 'gltf' }] };
      const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
      expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
    });
  }

  test('point: the physical falloff (Babylon.js default) ignores range', async ({ page }) => {
    await open(page, 'babylon', 128, true);
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080', -280, 840)], lights: [{ kind: 'point', intensity: 2 * 280 * 280, position: [0, 0, 0], distance: 300 }] };
    const r = await shoot(page, desc, { c: CENTRE });
    expect(r.c[0]).toBeGreaterThan(90); // Three.js's distance gives 22 here (the glTF-falloff cases above)
  });

  test('point: decay other than 2 is Three.js only (Babylon.js has no decay exponent)', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080', -100, 300)], lights: [{ kind: 'point', intensity: 200, position: [0, 0, 0], decay: 1 }] };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    expect(unclipped(r.three.c)).toBe(true);
    expect(r.babylon.c[3]).toBe(255); // the plane is drawn
    expect(r.babylon.c[0]).toBeLessThan(10); // inverse square regardless
    // Control: decay 2 at the same distance agrees, so the dark plane is the decay, not a failed draw.
    const control = await onBoth(page, 128, () => shoot(page, { ...desc, lights: [{ kind: 'point', intensity: 2 * 100 * 100, position: [0, 0, 0] }] }, { c: CENTRE }));
    expect(maxDiff(control.babylon.c, control.three.c)).toBeLessThanOrEqual(SAME);
  });

  // A spot at the origin onto a plane at 100 mm, half-angle 20°: the lit disc's radius is 36 mm, ±47 px of 256.
  async function spotRow(page: Page, engine: Engine, extra: object): Promise<number[]> {
    await open(page, engine, 256, true);
    const desc: SceneDesc = { size: 256, objects: [diffusePlane('#808080', -100, 300)], lights: [{ kind: 'spot', intensity: 2 * 100 * 100, position: [0, 0, 0], angle: 20, ...extra }] };
    return page.evaluate(async (d) => {
      const H = (window as never as { H: Harness }).H;
      await H.build(d);
      H.render();
      return H.row(128);
    }, desc);
  }
  const edges = (row: number[]) => {
    const lit = row.map((v) => v > 6);
    return [lit.indexOf(true), lit.lastIndexOf(true)];
  };

  test('spot, hard cone: Babylon.js angle = 2 × Three.js angle, glTF falloff, innerAngle = angle; same edges within ±2 px', async ({ page }) => {
    const three = await spotRow(page, 'three', { penumbra: 0 });
    const babylon = await spotRow(page, 'babylon', { penumbra: 0, falloff: 'gltf', innerAngle: 40, exponent: 0 });
    const [t0, t1] = edges(three);
    const [b0, b1] = edges(babylon);
    expect(t1 - t0).toBeGreaterThan(80);
    expect(Math.abs(b0 - t0)).toBeLessThanOrEqual(2);
    expect(Math.abs(b1 - t1)).toBeLessThanOrEqual(2);
    expect(maxDiff([babylon[128]], [three[128]])).toBeLessThanOrEqual(SAME);
  });

  test('spot, penumbra 0.5 (innerAngle = 2 × angle × (1 − penumbra)): same outer edge, not the same profile', async ({ page }) => {
    const three = await spotRow(page, 'three', { penumbra: 0.5 });
    const babylon = await spotRow(page, 'babylon', { penumbra: 0.5, falloff: 'gltf', innerAngle: 20, exponent: 0 });
    const [t0, t1] = edges(three);
    const [b0, b1] = edges(babylon);
    expect(Math.abs(b0 - t0)).toBeLessThanOrEqual(2);
    expect(Math.abs(b1 - t1)).toBeLessThanOrEqual(2);
    // Three.js: smoothstep between the cosines; Babylon.js glTF: a squared linear ramp. The largest difference across the penumbra:
    const worst = Math.max(...three.map((v, i) => Math.abs(v - babylon[i])));
    test.info().annotations.push({ type: 'spot penumbra residual', description: String(worst) });
    console.log('spot penumbra residual', worst);
    expect(worst).toBeGreaterThan(LOOK);
  });
});

test.describe('conformance: lights in the current adapters (scene.light on scene.mesh)', () => {
  // Three.js MeshStandardMaterial; Babylon.js PBRMaterial with the report's light mapping since #131 (k = 1, 1/π for
  // hemisphere and ambient; colours in linear; exact sRGB; a hemispheric light's specular black). Before #131 it was
  // StandardMaterial with every light x 0.4, and these values differed (Babylon.js 20, 51, 56). Red channel of a #808080
  // box whose front face looks at the camera (+Z). Both adapters point a hemisphere's sky along +Z, so with the sky
  // black and the box facing it, the ground weighs nothing: a specular term on Babylon.js's hemispheric light, which
  // Three.js's HemisphereLight does not have, would show there.
  const RX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  const cases = {
    hemisphereSpecular: { lights: [{ kind: 'hemisphere', color: '#000000', intensity: 1 }] },
    ambient: { lights: [{ kind: 'ambient', color: '#ffffff', intensity: 1 }] },
    directional: { lights: [{ kind: 'directional', color: '#ffffff', intensity: 1 }] },
    // The hemisphere under a group turned 180 degrees about X: the adapters re-orient an adopted hemisphere from its
    // parent, so the sky points away and the front face sees only the ground (0x444444 on both, in linear).
    groundOnly: { lights: [{ kind: 'hemisphere', color: '#000000', intensity: 1 }], lightsMatrix: RX180 },
  };
  // groundOnly is read on the second frame; the first frame after the hemisphere is adopted, and the frame right after
  // its parent turns, are checked below (#145).
  type Name = keyof typeof cases;
  const pinned: Record<Name, { three: number; babylon: number }> = {
    hemisphereSpecular: { three: 0, babylon: 0 },
    ambient: { three: 74, babylon: 73 },
    directional: { three: 72, babylon: 72 },
    groundOnly: { three: 13, babylon: 12 },
  };
  const measure = (page: Page, extra: object = {}, frames = 2) =>
    onBoth(
      page,
      128,
      () =>
        page.evaluate(
          async ([all, x, n]) => {
            const H = (window as never as { H: Harness }).H;
            const out: Record<string, number> = {};
            for (const [name, c] of Object.entries(all)) {
              await H.buildWithAdapter({ size: 40, color: '#808080', position: [0, 0, -60], ...(c as object), ...(x as object) } as never);
              for (let i = 0; i < n; i++) H.render();
              out[name] = Math.round(H.region(60, 60, 8, 8)[0]);
            }
            return out;
          },
          [cases, extra, frames] as const,
        ),
    );

  test('pinned: what each adapter renders', async ({ page }) => {
    const r = await measure(page);
    console.log('lights', JSON.stringify(r));
    for (const name of Object.keys(pinned) as Name[]) {
      expect(Math.abs(r.three[name] - pinned[name].three), `three ${name} ${r.three[name]}`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.babylon[name] - pinned[name].babylon), `babylon ${name} ${r.babylon[name]}`).toBeLessThanOrEqual(1);
    }
  });

  test("the Babylon.js adapter's hemispheric light has no specular: forcing it black changes nothing (#131)", async ({ page }) => {
    const r = await measure(page);
    const black = await measure(page, { babylonSpecularBlack: true });
    // babylonSpecularBlack blacks out every light's specular: the directional light keeps its own on both engines.
    for (const name of ['hemisphereSpecular', 'ambient', 'groundOnly'] as const) expect(Math.abs(black.babylon[name] - r.babylon[name]), name).toBeLessThanOrEqual(1);
  });

  test('the ground colour alone: the two adapters agree', async ({ page }) => {
    const r = await measure(page);
    expect(Math.abs(r.babylon.groundOnly - r.three.groundOnly)).toBeLessThanOrEqual(SAME);
  });

  test('pinned: the first frame after a hemisphere is adopted, the ground already on both', async ({ page }) => {
    const r = await measure(page, {}, 1);
    expect(Math.abs(r.three.groundOnly - pinned.groundOnly.three), `three ${r.three.groundOnly}`).toBeLessThanOrEqual(1);
    expect(Math.abs(r.babylon.groundOnly - pinned.groundOnly.babylon), `babylon ${r.babylon.groundOnly}`).toBeLessThanOrEqual(1);
  });

  // #145: the Three.js adapter recomputes the world matrices before it aims the adopted hemispheres.
  test('the Three.js adapter re-orients an adopted hemisphere on its first frame (#145)', async ({ page }) => {
    const r = await measure(page, {}, 1);
    expect(Math.abs(r.babylon.groundOnly - r.three.groundOnly)).toBeLessThanOrEqual(SAME);
  });

  // The parent's matrix changes between two frames; the frame right after is read with one render. Direct: the hemisphere's
  // own group turns. Nested: an anchor turns, the group inside it does not.
  const afterChange = (page: Page, nested: boolean) =>
    onBoth(page, 128, () => page.evaluate((n) => (window as never as { H: Harness }).H.hemisphereAfterChange(n), nested));

  for (const nested of [false, true]) {
    const shape = nested ? 'a group inside an anchor that turns' : 'its own group that turns';
    test(`pinned: a hemisphere in ${shape}, the frame after the change`, async ({ page }) => {
      const r = await afterChange(page, nested);
      console.log('hemisphere after change', nested ? 'nested' : 'direct', JSON.stringify(r));
      for (const engine of ENGINES) {
        expect(r[engine].settled, `${engine} settled`).toBe(0); // sky towards the box: no ground
        expect(r[engine].secondFrame, `${engine} second frame`).toBeGreaterThan(8); // turned: the ground shows
      }
      for (const engine of ENGINES)
        expect(Math.abs(r[engine].afterChange - r[engine].secondFrame), `${engine} on the frame itself`).toBeLessThanOrEqual(1);
    });

    test(`the Three.js adapter re-orients a hemisphere in ${shape} on the frame of the change (#145)`, async ({ page }) => {
      const r = await afterChange(page, nested);
      expect(Math.abs(r.three.afterChange - r.babylon.afterChange)).toBeLessThanOrEqual(SAME);
    });
  }

  for (const name of ['hemisphereSpecular', 'ambient', 'directional', 'groundOnly'] as const) {
    test(`${name} renders alike on both adapters (#131)`, async ({ page }) => {
      const r = await measure(page);
      expect(Math.abs(r.babylon[name] - r.three[name])).toBeLessThanOrEqual(SAME);
    });
  }
});

test.describe('conformance: SceneHandle (the adapters as the studio drives them)', () => {
  // One entry per behaviour: an ordered list of SceneHandle calls (AdapterOp), the regions to read, and the rules both
  // engines must meet. Run on the adapters as they are, as the studio renders (Babylon.js with exact sRGB since #131).
  // 128 px, the harness's 90° projection: a point (x, y, z) shows at pixel
  // 64 + 64·x/−z, 64 − 64·y/−z.
  //
  // A rule reads the frame after the last operation, or, with `frame`, the frame a `render` operation captured under
  // that name (`{ op: 'render', capture: 'hidden' }`), so a case can check a state it later leaves.
  //
  // A difference the adapters have today is `known`: its rules become a test marked test.fail with the issue that fixes
  // it, and a passing test pins what each engine renders, so the failing one fails for that reason and no other.
  //
  // The scene has no default lights: an unlit primitive is black on both engines, so a `same` rule on it compares
  // coverage (alpha) only; the cases with a light compare the lit colour (#131).

  type Region = [number, number, number, number];
  type Rule = (
    /** Per engine: alpha ≥ 250 (something drawn) or ≤ 2 (nothing). A frame with `empty` needs a `drawn` (checked). */
    | { region: string; is: 'drawn' | 'empty' }
    /** Per engine: alpha within SAME of `value`. */
    | { region: string; is: 'alpha'; value: number }
    /** Across engines: RGBA within SAME. */
    | { region: string; is: 'same' }
    /** Across engines: alpha within SAME. */
    | { region: string; is: 'sameAlpha' }
    /**
     * Across engines: every transition along the row between lit (alpha > 128) and unlit, the same number on both and
     * each within EDGE px; something drawn on both. A hole is two transitions, so a filled shape with the same outline
     * fails.
     */
    | { row: number; is: 'edges'; /** #134: a colour channel (0–2) instead of alpha, lit above `threshold` (128). */ channel?: number; threshold?: number }
    /** Per engine: the object's world bounds, within the report's 1e-4 mm. */
    | { bounds: string; min: V3; max: V3 }
    /** Per engine: RGBA within SAME of another region of the same frame (a live change against a fresh object, #133). */
    | { region: string; is: 'matches'; other: string }
  ) & {
    /** The frame the rule reads: a `render` operation's `capture`; the final frame when omitted. */
    frame?: string;
  };
  interface Case {
    name: string;
    ops: AdapterOp[];
    regions?: Record<string, Region>;
    rules: Rule[];
    known?: {
      issue: string;
      why: string;
      /** The rules that fail today; the others stay in the passing test. */
      rules: Rule[];
      /** RGBA each engine renders today, per region, within 1 level. */
      pinned: Record<Engine, Record<string, number[]>>;
    };
  }
  /** The report's ±2 px at 256 px for an edge (the spot cone), at this suite's 128 px. */
  const EDGE = 1;
  const GEOMETRY = 1e-4;

  const box = (id: string, size: number, at: V3, color = '#808080'): AdapterOp[] => [
    { op: 'createPrimitive', id, spec: { shape: 'box', size, color } },
    { op: 'setPosition', id, position: at },
  ];
  /** Rotated 90° about Z, translated 80 mm down −Z (column-major). */
  const RZ90_AT_80 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, -80, 1];

  // #133: materials and textures. The 90° view at 128 px shows 64 / d px per mm at d mm: a 100 mm plane 50 mm away
  // fills the frame; two 40 mm planes at x ±25 show at x 6..57 and 70..121 (regions L and R).
  /** A material spec: an unlit white by default, so a case states what it changes. */
  const mat = (over: Partial<MaterialSpec> = {}): MaterialSpec => ({ color: [1, 1, 1], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 1, side: 'front', unlit: true, ...over });
  const tex = (wrap: TextureSpec['wrap'] = 'repeat', repeat = 1): TextureSpec => ({ wrap, repeatU: repeat, repeatV: repeat });
  /** Rotated about X by `deg`, then moved to `at` (column-major). */
  const rotX = (deg: number, at: V3) => {
    const a = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, at[0], at[1], at[2], 1];
  };
  /** A plane mesh `id` of `width` × `depth` mm at `at` (or placed by a matrix), drawn with material `material`. */
  const plane = (id: string, width: number, depth: number, at: V3 | number[], material: string): AdapterOp[] => [
    { op: 'createGeometry', id: `${id}_g`, spec: { shape: 'plane', width, depth } },
    { op: 'createMesh', id, geometry: `${id}_g` },
    at.length === 3 ? { op: 'setPosition', id, position: at as V3 } : { op: 'setMatrix', id, matrix: at as number[] },
    { op: 'addRoot', id },
    { op: 'setMeshMaterial', mesh: id, material },
  ];
  const SUN: AdapterOp[] = [{ op: 'createLight', id: 'sun', spec: { kind: 'directional', color: '#ffffff', intensity: 1 } }, { op: 'addRoot', id: 'sun' }];

  // #134: lights and shadows. A lit grey material; a shadow catcher 300 mm square, 200 mm away, at opacity 0.8 (so a
  // shadow's alpha, 204, is past the edges rule's 128); a 50 mm cube standing on it to the right of the centre
  // (x 15..65 mm). A light from the right at 45° throws the cube's shadow to its left, on the catcher: x −35..15 mm, at
  // 0.32 px per mm there px 53..69 (region S); the cube's front face is px 70..92 (C); far left, no shadow (O).
  const LIT_OPS: AdapterOp[] = [{ op: 'createMaterial', id: 'lit', spec: mat({ unlit: false, color: [0.7, 0.7, 0.7] }) }];
  const lightOps = (spec: LightSpec, id = 'l'): AdapterOp[] => [{ op: 'createLight', id, spec }, { op: 'addRoot', id }];
  const meshOps = (id: string, shape: GeometrySpec, at: V3, cast = false, receive = false, material = 'lit'): AdapterOp[] => [
    { op: 'createGeometry', id: `${id}_g`, spec: shape },
    { op: 'createMesh', id, geometry: `${id}_g` },
    { op: 'setPosition', id, position: at },
    { op: 'addRoot', id },
    { op: 'setMeshMaterial', mesh: id, material },
    { op: 'setShadowCasting', id, cast, receive },
  ];
  const catcherOps = (opacity = 0.8, size = 300): AdapterOp[] => [
    { op: 'createShadowCatcher', id: 'c', spec: { width: size, depth: size, opacity } },
    { op: 'setPosition', id: 'c', position: [0, 0, -200] },
    { op: 'addRoot', id: 'c' },
  ];
  const STANDING_CUBE = meshOps('cube', { shape: 'box', width: 50, depth: 50, height: 50 }, [40, 0, -175], true);
  const SIDE_SUN: LightSpec = { kind: 'directional', color: '#ffffff', intensity: 2, position: [300, 0, 100], target: [0, 0, -200], castShadow: true };
  const SIDE_SPOT: LightSpec = { kind: 'spot', color: '#ffffff', intensity: 0.5, position: [150, 0, -50], target: [0, 0, -200], angle: 40, castShadow: true };
  const SHADOW_REGIONS: Record<string, Region> = { S: [56, 62, 8, 4], C: [78, 62, 4, 4], O: [20, 62, 4, 4] };
  const shadowRules = (alpha = 204): Rule[] => [
    { region: 'C', is: 'drawn' },
    { region: 'O', is: 'empty' },
    { region: 'S', is: 'alpha', value: alpha },
    { region: 'S', is: 'same' },
    { region: 'C', is: 'same' },
    { row: 64, is: 'edges' },
    { row: 60, is: 'edges' },
  ];
  /** The whole frame in a grid of 4 px regions, 8 × 8: g<i>_<j> at x 6 + 16 i, y 6 + 16 j. */
  const GRID: Record<string, Region> = Object.fromEntries([...Array(64)].map((_, k) => [`g${k % 8}_${(k / 8) | 0}`, [6 + 16 * (k % 8), 6 + 16 * ((k / 8) | 0), 4, 4] as Region]));
  const sameEverywhere = (regions: Record<string, Region>): Rule[] => Object.keys(regions).map((region) => ({ region, is: 'same' }));
  /** Two 40 mm planes side by side: L made with one setup and changed live to another, R made with that other (#133). */
  const LIVE_REGIONS: Record<string, Region> = { L: [28, 60, 8, 8], R: [92, 60, 8, 8] };
  const liveRules = (drawn = true): Rule[] => [
    ...(drawn ? [{ region: 'L', is: 'drawn' } as Rule, { region: 'R', is: 'drawn' } as Rule] : []),
    { region: 'L', is: 'matches', other: 'R' },
    { region: 'L', is: 'same' },
  ];

  const CASES: Case[] = [
    ...(['box', 'sphere', 'torusKnot'] as const).map(
      (shape): Case => ({
        name: `createPrimitive ${shape}, unlit: the same silhouette`,
        ops: [{ op: 'createPrimitive', id: 'p', spec: { shape, size: 40, color: '#808080' } }, { op: 'setPosition', id: 'p', position: [0, 0, -80] }, { op: 'addRoot', id: 'p' }],
        // The torus knot has a hole about its axis (2 px here): its rows carry the check, not its centre. Each row of
        // it crosses the tube several times (4 to 6 transitions), so a filled shape with the same outline fails.
        regions: shape === 'torusKnot' ? {} : { centre: [62, 62, 4, 4] },
        rules: [
          ...(shape === 'torusKnot' ? [] : [{ region: 'centre', is: 'drawn' } as const, { region: 'centre', is: 'same' } as const]),
          { row: 64, is: 'edges' },
          { row: 56, is: 'edges' },
          { row: 72, is: 'edges' },
        ],
      }),
    ),
    {
      name: 'setVisible false: the object is not drawn, its neighbour is',
      ops: [...box('a', 30, [-30, 0, -80]), { op: 'addRoot', id: 'a' }, ...box('b', 30, [30, 0, -80]), { op: 'addRoot', id: 'b' }, { op: 'setVisible', id: 'a', visible: false }],
      regions: { a: [30, 62, 4, 4], b: [94, 62, 4, 4] },
      rules: [{ region: 'a', is: 'empty' }, { region: 'b', is: 'drawn' }],
    },
    {
      name: 'setVisible false on a group hides its child',
      ops: [{ op: 'createGroup', id: 'g' }, { op: 'addRoot', id: 'g' }, ...box('a', 30, [-30, 0, -80]), { op: 'addChild', parent: 'g', child: 'a' }, ...box('b', 30, [30, 0, -80]), { op: 'addRoot', id: 'b' }, { op: 'setVisible', id: 'g', visible: false }],
      regions: { a: [30, 62, 4, 4], b: [94, 62, 4, 4] },
      rules: [{ region: 'a', is: 'empty' }, { region: 'b', is: 'drawn' }],
    },
    {
      name: 'setVisible true on the group, a frame later: its child shows again',
      ops: [
        { op: 'createGroup', id: 'g' },
        { op: 'addRoot', id: 'g' },
        ...box('a', 30, [-30, 0, -80]),
        { op: 'addChild', parent: 'g', child: 'a' },
        ...box('b', 30, [30, 0, -80]),
        { op: 'addRoot', id: 'b' },
        { op: 'setVisible', id: 'g', visible: false },
        { op: 'render', capture: 'hidden' },
        { op: 'setVisible', id: 'g', visible: true },
      ],
      regions: { a: [30, 62, 4, 4], b: [94, 62, 4, 4] },
      rules: [
        // The group was hidden in the frame between: the child shows again, it was not always shown.
        { frame: 'hidden', region: 'a', is: 'empty' },
        { frame: 'hidden', region: 'b', is: 'drawn' },
        { region: 'a', is: 'drawn' },
        { region: 'b', is: 'drawn' },
        { region: 'a', is: 'same' },
      ],
    },
    {
      name: 'an object hidden before it is added to a group stays hidden (SceneHandle.addChild)',
      ops: [{ op: 'createGroup', id: 'g' }, { op: 'addRoot', id: 'g' }, ...box('a', 30, [-30, 0, -80]), { op: 'setVisible', id: 'a', visible: false }, { op: 'addChild', parent: 'g', child: 'a' }, ...box('b', 30, [30, 0, -80]), { op: 'addRoot', id: 'b' }],
      regions: { a: [30, 62, 4, 4], b: [94, 62, 4, 4] },
      rules: [{ region: 'a', is: 'empty' }, { region: 'b', is: 'drawn' }],
    },
    {
      name: "a child under its group's matrix (turned 90° about Z, moved): the same place and bounds",
      ops: [{ op: 'createGroup', id: 'g' }, { op: 'setMatrix', id: 'g', matrix: RZ90_AT_80 }, { op: 'addRoot', id: 'g' }, ...box('a', 20, [20, 0, 0]), { op: 'addChild', parent: 'g', child: 'a' }],
      // The child at x 20 in the group shows at y 20 once turned: above the centre, not to its right.
      regions: { turned: [62, 44, 4, 4], unturned: [80, 62, 4, 4] },
      rules: [{ region: 'turned', is: 'drawn' }, { region: 'unturned', is: 'empty' }, { region: 'turned', is: 'same' }, { bounds: 'a', min: [-10, 10, -90], max: [10, 30, -70] }],
    },
    {
      name: 'setColor with alpha 0.5, then 1: opaque again',
      ops: [
        ...box('a', 40, [0, 0, -80]),
        { op: 'addRoot', id: 'a' },
        // An opaque neighbour: the half-transparent frame is drawn, so its alpha cannot be a blank one.
        ...box('b', 30, [40, 0, -80]),
        { op: 'addRoot', id: 'b' },
        { op: 'setColor', id: 'a', color: [0.75, 0.5, 0.25, 0.5] },
        { op: 'render', capture: 'half' },
        { op: 'setColor', id: 'a', color: [0.75, 0.5, 0.25, 1] },
      ],
      regions: { centre: [60, 60, 8, 8], b: [104, 62, 4, 4] },
      rules: [
        // Alpha 0.5 took effect in the frame between: half opacity on both, then opaque again.
        { frame: 'half', region: 'b', is: 'drawn' },
        { frame: 'half', region: 'centre', is: 'alpha', value: 128 },
        { frame: 'half', region: 'centre', is: 'sameAlpha' },
        { region: 'centre', is: 'drawn' },
        { region: 'centre', is: 'same' },
      ],
    },
    {
      name: 'setColor with alpha 0.5 under a directional light: the same coverage',
      ops: [
        { op: 'createLight', id: 'sun', spec: { kind: 'directional', color: '#ffffff', intensity: 1 } },
        { op: 'addRoot', id: 'sun' },
        ...box('a', 40, [0, 0, -80]),
        { op: 'addRoot', id: 'a' },
        { op: 'setColor', id: 'a', color: [0.75, 0.5, 0.25, 0.5] },
        // An opaque neighbour: the frame is drawn, so a half-transparent alpha cannot be a blank one.
        ...box('b', 30, [40, 0, -80]),
        { op: 'addRoot', id: 'b' },
      ],
      regions: { centre: [60, 60, 8, 8], b: [104, 62, 4, 4] },
      // Premultiplied in the framebuffer on both: colour × alpha, alpha 128. Before #131 the lit colour differed
      // (Three.js 55, 36, 18 against Babylon.js 40, 28, 16).
      rules: [{ region: 'b', is: 'drawn' }, { region: 'centre', is: 'sameAlpha' }, { region: 'b', is: 'same' }, { region: 'centre', is: 'same' }],
    },
    {
      // #155: two half-transparent boxes, one in front of the other, overlapping at the centre. Over the clear canvas
      // the framebuffer's alpha is what the page lets through of the camera: 0.5 where one box covers it, and where both
      // do, 0.5 + 0.5 × (1 − 0.5) = 0.75 (192), Three.js's NormalBlending. An alpha channel that adds up gives 1.
      name: 'two overlapping boxes at alpha 0.5: alpha 0.75 where they overlap (#155)',
      ops: OVERLAP_OPS,
      regions: OVERLAP_REGIONS,
      rules: [
        { region: 'top', is: 'drawn' },
        { region: 'near', is: 'alpha', value: 128 },
        { region: 'far', is: 'alpha', value: 128 },
        { region: 'both', is: 'alpha', value: 192 },
        { region: 'both', is: 'sameAlpha' },
        { region: 'both', is: 'same' },
      ],
    },
    {
      // #155 on loaded models: the same layout with two glTF squares (alphaMode BLEND, alpha 0.5), whose materials the
      // loaders make, not the adapter. Flat squares, so sized for the regions: the far one (70 mm, 140 mm away) at
      // x 59..91 px, y 48..80; the near one (50 mm, 80 mm away) at x 32..72, y 44..84.
      name: 'two overlapping glTF squares at alpha 0.5: alpha 0.75 where they overlap (#155)',
      ops: [
        { op: 'loadModel', id: 'far', gltf: transparentSquareGltf(35, [0.25, 0.5, 0.75, 0.5], 1) },
        { op: 'setPosition', id: 'far', position: [25, 0, -140] },
        { op: 'addRoot', id: 'far' },
        { op: 'loadModel', id: 'near', gltf: transparentSquareGltf(25, [0.75, 0.5, 0.25, 0.5], 1) },
        { op: 'setPosition', id: 'near', position: [-15, 0, -80] },
        { op: 'addRoot', id: 'near' },
        { op: 'createPrimitive', id: 'top', spec: { shape: 'box', size: 20, color: '#808080' } },
        { op: 'setPosition', id: 'top', position: [0, 40, -80] },
        { op: 'addRoot', id: 'top' },
      ],
      regions: OVERLAP_REGIONS,
      rules: [
        { region: 'top', is: 'drawn' },
        { region: 'near', is: 'alpha', value: 128 },
        { region: 'far', is: 'alpha', value: 128 },
        { region: 'both', is: 'alpha', value: 192 },
        { region: 'both', is: 'sameAlpha' },
        { region: 'both', is: 'same' },
      ],
    },
    // #131: a coloured primitive under each light kind, and a light's colour and intensity set live. A light's colour
    // and the material's are sRGB on both (converted to linear on Babylon.js); Babylon.js takes k = 1 for a directional
    // light, 1/π for hemisphere and ambient. The box faces the camera; a hemisphere's sky (+Z) faces the box.
    ...(['directional', 'hemisphere', 'ambient'] as const).map(
      (kind): Case => ({
        name: `a coloured box under ${kind === 'ambient' ? 'an' : 'a'} ${kind} light: the same colour (#131)`,
        ops: [{ op: 'createLight', id: 'l', spec: { kind, color: '#ffffff', intensity: 1 } }, { op: 'addRoot', id: 'l' }, ...box('a', 40, [0, 0, -80], '#c08040'), { op: 'addRoot', id: 'a' }],
        regions: { centre: [60, 60, 8, 8] },
        rules: [{ region: 'centre', is: 'drawn' }, { region: 'centre', is: 'same' }],
      }),
    ),
    {
      name: "setColor and setIntensity on a light: the box's colour follows on both (#131)",
      ops: [
        { op: 'createLight', id: 'l', spec: { kind: 'directional', color: '#ffffff', intensity: 1 } },
        { op: 'addRoot', id: 'l' },
        ...box('a', 40, [0, 0, -80]),
        { op: 'addRoot', id: 'a' },
        { op: 'setColor', id: 'l', color: [1, 0.5, 0.25, 1] },
        { op: 'setIntensity', id: 'l', intensity: 2 },
      ],
      regions: { centre: [60, 60, 8, 8] },
      rules: [{ region: 'centre', is: 'drawn' }, { region: 'centre', is: 'same' }],
    },
    // #131: the pinball demos' scene (pinball-three, pinball-babylon): a torus knot under a directional light at 2.5 and
    // an ambient one at 0.6, in each demo's colour. Its tube slopes away from the camera, so the regions (one pixel row
    // each, inside the tube on rows 56, 64 and 72; the knot's transitions are in the createPrimitive case) see grazing
    // angles the boxes do not.
    ...(['#ff0055', '#3a8dff'] as const).map(
      (color): Case => ({
        name: `the pinball demos' torus knot (${color}) under their two lights: the same shading (#131)`,
        ops: [
          { op: 'createLight', id: 'sun', spec: { kind: 'directional', color: '#ffffff', intensity: 2.5 } },
          { op: 'addRoot', id: 'sun' },
          { op: 'createLight', id: 'amb', spec: { kind: 'ambient', color: '#ffffff', intensity: 0.6 } },
          { op: 'addRoot', id: 'amb' },
          { op: 'createPrimitive', id: 'k', spec: { shape: 'torusKnot', size: 40, color } },
          { op: 'setPosition', id: 'k', position: [0, 0, -80] },
          { op: 'addRoot', id: 'k' },
        ],
        regions: { r64a: [51, 64, 4, 1], r64b: [68, 64, 3, 1], r56: [65, 56, 6, 1], r72: [66, 72, 6, 1] },
        rules: (['r64a', 'r64b', 'r56', 'r72'] as const).flatMap((region): Rule[] => [
          { region, is: 'drawn' },
          { region, is: 'same' },
        ]),
      }),
    ),
    // #132: each core shape through createGeometry and createMesh, 80 mm away, its marker-space Z axis towards the
    // camera, unlit: the same silhouette on three rows (every lit / unlit transition: the torus's hole counts).
    ...(
      [
        { shape: 'box', width: 40, depth: 30, height: 20 },
        { shape: 'sphere', radius: 20, detail: 32 },
        { shape: 'cylinder', radiusTop: 10, radiusBottom: 20, height: 30, detail: 32 },
        { shape: 'plane', width: 40, depth: 30 },
        { shape: 'torus', radius: 15, tube: 5, detail: 32 },
        { shape: 'torusKnot', radius: 40 / 3, tube: 4, p: 2, q: 3, detail: 100 },
        { shape: 'capsule', radius: 10, height: 40, detail: 16 },
      ] as const
    ).map(
      (spec): Case => ({
        name: `createGeometry ${spec.shape} and createMesh, unlit: the same silhouette (#132)`,
        ops: [
          { op: 'createGeometry', id: 'g', spec },
          { op: 'createMesh', id: 'm', geometry: 'g' },
          { op: 'setPosition', id: 'm', position: [0, 0, -80] },
          { op: 'addRoot', id: 'm' },
        ],
        rules: [
          { row: 56, is: 'edges' },
          { row: 64, is: 'edges' },
          { row: 72, is: 'edges' },
        ],
      }),
    ),
    // #132: a mesh scaled to 0 on an axis is flat on both engines. scene.mesh writes each scale component at least
    // MIN_SCALE in magnitude (nonZeroScale): a 0 would make a singular matrix, which three's Matrix4.decompose turns
    // into scale 1 and no rotation, so Three.js would draw the full box where Babylon.js flattens it.
    ...(
      [
        ['[1, 1, 0]: flat, facing the camera', [1, 1, 0], 'drawn'],
        ['[0, 1, 1]: flat, a plane the camera sees from the side', [0, 1, 1], 'drawn'],
        ['[0, 0, 0]: nothing seen', [0, 0, 0], 'empty'],
      ] as const
    ).map(
      ([what, scale, seen]): Case => ({
        name: `a mesh scaled ${what}, as scene.mesh writes it (#132)`,
        ops: [
          { op: 'createGeometry', id: 'g', spec: { shape: 'box', width: 30, depth: 30, height: 30 } },
          { op: 'createMesh', id: 'm', geometry: 'g' },
          { op: 'setMatrix', id: 'm', matrix: transformMatrix({ position: [-25, 0, -80], rotation: [0, 0, 0], scale: scale.map(nonZeroScale) as V3 }) },
          { op: 'addRoot', id: 'm' },
          ...box('b', 30, [30, 0, -80]),
          { op: 'addRoot', id: 'b' },
        ],
        // The flattened box's region: its face at 64 + 64 · −25 / 80 = 44 px, or, edge-on, the plane at x = −25 mm.
        regions: { m: [42, 62, 3, 3], b: [94, 62, 4, 4] },
        rules: [
          { region: 'm', is: seen },
          { region: 'b', is: 'drawn' },
        ],
      }),
    ),
    // #132: a live geometry change grows a sphere from radius 10 to 25: a sample outside the small silhouette (about
    // 8 px from the centre) and inside the large one (about 21 px) is empty before setGeometry, drawn after, on both.
    // A growth, not a shrink: stale culling bounds would leave the new rim undrawn.
    {
      name: 'setGeometry grows a sphere on a running scene: its mesh follows, on the next frame (#132)',
      ops: [
        { op: 'createGeometry', id: 'g', spec: { shape: 'sphere', radius: 10, detail: 32 } },
        { op: 'createMesh', id: 'm', geometry: 'g' },
        { op: 'setPosition', id: 'm', position: [0, 0, -80] },
        { op: 'addRoot', id: 'm' },
        { op: 'render', capture: 'small' },
        { op: 'setGeometry', id: 'g', spec: { shape: 'sphere', radius: 25, detail: 32 } },
      ],
      regions: { centre: [62, 62, 4, 4], rim: [78, 62, 3, 3] },
      rules: [
        { frame: 'small', region: 'centre', is: 'drawn' },
        { frame: 'small', region: 'rim', is: 'empty' },
        { region: 'centre', is: 'drawn' },
        { region: 'rim', is: 'drawn' },
        { region: 'rim', is: 'sameAlpha' },
      ],
    },
    // #153: a half-transparent glTF material (alpha 0.5, roughness 0.3) under a directional light. Its highlight peaks
    // near pixel (77, 83), where the view ray reflects toward the light (0.2, −0.3, 1): `hl` samples it, and a 5 × 5
    // grid samples the rest of the square (pixels 40..88). A highlight must not raise the framebuffer's alpha. Without
    // the fix, Babylon.js gave 168 at the peak (the screenshot test below checks the highlight is there).
    {
      name: 'a half-transparent glTF material under a directional light: alpha 0.5 everywhere, highlight included (#153)',
      ops: GLTF_HIGHLIGHT_OPS,
      regions: {
        b: [104, 62, 4, 4],
        hl: [76, 82, 2, 2],
        ...Object.fromEntries([44, 54, 64, 74, 84].flatMap((x) => [44, 54, 64, 74, 84].map((y) => [`g${x}_${y}`, [x - 1, y - 1, 2, 2] as Region]))),
      },
      rules: [
        { region: 'b', is: 'drawn' },
        { region: 'hl', is: 'alpha', value: 128 },
        { region: 'hl', is: 'sameAlpha' },
        ...[44, 54, 64, 74, 84].flatMap((x) =>
          [44, 54, 64, 74, 84].flatMap((y): Rule[] => [
            { region: `g${x}_${y}`, is: 'alpha', value: 128 },
            { region: `g${x}_${y}`, is: 'sameAlpha' },
          ]),
        ),
      ],
    },

    // #133: materials and textures, as measured on both engines (docs/proposals/scene-nodes-equivalence.md, "Materials"
    // and "Textures"). A texture on a plane, unlit: the image the same way up, each wrap at repeat 2.
    {
      name: 'a texture on a plane, unlit: the same image the same way up (#133)',
      ops: [{ op: 'createTexture', id: 't', source: 'quadrants', spec: tex() }, { op: 'createMaterial', id: 'm', spec: mat(), map: 't' }, ...plane('p', 100, 100, [0, 0, -50], 'm')],
      regions: GRID,
      rules: [{ region: 'g0_0', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    ...(['clamp', 'repeat', 'mirror'] as const).map(
      (wrap): Case => ({
        name: `a texture repeated twice, wrap ${wrap}: the same (#133)`,
        ops: [{ op: 'createTexture', id: 't', source: 'quadrants', spec: tex(wrap, 2) }, { op: 'createMaterial', id: 'm', spec: mat(), map: 't' }, ...plane('p', 100, 100, [0, 0, -50], 'm')],
        regions: GRID,
        rules: [{ region: 'g0_0', is: 'drawn' }, ...sameEverywhere(GRID)],
      }),
    ),
    {
      // Minified and at a grazing angle: mipmaps, trilinear filtering and an sRGB buffer on both (#133: 27 levels apart
      // before Babylon.js's texture was decoded before filtering).
      name: 'a texture repeated 4 times on a tilted plane: the same where it is minified (#133)',
      ops: [{ op: 'createTexture', id: 't', source: 'quadrants', spec: tex('repeat', 4) }, { op: 'createMaterial', id: 'm', spec: mat(), map: 't' }, ...plane('p', 200, 400, rotX(-70, [0, 0, -80]), 'm')],
      regions: GRID,
      rules: [{ region: 'g3_7', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    {
      name: 'an unlit material tints its map, and has no emissive (#133)',
      ops: [
        { op: 'createTexture', id: 't', source: 'quadrants', spec: tex() },
        { op: 'createMaterial', id: 'a', spec: mat({ color: [0.75, 0.5, 0.25] }), map: 't' },
        { op: 'createMaterial', id: 'b', spec: mat({ color: [0.25, 0.25, 0.25], emissive: [0.75, 0.5, 0.25] }) },
        ...plane('l', 40, 40, [-25, 0, -50], 'a'),
        ...plane('r', 40, 40, [25, 0, -50], 'b'),
      ],
      regions: { ...LIVE_REGIONS, Ltop: [16, 16, 4, 4] },
      rules: [{ region: 'L', is: 'drawn' }, { region: 'R', is: 'drawn' }, { region: 'L', is: 'same' }, { region: 'Ltop', is: 'same' }, { region: 'R', is: 'same' }],
    },
    {
      name: 'emissive in the dark, and under a light (#133)',
      ops: [
        { op: 'createMaterial', id: 'a', spec: mat({ unlit: false, color: [0.2, 0.2, 0.2], emissive: [0.75, 0.5, 0.25] }) },
        { op: 'createMaterial', id: 'b', spec: mat({ unlit: false, color: [0.2, 0.2, 0.2], emissive: [0.75, 0.5, 0.25], emissiveIntensity: 0.5 }) },
        ...plane('l', 40, 40, [-25, 0, -50], 'a'),
        ...plane('r', 40, 40, [25, 0, -50], 'b'),
        { op: 'render', capture: 'dark' },
        ...SUN,
      ],
      regions: LIVE_REGIONS,
      rules: [
        { frame: 'dark', region: 'L', is: 'drawn' },
        { frame: 'dark', region: 'L', is: 'same' },
        { frame: 'dark', region: 'R', is: 'same' },
        { region: 'L', is: 'drawn' },
        { region: 'L', is: 'same' },
        { region: 'R', is: 'same' },
      ],
    },
    {
      name: 'metalness and roughness under one light, with a map (#133)',
      ops: [
        ...SUN,
        { op: 'createTexture', id: 't', source: 'quadrants', spec: tex() },
        { op: 'createMaterial', id: 'a', spec: mat({ unlit: false, color: [0.5, 0.5, 0.5], metalness: 1, roughness: 0.6 }) },
        { op: 'createMaterial', id: 'b', spec: mat({ unlit: false }), map: 't' },
        ...plane('l', 40, 40, [-25, 0, -50], 'a'),
        ...plane('r', 40, 40, [25, 0, -50], 'b'),
      ],
      regions: { ...LIVE_REGIONS, Rtop: [80, 16, 4, 4] },
      rules: [{ region: 'L', is: 'drawn' }, { region: 'L', is: 'same' }, { region: 'R', is: 'same' }, { region: 'Rtop', is: 'same' }],
    },
    {
      // One texture with alpha (its right half at 0.5) on an opaque and a half-transparent material: the opaque one stays
      // opaque, the transparent one multiplies its opacity by the map's alpha, as Three.js does (#133).
      name: "a map's alpha counts only on a transparent material, the texture shared by both (#133)",
      ops: [
        { op: 'createTexture', id: 't', source: 'alphaQuadrants', spec: tex() },
        { op: 'createMaterial', id: 'o', spec: mat(), map: 't' },
        { op: 'createMaterial', id: 'h', spec: mat({ opacity: 0.5 }), map: 't' },
        ...plane('l', 50, 100, [-25, 0, -50], 'o'),
        ...plane('r', 50, 100, [25, 0, -50], 'h'),
      ],
      regions: { opaqueLeft: [16, 60, 8, 8], opaqueRight: [44, 60, 4, 4], halfLeft: [76, 60, 4, 4], halfRight: [108, 60, 8, 8] },
      rules: [
        { region: 'opaqueLeft', is: 'drawn' },
        { region: 'opaqueRight', is: 'drawn' },
        { region: 'halfLeft', is: 'alpha', value: 128 },
        { region: 'halfRight', is: 'alpha', value: 64 },
        ...sameEverywhere({ opaqueLeft: [0, 0, 0, 0], opaqueRight: [0, 0, 0, 0], halfLeft: [0, 0, 0, 0], halfRight: [0, 0, 0, 0] }),
      ],
    },
    {
      name: 'side back shows a plane facing away, side front does not (#133)',
      ops: [
        { op: 'createMaterial', id: 'b', spec: mat({ color: [0.75, 0.5, 0.25], side: 'back' }) },
        { op: 'createMaterial', id: 'f', spec: mat({ color: [0.75, 0.5, 0.25] }) },
        ...plane('l', 40, 40, rotX(180, [-25, 0, -50]), 'b'),
        ...plane('r', 40, 40, rotX(180, [25, 0, -50]), 'f'),
      ],
      regions: LIVE_REGIONS,
      rules: [{ region: 'L', is: 'drawn' }, { region: 'R', is: 'empty' }, { region: 'L', is: 'same' }],
    },
    {
      // A closed box at 0.5 with both sides: its back faces show through its front ones (alpha 0.75 at the centre).
      name: 'a half-transparent box with both sides: alpha 0.75 through it (#133)',
      ops: [
        { op: 'createMaterial', id: 'm', spec: mat({ color: [0.75, 0.5, 0.25], side: 'double', opacity: 0.5 }) },
        { op: 'createGeometry', id: 'g', spec: { shape: 'box', width: 60, depth: 60, height: 60 } },
        { op: 'createMesh', id: 'box', geometry: 'g' },
        { op: 'setPosition', id: 'box', position: [0, 0, -100] },
        { op: 'addRoot', id: 'box' },
        { op: 'setMeshMaterial', mesh: 'box', material: 'm' },
        ...box('n', 10, [40, 40, -60]),
        { op: 'addRoot', id: 'n' },
      ],
      regions: { centre: [60, 60, 8, 8], n: [108, 16, 4, 4] },
      rules: [{ region: 'n', is: 'drawn' }, { region: 'centre', is: 'alpha', value: 192 }, { region: 'centre', is: 'same' }],
    },
    {
      // A mesh given a material, then its own back: its own colour (setColor) shows again; the other mesh keeps the
      // material, which that setColor did not touch.
      name: "setColor colours a mesh's own material, not the one it was given; null shows its own again (#133)",
      ops: [
        { op: 'createMaterial', id: 'm', spec: mat({ color: [0.75, 0.5, 0.25] }) },
        ...plane('l', 40, 40, [-25, 0, -50], 'm'),
        ...plane('r', 40, 40, [25, 0, -50], 'm'),
        { op: 'setColor', id: 'l', color: [0.25, 0.5, 0.75, 1] },
        { op: 'render', capture: 'shared' },
        { op: 'setMeshMaterial', mesh: 'l', material: null },
      ],
      regions: LIVE_REGIONS,
      rules: [
        { frame: 'shared', region: 'L', is: 'drawn' },
        { frame: 'shared', region: 'L', is: 'matches', other: 'R' },
        { region: 'L', is: 'drawn' },
        { region: 'L', is: 'same' },
        { region: 'R', is: 'same' },
      ],
    },
    // Live equals fresh (#133): L is made with one setup and changed live; R is made with the setup L ends with.
    ...(
      [
        ['side front to double, a plane facing away', { side: 'front' }, { side: 'double' }, true],
        ['opacity 1 to 0.5', { opacity: 1 }, { opacity: 0.5 }, false],
        ['opacity 0.5 to 1', { opacity: 0.5 }, { opacity: 1 }, true],
        ['lit to unlit, under a light', { unlit: false }, { unlit: true }, true],
        ['unlit to lit, under a light', { unlit: true }, { unlit: false }, true],
      ] as const
    ).map(
      ([what, from, to, opaque]): Case => ({
        name: `live equals fresh: ${what} (#133)`,
        ops: [
          ...SUN,
          { op: 'createMaterial', id: 'a', spec: mat({ color: [0.75, 0.5, 0.25], ...from }) },
          { op: 'createMaterial', id: 'b', spec: mat({ color: [0.75, 0.5, 0.25], ...to }) },
          ...plane('l', 40, 40, what.includes('facing away') ? rotX(180, [-25, 0, -50]) : [-25, 0, -50], 'a'),
          ...plane('r', 40, 40, what.includes('facing away') ? rotX(180, [25, 0, -50]) : [25, 0, -50], 'b'),
          { op: 'render' },
          { op: 'setMaterial', id: 'a', spec: mat({ color: [0.75, 0.5, 0.25], ...to }) },
          // An opaque neighbour, so a frame of two half-transparent planes is a drawn one.
          ...box('n', 10, [0, 40, -60]),
          { op: 'addRoot', id: 'n' },
        ],
        regions: { ...LIVE_REGIONS, n: [62, 16, 4, 4] },
        rules: [{ region: 'n', is: 'drawn' }, ...liveRules(opaque)],
      }),
    ),
    {
      name: 'live equals fresh: a map set, then taken away (#133)',
      ops: [
        { op: 'createTexture', id: 't', source: 'quadrants', spec: tex() },
        { op: 'createMaterial', id: 'a', spec: mat() },
        { op: 'createMaterial', id: 'b', spec: mat(), map: 't' },
        { op: 'createMaterial', id: 'c', spec: mat() },
        ...plane('l', 40, 40, [-25, 0, -50], 'a'),
        ...plane('r', 40, 40, [25, 0, -50], 'b'),
        { op: 'render' },
        { op: 'setMaterial', id: 'a', spec: mat(), map: 't' },
        { op: 'render', capture: 'mapped' },
        { op: 'setMaterial', id: 'a', spec: mat(), map: null },
        { op: 'setMeshMaterial', mesh: 'r', material: 'c' },
      ],
      regions: LIVE_REGIONS,
      rules: [{ frame: 'mapped', region: 'L', is: 'drawn' }, { frame: 'mapped', region: 'L', is: 'matches', other: 'R' }, ...liveRules()],
    },
    {
      name: 'live equals fresh: wrap repeat to mirror, repeat 2 (#133)',
      ops: [
        { op: 'createTexture', id: 'tl', source: 'quadrants', spec: tex('repeat', 2) },
        { op: 'createTexture', id: 'tr', source: 'quadrants', spec: tex('mirror', 2) },
        { op: 'createMaterial', id: 'a', spec: mat(), map: 'tl' },
        { op: 'createMaterial', id: 'b', spec: mat(), map: 'tr' },
        ...plane('l', 40, 40, [-25, 0, -50], 'a'),
        ...plane('r', 40, 40, [25, 0, -50], 'b'),
        { op: 'render' },
        { op: 'setTexture', id: 'tl', spec: tex('mirror', 2) },
      ],
      regions: { L: [24, 44, 4, 4], R: [88, 44, 4, 4], L2: [44, 70, 4, 4], R2: [108, 70, 4, 4] },
      rules: [...liveRules(), { region: 'L2', is: 'matches', other: 'R2' }],
    },
    // #133: a texture on the other shapes, the same on both engines since #162 builds Babylon.js's shapes from
    // Three.js's generators (before, only the plane matched: tests/unit/conformance/geometry-uvs.test.ts).
    ...(
      [
        ['box', { shape: 'box', width: 60, depth: 60, height: 60 }, [0, 0, -120], null, { c: [62, 62, 4, 4], a: [50, 50, 4, 4], b: [74, 74, 4, 4] }],
        ['sphere', { shape: 'sphere', radius: 45, detail: 64 }, [0, 0, -100], null, { c: [62, 62, 4, 4], a: [50, 50, 4, 4], b: [74, 74, 4, 4] }],
        ['cylinder, its top', { shape: 'cylinder', radiusTop: 40, radiusBottom: 40, height: 20, detail: 64 }, [0, 0, -100], null, { c: [62, 62, 4, 4], a: [50, 76, 4, 4], b: [76, 50, 4, 4] }],
        ['cylinder, its side', { shape: 'cylinder', radiusTop: 40, radiusBottom: 40, height: 80, detail: 64 }, null, rotX(-90, [0, 0, -130]), { c: [62, 62, 4, 4], a: [54, 50, 4, 4], b: [70, 74, 4, 4] }],
        ['torus', { shape: 'torus', radius: 35, tube: 15, detail: 64 }, [0, 0, -110], null, { c: [84, 62, 4, 4], a: [40, 62, 4, 4], b: [62, 40, 4, 4] }],
        ['capsule, its side', { shape: 'capsule', radius: 30, height: 100, detail: 64 }, null, rotX(-90, [0, 0, -130]), { c: [62, 62, 4, 4], a: [56, 46, 4, 4], b: [68, 78, 4, 4] }],
      ] as const
    ).map(
      ([what, spec, at, matrix, regions]): Case => ({
        name: `a texture on a ${what}, unlit (#133)`,
        ops: [
          { op: 'createTexture', id: 't', source: 'quadrants', spec: tex() },
          { op: 'createMaterial', id: 'm', spec: mat(), map: 't' },
          { op: 'createGeometry', id: 'g', spec: spec as never },
          { op: 'createMesh', id: 'shape', geometry: 'g' },
          matrix ? { op: 'setMatrix', id: 'shape', matrix: [...matrix] } : { op: 'setPosition', id: 'shape', position: at as unknown as V3 },
          { op: 'addRoot', id: 'shape' },
          { op: 'setMeshMaterial', mesh: 'shape', material: 'm' },
        ],
        regions: regions as unknown as Record<string, Region>,
        rules: [
          { region: 'c', is: 'drawn' },
          { region: 'a', is: 'drawn' },
          { region: 'b', is: 'drawn' },
          { region: 'c', is: 'same' },
          { region: 'a', is: 'same' },
          { region: 'b', is: 'same' },
        ],
      }),
    ),

    // #134: shadows on the catcher, where they fall and how dark, on both engines.
    ...(
      [
        ['a directional light', SIDE_SUN],
        ['a spot light', SIDE_SPOT],
      ] as const
    ).map(
      ([what, spec]): Case => ({
        name: `${what}: a cube's shadow on the catcher, in the same place on both (#134)`,
        ops: [...LIT_OPS, ...lightOps(spec), ...catcherOps(), ...STANDING_CUBE],
        regions: SHADOW_REGIONS,
        rules: shadowRules(),
      }),
    ),
    {
      name: 'a hidden caster casts nothing (#134)',
      ops: [...LIT_OPS, ...lightOps(SIDE_SUN), ...catcherOps(), ...STANDING_CUBE, { op: 'setVisible', id: 'cube', visible: false }, ...meshOps('n', { shape: 'box', width: 20, depth: 20, height: 20 }, [0, 60, -150])],
      regions: { ...SHADOW_REGIONS, N: [62, 38, 4, 4] },
      rules: [{ region: 'N', is: 'drawn' }, { region: 'S', is: 'empty' }, { region: 'C', is: 'empty' }, { region: 'N', is: 'same' }],
    },
    {
      // Measured: a single-sided plane facing the light casts nothing, on both engines.
      name: 'a single-sided plane facing the light casts no shadow, on both (#134)',
      ops: [...LIT_OPS, ...lightOps({ ...SIDE_SUN, position: [0, 0, 100], target: [0, 0, -200] }), ...catcherOps(), ...meshOps('p', { shape: 'plane', width: 60, depth: 60 }, [0, 0, -150], true)],
      regions: { P: [62, 62, 4, 4], below: [62, 30, 4, 4] },
      rules: [{ region: 'P', is: 'drawn' }, { region: 'below', is: 'empty' }, { region: 'P', is: 'same' }],
    },
    {
      // A mesh that casts and receives: no shadow acne on its lit faces, the same on both (the bias translated: Babylon.js
      // adds its own to the caster's depth, Three.js to the receiver's).
      name: 'a cube that casts and receives, over a floor that does too: no acne, the same on both (#134)',
      ops: [...LIT_OPS, ...lightOps(SIDE_SUN), ...meshOps('floor', { shape: 'plane', width: 300, depth: 300 }, [0, 0, -200], true, true), ...meshOps('cube', { shape: 'box', width: 50, depth: 50, height: 50 }, [40, 0, -175], true, true)],
      regions: GRID,
      rules: [{ region: 'g4_3', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    {
      name: 'a sphere that casts and receives, under a spot: its own shadow the same on both (#134)',
      ops: [...LIT_OPS, ...lightOps({ ...SIDE_SPOT, position: [100, 100, -60], target: [0, 0, -200] }), ...meshOps('s', { shape: 'sphere', radius: 50, detail: 64 }, [0, 0, -200], true, true)],
      regions: GRID,
      rules: [{ region: 'g3_3', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    {
      // An unlit receiver shows no shadow on either engine (Three.js's MeshBasicMaterial has no lighting at all).
      name: 'an unlit mesh shows no shadow, on both (#134)',
      ops: [{ op: 'createMaterial', id: 'u', spec: mat({ unlit: true, color: [0.7, 0.7, 0.7] }) }, ...LIT_OPS, ...lightOps(SIDE_SUN), ...meshOps('floor', { shape: 'plane', width: 300, depth: 300 }, [0, 0, -200], false, true, 'u'), ...STANDING_CUBE],
      regions: SHADOW_REGIONS,
      rules: [{ region: 'S', is: 'drawn' }, { region: 'S', is: 'same' }, { region: 'O', is: 'same' }],
    },
    {
      name: 'a point light, no distance and distance 150: the same falloff on both (#134)',
      ops: [
        ...LIT_OPS,
        ...lightOps({ kind: 'point', color: '#ffffff', intensity: 0.02, position: [-100, 0, 0] }, 'p1'),
        ...lightOps({ kind: 'point', color: '#ffffff', intensity: 0.02, position: [100, 0, 0], distance: 150 }, 'p2'),
        ...meshOps('floor', { shape: 'plane', width: 600, depth: 600 }, [0, 0, -100]),
      ],
      regions: GRID,
      rules: [{ region: 'g3_3', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    {
      // Babylon.js's materials take 4 lights by default; the adapter's take 16, as Three.js's take every light.
      name: 'five point lights at once: all of them light the floor, the same on both (#134)',
      ops: [
        ...LIT_OPS,
        ...([[-60, -60], [60, -60], [-60, 60], [60, 60], [0, 0]] as const).flatMap(([x, y], i) => lightOps({ kind: 'point', color: '#ffffff', intensity: 0.004, position: [x, y, -150] }, `p${i}`)),
        ...meshOps('floor', { shape: 'plane', width: 300, depth: 300 }, [0, 0, -200]),
      ],
      regions: GRID,
      rules: [{ region: 'g3_3', is: 'drawn' }, ...sameEverywhere(GRID)],
    },
    {
      // A hard cone (penumbra 0): its edge where the red channel crosses 64, the same within 1 px on both.
      name: 'a spot, hard cone: the same edges on both (#134)',
      ops: [...LIT_OPS, ...lightOps({ kind: 'spot', color: '#ffffff', intensity: 0.08, position: [0, 0, 0], target: [0, 0, -200], angle: 15 }), ...meshOps('floor', { shape: 'plane', width: 600, depth: 600 }, [0, 0, -200])],
      regions: { c: [62, 62, 4, 4] },
      rules: [{ region: 'c', is: 'drawn' }, { region: 'c', is: 'same' }, { row: 64, is: 'edges', channel: 0, threshold: 64 }, { row: 56, is: 'edges', channel: 0, threshold: 64 }],
    },
    {
      // A spot on a group turned 90° about Z: it follows its parent on both.
      name: 'a spot under a turned group follows it, the same on both (#134)',
      ops: [
        ...LIT_OPS,
        { op: 'createGroup', id: 'grp' },
        { op: 'setMatrix', id: 'grp', matrix: RZ90_AT_80 },
        { op: 'addRoot', id: 'grp' },
        { op: 'createLight', id: 'l', spec: { kind: 'spot', color: '#ffffff', intensity: 0.08, position: [60, 0, 100], target: [60, 0, -100], angle: 15 } },
        { op: 'addChild', parent: 'grp', child: 'l' },
        ...meshOps('floor', { shape: 'plane', width: 600, depth: 600 }, [0, 0, -200]),
      ],
      regions: GRID,
      rules: [{ region: 'g3_3', is: 'drawn' }, ...sameEverywhere(GRID), { row: 40, is: 'edges', channel: 0, threshold: 64 }],
    },
  ];

  const FINAL = 'final';
  const frameOf = (r: Rule) => r.frame ?? FINAL;
  interface Shot {
    regions: Record<string, number[]>;
    /** By `<row>/<channel>`. */
    rows: Record<string, number[]>;
    bounds: Record<string, { min: V3; max: V3 }>;
  }
  /** One engine's frames, by name: FINAL and each capture. */
  type Shots = Record<string, Shot>;
  const measure = (page: Page, c: Case) => {
    // What each frame reads: every region; the rows and bounds its rules name.
    const needs: Record<string, { rows: Array<[number, number]>; ids: string[] }> = {};
    for (const r of [...c.rules, ...(c.known?.rules ?? [])]) {
      const n = (needs[frameOf(r)] ??= { rows: [], ids: [] });
      if ('row' in r) n.rows.push([r.row, r.channel ?? 3]);
      if ('bounds' in r) n.ids.push(r.bounds);
    }
    return onBoth(
      page,
      128,
      () =>
        page.evaluate(
          async ([ops, regions, needs, final]) => {
            const H = (window as never as { H: Harness }).H;
            const out: Record<string, Shot> = {};
            const read = (frame: string) => {
              const shot: Shot = { regions: {}, rows: {}, bounds: {} };
              for (const [k, [x, y, w, h]] of Object.entries(regions)) shot.regions[k] = H.region(x, y, w, h);
              for (const [y, c] of needs[frame]?.rows ?? []) shot.rows[`${y}/${c}`] = H.channelRow(y, c);
              for (const id of needs[frame]?.ids ?? []) shot.bounds[id] = H.adapterBounds(id);
              out[frame] = shot;
            };
            await H.buildAdapterScene(ops, read);
            H.render();
            read(final);
            return out;
          },
          [c.ops, c.regions ?? {}, needs, FINAL] as const,
        ),
    );
  };

  /** Where the row turns lit (alpha > 128) or unlit: the first pixel after the change, the row's length if it ends lit. */
  const transitionsOf = (row: number[], threshold = 128) => {
    const out: number[] = [];
    for (let i = 0; i <= row.length; i++) if ((i < row.length && row[i] > threshold) !== (i > 0 && row[i - 1] > threshold)) out.push(i);
    return out;
  };
  function check(all: Record<Engine, Shots>, rule: Rule) {
    const frame = frameOf(rule);
    const r = { three: all.three[frame], babylon: all.babylon[frame] };
    for (const engine of ENGINES) expect(r[engine], `${engine}: frame "${frame}" was read`).toBeDefined();
    const at = frame === FINAL ? '' : ` (frame "${frame}")`;
    if ('row' in rule) {
      const key = `${rule.row}/${rule.channel ?? 3}`;
      const t = transitionsOf(r.three.rows[key], rule.threshold);
      const b = transitionsOf(r.babylon.rows[key], rule.threshold);
      const msg = `row ${rule.row}${at} transitions: three ${t} / babylon ${b}`;
      expect(t.length, `${msg}: something drawn on Three.js`).toBeGreaterThan(0);
      expect(b.length, `${msg}: something drawn on Babylon.js`).toBeGreaterThan(0);
      expect(b.length, msg).toBe(t.length);
      expect(Math.max(...t.map((x, i) => Math.abs(x - b[i]))), msg).toBeLessThanOrEqual(EDGE);
    } else if ('bounds' in rule) {
      for (const engine of ENGINES) {
        const got = r[engine].bounds[rule.bounds];
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(got.min[i] - rule.min[i]), `${engine} ${rule.bounds} min[${i}] ${got.min[i]}`).toBeLessThanOrEqual(GEOMETRY);
          expect(Math.abs(got.max[i] - rule.max[i]), `${engine} ${rule.bounds} max[${i}] ${got.max[i]}`).toBeLessThanOrEqual(GEOMETRY);
        }
      }
    } else {
      const t = r.three.regions[rule.region];
      const b = r.babylon.regions[rule.region];
      if (rule.is === 'drawn' || rule.is === 'empty' || rule.is === 'alpha') {
        const value = rule.is === 'alpha' ? rule.value : 0;
        for (const engine of ENGINES) {
          const a = r[engine].regions[rule.region][3];
          const msg = `${engine} ${rule.region}${at} alpha ${a}`;
          if (rule.is === 'drawn') expect(a, msg).toBeGreaterThanOrEqual(250);
          else if (rule.is === 'empty') expect(a, msg).toBeLessThanOrEqual(2);
          else expect(Math.abs(a - value), `${msg}, expected ${value}`).toBeLessThanOrEqual(SAME);
        }
      } else if (rule.is === 'matches') {
        for (const engine of ENGINES) {
          const [x, y] = [r[engine].regions[rule.region], r[engine].regions[rule.other]];
          expect(Math.max(maxDiff(x, y), Math.abs(x[3] - y[3])), `${engine} ${rule.region} / ${rule.other}${at}: ${x} / ${y}`).toBeLessThanOrEqual(SAME);
        }
      } else if (rule.is === 'sameAlpha') expect(Math.abs(b[3] - t[3]), `${rule.region}${at} alpha: ${t[3]} / ${b[3]}`).toBeLessThanOrEqual(SAME);
      else expect(Math.max(maxDiff(b, t), Math.abs(b[3] - t[3])), `${rule.region}${at}: ${t} / ${b}`).toBeLessThanOrEqual(SAME);
    }
  }

  for (const c of CASES) {
    // Every frame a case reads must see something drawn, or a blank frame (alpha 0 on both) would pass its `same`,
    // `sameAlpha` and `empty` rules. A capture no rule reads, or a rule on a frame never captured, is a mistake too.
    const captures = c.ops.flatMap((o) => (o.op === 'render' && o.capture !== undefined ? [o.capture] : []));
    if (new Set(captures).size !== captures.length || captures.includes(FINAL)) throw new Error(`case "${c.name}": captures must be unique and not "${FINAL}"`);
    for (const frame of [FINAL, ...captures]) {
      const kinds = new Set<string>(c.rules.filter((r) => frameOf(r) === frame).map((r) => ('row' in r ? 'edges' : 'bounds' in r ? 'bounds' : r.is)));
      if (!['drawn', 'edges', 'bounds'].some((k) => kinds.has(k))) throw new Error(`case "${c.name}", frame "${frame}": no drawn, edges or bounds rule`);
      if (kinds.has('empty') && !kinds.has('drawn')) throw new Error(`case "${c.name}", frame "${frame}": an empty rule needs a drawn one in the same frame`);
    }
    for (const r of [...c.rules, ...(c.known?.rules ?? [])])
      if (frameOf(r) !== FINAL && !captures.includes(frameOf(r))) throw new Error(`case "${c.name}": no render captures frame "${frameOf(r)}"`);
    test(c.known ? `pinned: ${c.name}` : c.name, async ({ page }) => {
      const r = await measure(page, c);
      console.log('scene handle', c.name, JSON.stringify(r.three), JSON.stringify(r.babylon));
      for (const rule of c.rules) check(r, rule);
      if (c.known)
        for (const engine of ENGINES)
          for (const [k, v] of Object.entries(c.known.pinned[engine]))
            expect(Math.max(...r[engine][FINAL].regions[k].map((x, i) => Math.abs(x - v[i]))), `${engine} ${k} ${r[engine][FINAL].regions[k]}`).toBeLessThanOrEqual(1);
    });
    if (c.known) {
      const known = c.known;
      test(`known difference (${known.issue}): ${c.name}`, async ({ page }) => {
        test.fail(true, known.why);
        const r = await measure(page, c);
        for (const rule of known.rules) check(r, rule);
      });
    }
  }
});

test.describe('conformance: materials (MeshStandardMaterial against PBRMaterial, exact sRGB, k = 1)', () => {
  // A plane turned 45° about X and a light 45° from its normal on the other side: the mirror direction, and so the
  // highlight, falls at the centre of the view. Two regions, each with its own intensity so that it lands unclipped.
  const scene = (color: string, metalness: number, roughness: number, I: number): SceneDesc => ({
    size: 128,
    objects: [{ shape: 'plane', size: 160, position: [0, 0, -60], rotation: [45, 0, 0], material: { kind: 'pbr', color, metalness, roughness } }],
    lights: [{ kind: 'directional', intensity: I, direction: [0, 1, 0], position: [0, 0, -60] }],
  });
  const REGIONS = { highlight: [60, 60, 8, 8], diffuse: [60, 16, 8, 8] } as const;
  type Region = keyof typeof REGIONS;
  /** Measured; 'look' where the residual exceeds SAME (8/255 at most), with the residual in the report. */
  const GRID: Array<{ color: string; metalness: number; roughness: number; expect: Record<Region, 'same' | 'look' | 'rejected'> }> = [
    { color: '#808080', metalness: 0, roughness: 0.2, expect: { highlight: 'look', diffuse: 'same' } },
    { color: '#808080', metalness: 0, roughness: 0.6, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#808080', metalness: 0, roughness: 1, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#808080', metalness: 1, roughness: 0.2, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#808080', metalness: 1, roughness: 0.6, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#808080', metalness: 1, roughness: 1, expect: { highlight: 'same', diffuse: 'look' } },
    { color: '#c04040', metalness: 0, roughness: 0.2, expect: { highlight: 'look', diffuse: 'same' } },
    { color: '#c04040', metalness: 0, roughness: 0.6, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#c04040', metalness: 0, roughness: 1, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#c04040', metalness: 1, roughness: 0.2, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#c04040', metalness: 1, roughness: 0.6, expect: { highlight: 'same', diffuse: 'same' } },
    { color: '#c04040', metalness: 1, roughness: 1, expect: { highlight: 'look', diffuse: 'look' } },
  ];

  async function sample(page: Page, desc: SceneDesc, region: Region) {
    return (await shoot(page, desc, { v: REGIONS[region] as unknown as [number, number, number, number] })).v;
  }

  for (const c of GRID) {
    for (const region of ['highlight', 'diffuse'] as const) {
      test(`${c.color}, metalness ${c.metalness}, roughness ${c.roughness}: ${region} (${c.expect[region]})`, async ({ page }) => {
        // The intensity that puts Three.js's brightest channel near sRGB 128, found on Three.js (linear in I).
        await open(page, 'three', 128);
        let I = 1;
        let three = await sample(page, scene(c.color, c.metalness, c.roughness, I), region);
        for (let i = 0; i < 4 && !(Math.max(...rgb(three)) >= 110 && Math.max(...rgb(three)) <= 150); i++) {
          const top = Math.max(...rgb(three));
          I *= top >= 250 ? 1 / 8 : top <= 2 ? 64 : 0.216 / toLinear(top);
          three = await sample(page, scene(c.color, c.metalness, c.roughness, I), region);
        }
        await open(page, 'babylon', 128, true);
        const babylon = await sample(page, scene(c.color, c.metalness, c.roughness, I), region);
        const residual = maxDiff(babylon, three);
        console.log('material', c.color, c.metalness, c.roughness, region, `I ${I.toFixed(3)}`, rgb(three), rgb(babylon), residual);
        // The clipping rule on the brightest channel: a darker channel of a saturated colour is reported, not judged.
        const usable = Math.max(...rgb(three)) >= 30 && Math.max(...rgb(three)) <= 225;
        if (c.expect[region] === 'rejected') return void expect(usable).toBe(false);
        expect(usable, `three ${rgb(three)}`).toBe(true);
        const channels = [0, 1, 2].filter((k) => three[k] >= 30 && three[k] <= 225);
        const judged = Math.max(...channels.map((k) => Math.abs(babylon[k] - three[k])));
        if (c.expect[region] === 'same') expect(judged).toBeLessThanOrEqual(SAME);
        else {
          expect(judged).toBeGreaterThan(SAME);
          expect(judged).toBeLessThanOrEqual(LOOK);
        }
      });
    }
  }

  test('side: back and double show a plane facing away on both', async ({ page }) => {
    for (const side of ['back', 'double'] as const) {
      const desc: SceneDesc = { size: 128, objects: [{ ...FILL, rotation: [0, 180, 0], material: { kind: 'basic', color: '#ffffff', side } }], lights: [] };
      const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
      for (const engine of ENGINES) expect(r[engine].c[3], `${engine} ${side}`).toBe(255);
    }
  });

  test('double side: a back face lit from behind is lit on Three.js; Babylon.js needs twoSidedLighting', async ({ page }) => {
    // The plane faces away (its back towards the camera); the light comes from the camera's side.
    const desc = (twoSidedLighting: boolean): SceneDesc => ({
      size: 128,
      objects: [{ ...FILL, rotation: [0, 180, 0], material: { kind: 'pbr', color: '#808080', side: 'double', noSpecular: true, twoSidedLighting } }],
      lights: [{ kind: 'directional', intensity: 3, direction: D45 }],
    });
    const plain = await onBoth(page, 128, () => shoot(page, desc(false), { c: CENTRE }));
    await open(page, 'babylon', 128, true);
    const twoSided = await shoot(page, desc(true), { c: CENTRE });
    console.log('double side', rgb(plain.three.c), rgb(plain.babylon.c), rgb(twoSided.c));
    expect(unclipped(plain.three.c)).toBe(true);
    expect(maxDiff(plain.babylon.c, plain.three.c)).toBeGreaterThan(LOOK);
    expect(maxDiff(twoSided.c, plain.three.c)).toBeLessThanOrEqual(SAME);
  });
});

test.describe('conformance: opacity over the camera (framebuffer RGBA, then the page)', () => {
  // The canvas is composited over the camera video. Both engines' framebuffers hold colour × alpha, and both contexts
  // are premultiplied (the Babylon.js adapter's since #144; before, the page multiplied by alpha a second time). A
  // half-transparent unlit plane of #c08040 over a clear canvas, then over a #4080c0 element.
  const BG = [0x40, 0x80, 0xc0];
  const desc: SceneDesc = { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#c08040', opacity: 0.5 } }], lights: [] };
  /** The page's composite of a framebuffer pixel from a premultiplied context (both, checked by the calibration). */
  const composite = (px: number[]) => {
    const a = px[3] / 255;
    return [0, 1, 2].map((k) => px[k] + BG[k] * (1 - a));
  };

  async function screenshotCentre(page: Page) {
    await page.evaluate((bg) => {
      const back = document.createElement('div');
      back.style.cssText = `position:absolute;left:0;top:0;width:128px;height:128px;background:rgb(${bg.join(',')})`;
      document.body.prepend(back);
      const canvas = document.querySelector('canvas')!;
      canvas.style.zIndex = '1';
    }, BG);
    await page.evaluate(() => (window as never as { H: Harness }).H.render());
    const png = await page.screenshot({ clip: { x: 60, y: 60, width: 8, height: 8 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 8, 8).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
      return sum.map((v) => v / 64);
    }, png.toString('base64'));
  }

  const measure = async (page: Page) => {
    const out = {} as Record<Engine, { framebuffer: number[]; computed: number[]; screen: number[] }>;
    for (const engine of ENGINES) {
      await open(page, engine, 128, true);
      const framebuffer = (await shoot(page, desc, { c: CENTRE })).c;
      const computed = composite(framebuffer);
      const screen = await screenshotCentre(page);
      out[engine] = { framebuffer, computed, screen };
    }
    console.log('opacity', JSON.stringify(out));
    return out;
  };

  test('pinned: the framebuffer, the computed composite and the screenshot agree, per engine', async ({ page }) => {
    const r = await measure(page);
    for (const engine of ENGINES) {
      expect(r[engine].framebuffer[3], engine).toBeCloseTo(128, -1);
      expect(maxDiff(r[engine].screen, r[engine].computed), `${engine} screen ${rgb(r[engine].screen)} computed ${r[engine].computed}`).toBeLessThanOrEqual(SAME);
    }
    // 0.5 · #c08040 + 0.5 · #4080c0 in sRGB values, as the page blends.
    for (const engine of ENGINES) expect(maxDiff(r[engine].screen, [128, 128, 128]), `${engine} ${rgb(r[engine].screen)}`).toBeLessThanOrEqual(SAME);
  });

  test('a half-transparent object looks the same over the camera on both adapters (#144)', async ({ page }) => {
    const r = await measure(page);
    expect(maxDiff(r.babylon.screen, r.three.screen)).toBeLessThanOrEqual(SAME);
  });

  // #155: two overlapping half-transparent boxes (OVERLAP_OPS) over the page. Where both cover it, a quarter of the
  // background shows through on Three.js (framebuffer alpha 0.75); the page composites the framebuffer as premultiplied.
  test('two overlapping half-transparent objects let the same camera through on both adapters (#155)', async ({ page }) => {
    const out = {} as Record<Engine, Record<string, { framebuffer: number[]; screen: number[] }>>;
    for (const engine of ENGINES) {
      await open(page, engine, 128);
      const framebuffer = await page.evaluate(
        async ([ops, regions]) => {
          const H = (window as never as { H: Harness }).H;
          await H.buildAdapterScene(ops);
          H.render();
          return Object.fromEntries(Object.entries(regions).map(([k, [x, y, w, h]]) => [k, H.region(x, y, w, h)]));
        },
        [OVERLAP_OPS, OVERLAP_REGIONS] as const,
      );
      await page.evaluate((bg) => {
        const back = document.createElement('div');
        back.style.cssText = `position:absolute;left:0;top:0;width:128px;height:128px;background:rgb(${bg.join(',')})`;
        document.body.prepend(back);
        document.querySelector('canvas')!.style.zIndex = '1';
      }, BG);
      await page.evaluate(() => (window as never as { H: Harness }).H.render());
      out[engine] = {};
      for (const k of ['near', 'both', 'far']) {
        const [x, y, w, h] = OVERLAP_REGIONS[k];
        const png = await page.screenshot({ clip: { x, y, width: w, height: h } });
        const screen = await page.evaluate(
          async ([b64, n]) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, img.width, img.height).data;
            const sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) for (let q = 0; q < 3; q++) sum[q] += d[i + q];
            return sum.map((v) => v / n);
          },
          [png.toString('base64'), w * h] as const,
        );
        out[engine][k] = { framebuffer: framebuffer[k], screen };
      }
    }
    console.log('overlap opacity', JSON.stringify(out));
    for (const engine of ENGINES) {
      // The control: one box alone lets half the background through on both, as #144 left it.
      for (const k of ['near', 'far']) expect(Math.abs(out[engine][k].framebuffer[3] - 128), `${engine} ${k} alpha ${out[engine][k].framebuffer}`).toBeLessThanOrEqual(SAME);
      // The page composites what the framebuffer holds, on each engine.
      for (const k of ['near', 'both', 'far']) {
        const { framebuffer, screen } = out[engine][k];
        expect(maxDiff(screen, composite(framebuffer)), `${engine} ${k} screen ${rgb(screen)} computed ${composite(framebuffer)}`).toBeLessThanOrEqual(SAME);
      }
    }
    for (const k of ['near', 'both', 'far']) {
      expect(maxDiff(out.babylon[k].screen, out.three[k].screen), `${k} screen: three ${rgb(out.three[k].screen)} / babylon ${rgb(out.babylon[k].screen)}`).toBeLessThanOrEqual(SAME);
    }
  });

  // #153: a half-transparent glTF material under a directional light (GLTF_HIGHLIGHT_OPS), over the page: its
  // highlight, near pixel (77, 83), and a region away from it. Framebuffer alpha and the page's composite, both engines.
  test('a half-transparent glTF material over the camera: the same at its highlight on both adapters (#153)', async ({ page }) => {
    const spots = { highlight: [75, 81, 4, 4], away: [44, 44, 4, 4] } as const;
    const out = {} as Record<Engine, Record<string, { framebuffer: number[]; screen: number[] }>>;
    for (const engine of ENGINES) {
      await open(page, engine, 128);
      const framebuffer = await page.evaluate(
        async ([ops, spots]) => {
          const H = (window as never as { H: Harness }).H;
          await H.buildAdapterScene(ops);
          H.render();
          return Object.fromEntries(Object.entries(spots).map(([k, [x, y, w, h]]) => [k, H.region(x, y, w, h)]));
        },
        [GLTF_HIGHLIGHT_OPS, spots] as const,
      );
      await page.evaluate((bg) => {
        const back = document.createElement('div');
        back.style.cssText = `position:absolute;left:0;top:0;width:128px;height:128px;background:rgb(${bg.join(',')})`;
        document.body.prepend(back);
        document.querySelector('canvas')!.style.zIndex = '1';
      }, BG);
      await page.evaluate(() => (window as never as { H: Harness }).H.render());
      out[engine] = {};
      for (const [k, [x, y, w, h]] of Object.entries(spots)) {
        const png = await page.screenshot({ clip: { x, y, width: w, height: h } });
        const screen = await page.evaluate(
          async ([b64, n]) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, img.width, img.height).data;
            const sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) for (let q = 0; q < 3; q++) sum[q] += d[i + q];
            return sum.map((v) => v / n);
          },
          [png.toString('base64'), w * h] as const,
        );
        out[engine][k] = { framebuffer: framebuffer[k], screen };
      }
    }
    console.log('gltf opacity', JSON.stringify(out));
    // A control: the highlight is there, brighter than the square away from it, on both engines; a case without one
    // would pass whatever the over-alpha flags do.
    for (const engine of ENGINES) expect(out[engine].highlight.framebuffer[0] - out[engine].away.framebuffer[0], `${engine} highlight brighter`).toBeGreaterThan(20);
    for (const k of Object.keys(spots)) {
      for (const engine of ENGINES) expect(Math.abs(out[engine][k].framebuffer[3] - 128), `${engine} ${k} alpha ${out[engine][k].framebuffer}`).toBeLessThanOrEqual(SAME);
      expect(maxDiff(out.babylon[k].screen, out.three[k].screen), `${k} screen: three ${rgb(out.three[k].screen)} / babylon ${rgb(out.babylon[k].screen)}`).toBeLessThanOrEqual(SAME);
    }
  });
});

test.describe('conformance: a video texture through the adapters (#133)', () => {
  // The harness's video is a canvas stream painted #c08040, then #4080c0: a texture stuck on its first frame shows. The
  // source node owns the element (source.videoFile): the texture leaves its loop, autoplay and mute alone, and neither a
  // mesh's release nor the scene's teardown pauses it.
  test('a video texture plays, the same on both engines, and leaves its video playing', async ({ page }) => {
    const ops: AdapterOp[] = [
      { op: 'createTexture', id: 't', source: 'video', spec: { wrap: 'repeat', repeatU: 1, repeatV: 1 } },
      { op: 'createMaterial', id: 'm', spec: { color: [1, 1, 1], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 1, side: 'front', unlit: true }, map: 't' },
      { op: 'createGeometry', id: 'g', spec: { shape: 'plane', width: 100, depth: 100 } },
      { op: 'createMesh', id: 'p', geometry: 'g' },
      { op: 'setPosition', id: 'p', position: [0, 0, -50] },
      { op: 'addRoot', id: 'p' },
      { op: 'setMeshMaterial', mesh: 'p', material: 'm' },
    ];
    const r = await onBoth(page, 128, () =>
      page.evaluate(async (o) => {
        const H = (window as never as { H: Harness }).H;
        const settle = () => new Promise((res) => setTimeout(res, 300));
        const before = H.videoState();
        await H.buildAdapterScene(o);
        await settle();
        H.render();
        const first = H.region(56, 56, 16, 16);
        H.setVideoColour('#4080c0');
        await settle();
        H.render();
        const second = H.region(56, 56, 16, 16);
        const during = H.videoState();
        H.dispose();
        await settle();
        return { before, first, second, during, after: H.videoState() };
      }, ops),
    );
    console.log('video texture', JSON.stringify(r));
    for (const engine of ENGINES) {
      expect(maxDiff(r[engine].first, [0xc0, 0x80, 0x40]), `${engine} first frame ${rgb(r[engine].first)}`).toBeLessThanOrEqual(SAME);
      expect(maxDiff(r[engine].second, [0x40, 0x80, 0xc0]), `${engine} after the video changed ${rgb(r[engine].second)}`).toBeLessThanOrEqual(SAME);
      expect(r[engine].during, `${engine}: the texture left its video as it was`).toEqual(r[engine].before);
      expect(r[engine].after, `${engine}: the teardown left its video playing`).toEqual(r[engine].before);
      expect(r[engine].after.paused, engine).toBe(false);
    }
  });
});

test.describe('conformance: a video texture keeps its wrap (#133)', () => {
  // Babylon.js's VideoTexture sets its own wrap each time its video's picture size changes (a `resize` event,
  // videoTexture.pure.js, _resizeInternalTexture); the adapter puts the texture's own back. Qodo, #163.
  test('a clamp video texture stays clamp after its video resizes, on both engines', async ({ page }) => {
    const r = await onBoth(page, 128, () =>
      page.evaluate(async () => {
        const H = (window as never as { H: Harness }).H;
        await H.buildAdapterScene([
          { op: 'createTexture', id: 't', source: 'video', spec: { wrap: 'clamp', repeatU: 2, repeatV: 2 } },
          { op: 'createMaterial', id: 'm', spec: { color: [1, 1, 1], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 1, side: 'front', unlit: true }, map: 't' },
          { op: 'createGeometry', id: 'g', spec: { shape: 'plane', width: 100, depth: 100 } },
          { op: 'createMesh', id: 'p', geometry: 'g' },
          { op: 'setPosition', id: 'p', position: [0, 0, -50] },
          { op: 'addRoot', id: 'p' },
          { op: 'setMeshMaterial', mesh: 'p', material: 'm' },
          { op: 'render' },
        ]);
        await new Promise((res) => setTimeout(res, 300));
        H.render();
        const before = H.textureWrap('t');
        H.resizeVideo();
        H.render();
        const afterOne = H.textureWrap('t');
        H.resizeVideo();
        H.resizeVideo();
        H.render();
        return { before, afterOne, afterThree: H.textureWrap('t') };
      }),
    );
    console.log('video wrap', JSON.stringify(r));
    for (const engine of ENGINES) expect(r[engine], engine).toEqual({ before: 'clamp', afterOne: 'clamp', afterThree: 'clamp' });
  });
});

test.describe('conformance: lights and shadows beyond the table (#134)', () => {
  const LIT: AdapterOp = { op: 'createMaterial', id: 'lit', spec: { color: [0.7, 0.7, 0.7], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 1, side: 'front', unlit: false } };
  const mesh = (id: string, shape: object, at: V3, cast = false, receive = false): AdapterOp[] => [
    { op: 'createGeometry', id: `${id}_g`, spec: shape as never },
    { op: 'createMesh', id, geometry: `${id}_g` },
    { op: 'setPosition', id, position: at },
    { op: 'addRoot', id },
    { op: 'setMeshMaterial', mesh: id, material: 'lit' },
    { op: 'setShadowCasting', id, cast, receive },
  ];
  const STAGE: AdapterOp[] = [
    LIT,
    { op: 'createShadowCatcher', id: 'c', spec: { width: 300, depth: 300, opacity: 0.8 } },
    { op: 'setPosition', id: 'c', position: [0, 0, -200] },
    { op: 'addRoot', id: 'c' },
    ...mesh('cube', { shape: 'box', width: 50, depth: 50, height: 50 }, [40, 0, -175], true),
  ];
  const GRID: Record<string, [number, number, number, number]> = Object.fromEntries([...Array(64)].map((_, k) => [`g${k % 8}_${(k / 8) | 0}`, [6 + 16 * (k % 8), 6 + 16 * ((k / 8) | 0), 4, 4]]));
  const SUN: LightSpec = { kind: 'directional', color: '#ffffff', intensity: 2, position: [300, 0, 100], target: [0, 0, -200], castShadow: true, shadowMapSize: 1024, shadowBias: -0.0005 };
  const SPOT: LightSpec = { kind: 'spot', color: '#ffffff', intensity: 0.5, position: [150, 0, -50], target: [0, 0, -200], angle: 40, penumbra: 0, castShadow: true, distance: 0 };

  /** Builds `ops` and returns the grid of the frame after them. */
  const grid = (page: Page, ops: AdapterOp[]) =>
    page.evaluate(
      async ([o, g]) => {
        const H = (window as never as { H: Harness }).H;
        await H.buildAdapterScene(o);
        H.render();
        return Object.fromEntries(Object.entries(g).map(([k, [x, y, w, h]]) => [k, H.region(x, y, w, h)]));
      },
      [ops, GRID] as const,
    );
  const largest = (a: Record<string, number[]>, b: Record<string, number[]>) => Math.max(...Object.keys(a).map((k) => Math.max(...a[k].map((v, i) => Math.abs(v - b[k][i])))));

  // Each light change made live on a running scene against the same scene made with it: per engine, and across them.
  const LIVE: Array<[string, LightSpec, LightSpec]> = [
    ['directional position and target', SUN, { ...SUN, position: [-300, 0, 100], target: [20, 0, -200] }],
    ['spot position', SPOT, { ...SPOT, position: [-150, 40, -50] }],
    ['spot angle', SPOT, { ...SPOT, angle: 20 }],
    ['spot penumbra', SPOT, { ...SPOT, penumbra: 0.6 }],
    ['spot distance', SPOT, { ...SPOT, distance: 220 }],
    ['casting off', SUN, { ...SUN, castShadow: false }],
    ['casting on', { ...SUN, castShadow: false }, SUN],
    ['map size', SUN, { ...SUN, shadowMapSize: 512 }],
    ['bias', SUN, { ...SUN, shadowBias: -0.003 }],
  ];
  for (const [what, from, to] of LIVE) {
    test(`live equals fresh: ${what}`, async ({ page }) => {
      const r = await onBoth(page, 128, async () => {
        const live = await grid(page, [...STAGE, { op: 'createLight', id: 'l', spec: from }, { op: 'addRoot', id: 'l' }, { op: 'render' }, { op: 'setLight', id: 'l', spec: to }]);
        const fresh = await grid(page, [...STAGE, { op: 'createLight', id: 'l', spec: to }, { op: 'addRoot', id: 'l' }]);
        return { live, fresh };
      });
      for (const engine of ENGINES) expect(largest(r[engine].live, r[engine].fresh), `${engine}: live against fresh`).toBeLessThanOrEqual(SAME);
      const differ = Object.keys(r.three.live).filter((k) => maxDiff(r.three.live[k], r.babylon.live[k]) > SAME || Math.abs(r.three.live[k][3] - r.babylon.live[k][3]) > SAME);
      console.log('live', what, differ.map((k) => `${k} t${r.three.live[k].map(Math.round)} b${r.babylon.live[k].map(Math.round)}`).join(' | '));
      // Across engines, a grid cell that straddles a shadow's edge can differ by a few levels (measured 5): the table's
      // cases hold the shadows' insides to SAME and their edges to 1 px.
      expect(largest(r.three.live, r.babylon.live), 'three against babylon').toBeLessThanOrEqual(LOOK);
      expect(Object.values(r.three.fresh).some((v) => v[3] > 250), 'something drawn').toBe(true);
    });
  }

  test('live equals fresh: a mesh stops and starts receiving, and the catcher changes size and opacity', async ({ page }) => {
    const base = [...STAGE, { op: 'createLight', id: 'l', spec: SUN } as AdapterOp, { op: 'addRoot', id: 'l' } as AdapterOp, ...mesh('floor', { shape: 'plane', width: 120, depth: 120 }, [-120, 0, -199], false, true)];
    const r = await onBoth(page, 128, async () => {
      const live = await grid(page, [...base, { op: 'render' }, { op: 'setShadowCasting', id: 'floor', cast: false, receive: false }, { op: 'setShadowCatcher', id: 'c', spec: { width: 200, depth: 250, opacity: 0.5 } }]);
      const fresh = await grid(page, [
        LIT,
        { op: 'createShadowCatcher', id: 'c', spec: { width: 200, depth: 250, opacity: 0.5 } },
        { op: 'setPosition', id: 'c', position: [0, 0, -200] },
        { op: 'addRoot', id: 'c' },
        ...mesh('cube', { shape: 'box', width: 50, depth: 50, height: 50 }, [40, 0, -175], true),
        { op: 'createLight', id: 'l', spec: SUN },
        { op: 'addRoot', id: 'l' },
        ...mesh('floor', { shape: 'plane', width: 120, depth: 120 }, [-120, 0, -199], false, false),
      ]);
      return { live, fresh };
    });
    for (const engine of ENGINES) expect(largest(r[engine].live, r[engine].fresh), engine).toBeLessThanOrEqual(SAME);
    expect(largest(r.three.live, r.babylon.live)).toBeLessThanOrEqual(SAME);
  });

  // The ruling on #134: penumbra is common; the cone's outer edge agrees on both engines, the falloff inside the
  // penumbra does not (Three.js smoothstep, Babylon.js's glTF falloff, up to 22 levels apart, as the report measured).
  // The edges are asserted; each engine's profile is pinned (within 1 level), so a change on either shows here.
  test('a spot with penumbra 0.5: the same outer edge; each engine\'s profile pinned', async ({ page }) => {
    const ops: AdapterOp[] = [LIT, { op: 'createLight', id: 'l', spec: { kind: 'spot', color: '#ffffff', intensity: 0.08, position: [0, 0, 0], target: [0, 0, -200], angle: 15, penumbra: 0.5 } }, { op: 'addRoot', id: 'l' }, ...mesh('floor', { shape: 'plane', width: 600, depth: 600 }, [0, 0, -200])];
    const r = await onBoth(page, 128, () =>
      page.evaluate(async (o) => {
        const H = (window as never as { H: Harness }).H;
        await H.buildAdapterScene(o);
        H.render();
        return H.channelRow(64, 0);
      }, ops),
    );
    console.log('penumbra profile', JSON.stringify(r));
    const outer = (row: number[]) => [row.findIndex((v) => v > 4), row.length - 1 - [...row].reverse().findIndex((v) => v > 4)];
    const [t, b] = [outer(r.three), outer(r.babylon)];
    expect(Math.abs(t[0] - b[0]), `outer edge, left: ${t} / ${b}`).toBeLessThanOrEqual(1);
    expect(Math.abs(t[1] - b[1]), `outer edge, right: ${t} / ${b}`).toBeLessThanOrEqual(1);
    // Pinned: the red channel at the centre, and 3 px inside the outer edge, in the penumbra (the profiles differ most
    // there: Three.js 100, Babylon.js 71).
    const at = (row: number[]) => [row[64], row[t[1] - 3]];
    expect(at(r.three)).toEqual(PENUMBRA_PINNED.three.map((v) => expect.closeTo(v, 1)) as never);
    expect(at(r.babylon)).toEqual(PENUMBRA_PINNED.babylon.map((v) => expect.closeTo(v, 1)) as never);
  });

  // The catcher over the camera: the page composites its premultiplied pixels as it does a half-transparent mesh's
  // (#144), on both; a half-transparent sphere standing in the shadow draws over it the same way (two transparent
  // things, the catcher first: it is farther).
  test('the catcher over the page, with a half-transparent sphere in the shadow: the same on both', async ({ page }) => {
    const BG = [0x40, 0x80, 0xc0];
    const ops: AdapterOp[] = [
      ...STAGE,
      { op: 'createLight', id: 'l', spec: SUN },
      { op: 'addRoot', id: 'l' },
      { op: 'createMaterial', id: 'half', spec: { color: [0.75, 0.5, 0.25], metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, opacity: 0.5, side: 'front', unlit: true } },
      { op: 'createGeometry', id: 'sg', spec: { shape: 'sphere', radius: 6, detail: 32 } },
      { op: 'createMesh', id: 'sph', geometry: 'sg' },
      { op: 'setPosition', id: 'sph', position: [-10, -15, -190] },
      { op: 'addRoot', id: 'sph' },
      { op: 'setMeshMaterial', mesh: 'sph', material: 'half' },
    ];
    const spots = { shadow: [56, 62, 6, 3], sphere: [60, 68, 3, 3], none: [20, 62, 4, 4] } as const;
    const r = await onBoth(page, 128, async () => {
      const framebuffer = await page.evaluate(
        async ([o, sp]) => {
          const H = (window as never as { H: Harness }).H;
          await H.buildAdapterScene(o);
          H.render();
          return Object.fromEntries(Object.entries(sp).map(([k, [x, y, w, h]]) => [k, H.region(x, y, w, h)]));
        },
        [ops, spots] as const,
      );
      await page.evaluate((bg) => {
        const back = document.createElement('div');
        back.style.cssText = `position:absolute;left:0;top:0;width:128px;height:128px;background:rgb(${bg.join(',')})`;
        document.body.prepend(back);
        document.querySelector('canvas')!.style.zIndex = '1';
      }, BG);
      await page.evaluate(() => (window as never as { H: Harness }).H.render());
      const screen: Record<string, number[]> = {};
      for (const [k, [x, y, w, h]] of Object.entries(spots)) {
        const png = await page.screenshot({ clip: { x, y, width: w, height: h } });
        screen[k] = await page.evaluate(
          async ([b64, n]) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, img.width, img.height).data;
            const sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) for (let q = 0; q < 3; q++) sum[q] += d[i + q];
            return sum.map((v) => v / n);
          },
          [png.toString('base64'), w * h] as const,
        );
      }
      return { framebuffer, screen };
    });
    console.log('catcher over the page', JSON.stringify(r));
    const composite = (px: number[]) => [0, 1, 2].map((k) => px[k] + BG[k] * (1 - px[3] / 255));
    for (const engine of ENGINES) {
      expect(r[engine].framebuffer.shadow[3], `${engine}: a shadow`).toBeGreaterThan(150);
      expect(r[engine].framebuffer.none[3], `${engine}: no shadow`).toBeLessThanOrEqual(2);
      for (const k of Object.keys(spots)) expect(maxDiff(r[engine].screen[k], composite(r[engine].framebuffer[k])), `${engine} ${k}`).toBeLessThanOrEqual(SAME);
    }
    for (const k of Object.keys(spots)) {
      expect(maxDiff(r.babylon.framebuffer[k], r.three.framebuffer[k]), `${k} framebuffer: ${r.three.framebuffer[k]} / ${r.babylon.framebuffer[k]}`).toBeLessThanOrEqual(SAME);
      expect(maxDiff(r.babylon.screen[k], r.three.screen[k]), `${k} screen`).toBeLessThanOrEqual(SAME);
    }
  });
});

/** The penumbra's profile, as each engine draws it (#134's ruling): the red channel at the centre and in the penumbra. */
const PENUMBRA_PINNED = { three: [144, 100], babylon: [144, 71] };

test.describe('conformance: textures', () => {
  // The harness's 64 px canvas: top left red, top right green, bottom left blue, bottom right white, an sRGB 128 grey
  // centre; nearest filtering, sRGB colour space on both. Unlit, so the texel comes out as it is.
  const QUADS: Record<string, [number, number, number, number]> = { tl: [20, 20, 8, 8], tr: [100, 20, 8, 8], bl: [20, 100, 8, 8], br: [100, 100, 8, 8], centre: [60, 60, 8, 8] };
  const cases: Array<{ name: string; material: SceneDesc['objects'][number]['material']; expected?: Record<string, number[]> }> = [
    { name: 'an image on a plane: the same orientation and colour space', material: { kind: 'basic', map: 'quadrants' }, expected: { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 255], centre: [128, 128, 128] } },
    { name: 'repeat 2, wrap repeat', material: { kind: 'basic', map: 'quadrants', repeat: 2, wrap: 'repeat' } },
    { name: 'repeat 2, wrap clamp', material: { kind: 'basic', map: 'quadrants', repeat: 2, wrap: 'clamp' } },
  ];
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      const r = await onBoth(page, 128, () => shoot(page, { size: 128, objects: [{ ...FILL, material: c.material }], lights: [] }, QUADS));
      for (const k of Object.keys(QUADS)) {
        expect(maxDiff(r.babylon[k], r.three[k]), `${k}: ${rgb(r.three[k])} / ${rgb(r.babylon[k])}`).toBeLessThanOrEqual(SAME);
        if (c.expected) expect(maxDiff(r.three[k], c.expected[k]), k).toBeLessThanOrEqual(SAME);
      }
    });
  }

  test('a video texture (a canvas stream, no codec): the frame colour on both', async ({ page }) => {
    const r = await onBoth(page, 128, () =>
      page.evaluate(async (d) => {
        const H = (window as never as { H: Harness }).H;
        await H.build(d);
        // Three.js uploads a video frame when one is ready: render a few times.
        for (let i = 0; i < 10; i++) {
          H.render();
          await new Promise((res) => setTimeout(res, 50));
        }
        return H.region(56, 56, 16, 16);
      }, { size: 128, objects: [{ ...FILL, material: { kind: 'basic', map: 'video' } }], lights: [] } satisfies SceneDesc),
    );
    for (const engine of ENGINES) expect(maxDiff(r[engine], [0xc0, 0x80, 0x40]), `${engine} ${rgb(r[engine])}`).toBeLessThanOrEqual(SAME);
  });

  const SPHERE: Record<string, [number, number, number, number]> = { left: [40, 64, 4, 4], right: [84, 64, 4, 4], top: [62, 40, 4, 4], bottom: [62, 84, 4, 4] };
  const sphere = (material: SceneDesc['objects'][number]['material']): SceneDesc => ({ size: 128, objects: [{ shape: 'sphere', size: 80, position: [0, 0, -70], material }], lights: [] });

  test('sphere UVs as built: not the same (Babylon.js: u half a turn on, v reversed)', async ({ page }) => {
    const r = await onBoth(page, 128, () => shoot(page, sphere({ kind: 'basic', map: 'quadrants' }), SPHERE));
    console.log('sphere uv', JSON.stringify(r));
    expect(rgb(r.three.top)).toEqual([255, 0, 0]);
    expect(rgb(r.babylon.top)).toEqual([255, 255, 255]);
  });

  test('sphere UVs with Babylon.js uOffset 0.5 and vScale −1: the same texels', async ({ page }) => {
    const r = await onBoth(page, 128, (engine) =>
      shoot(page, sphere({ kind: 'basic', map: 'quadrants', ...(engine === 'babylon' ? { babylonUv: { uOffset: 0.5, vScale: -1 } } : {}) }), SPHERE),
    );
    for (const k of Object.keys(SPHERE)) expect(maxDiff(r.babylon[k], r.three[k]), `${k}: ${rgb(r.three[k])} / ${rgb(r.babylon[k])}`).toBeLessThanOrEqual(SAME);
  });
});

test.describe('conformance: shadows (256 px, RGBA over a clear canvas)', () => {
  // A ground plane at −150 mm facing the camera, a 30 mm box at −90 mm casting onto it. Explicit settings at mm scale.
  const EXPLICIT = { mapSize: 1024, extent: 150, near: 1, far: 600, bias: -0.0005 };
  const DIRECTIONAL = { kind: 'directional' as const, intensity: 2, direction: [0.35, -0.35, -0.87] as [number, number, number], position: [0, 0, -120] as [number, number, number] };
  const SPOT = { kind: 'spot' as const, intensity: 200000, position: [-60, 60, 0] as [number, number, number], direction: [0.4, -0.4, -0.82] as [number, number, number], angle: 40, penumbra: 0, falloff: 'gltf' as const, innerAngle: 80, exponent: 0 };
  const REGIONS: Record<string, [number, number, number, number]> = { shadow: [150, 150, 8, 8], lit: [40, 200, 8, 8] };
  const scene = (catcher: SceneDesc['objects'][number]['material'], light: SceneDesc['lights'][number]): SceneDesc => ({
    size: 256,
    objects: [
      { shape: 'plane', size: 400, position: [0, 0, -150], material: catcher, receiveShadow: true },
      { shape: 'box', size: 30, position: [0, 0, -90], material: { kind: 'pbr', color: '#808080' }, castShadow: true },
    ],
    lights: [light],
  });
  const catchers = {
    'ShadowOnlyMaterial (@babylonjs/materials)': { kind: 'shadowOnlyMaterial' as const, opacity: 0.5 },
    'BackgroundMaterial, shadowOnly, primaryColor black (@babylonjs/core)': { kind: 'backgroundShadowOnly' as const, opacity: 0.5, color: '#000000' },
  };
  for (const [name, babylonCatcher] of Object.entries(catchers)) {
    for (const [lname, light] of [['directional', { ...DIRECTIONAL, shadow: EXPLICIT }], ['spot', { ...SPOT, shadow: { mapSize: 1024, near: 10, far: 600, bias: -0.0005 } }]] as const) {
      test(`${lname}: ShadowMaterial against ${name}`, async ({ page }) => {
        const r = await onBoth(page, 256, (engine) => shoot(page, scene(engine === 'three' ? { kind: 'shadowMaterial', opacity: 0.5 } : babylonCatcher, light), REGIONS));
        for (const engine of ENGINES) {
          expect(r[engine].shadow[3], `${engine} shadow alpha`).toBeGreaterThan(0.3 * 255);
          expect(r[engine].lit[3], `${engine} outside alpha`).toBeLessThanOrEqual(2);
        }
        expect(maxDiff(r.babylon.shadow, r.three.shadow)).toBeLessThanOrEqual(SAME);
        expect(Math.abs(r.babylon.shadow[3] - r.three.shadow[3])).toBeLessThanOrEqual(SAME);
      });
    }
  }

  test('BackgroundMaterial shadowOnly with its default primaryColor: the right alpha, a grey shadow', async ({ page }) => {
    await open(page, 'babylon', 256, true);
    const r = await shoot(page, scene({ kind: 'backgroundShadowOnly', opacity: 0.5 }, { ...DIRECTIONAL, shadow: EXPLICIT }), REGIONS);
    expect(r.shadow[3]).toBeCloseTo(160, -1);
    expect(r.shadow[0]).toBeGreaterThan(100); // ShadowMaterial: 25
  });

  test('defaults at mm scale: Three.js shadow camera ±5 mm, map 512; Babylon.js fits its frustum (autoUpdateExtends)', async ({ page }) => {
    const r = await onBoth(page, 256, (engine) =>
      shoot(page, scene(engine === 'three' ? { kind: 'shadowMaterial', opacity: 0.5 } : catchers['BackgroundMaterial, shadowOnly, primaryColor black (@babylonjs/core)'], { ...DIRECTIONAL, shadow: {} }), REGIONS),
    );
    const defaults = await onBoth(page, 64, () => page.evaluate(() => (window as never as { H: Harness }).H.state('shadowDefaults')));
    console.log('shadow defaults', JSON.stringify({ r, defaults }));
    expect(defaults.three).toMatchObject({ mapSize: 512, bias: 0, normalBias: 0, directionalFrustum: [-5, 5, 0.5, 500] });
    expect(defaults.babylon).toMatchObject({ bias: 0.00005, normalBias: 0, autoUpdateExtends: true });
    expect(r.babylon.shadow[3]).toBeCloseTo(160, -1);
    expect(r.three.shadow[3]).toBeLessThan(100); // most of the shadow is outside a ±5 mm frustum
  });
});

test.describe('conformance: environment (an .hdr written by the test, flat scanlines)', () => {
  const REGIONS: Record<string, [number, number, number, number]> = { left: [36, 64, 4, 4], right: [88, 64, 4, 4], top: [62, 36, 4, 4], bottom: [62, 90, 4, 4] };
  /** Two-colour by latitude (top half red), or four bands by longitude (red, green, blue, white). Radiance 0.5. */
  async function shootEnv(page: Page, desc: SceneDesc, layout: 'latitude' | 'longitude') {
    return page.evaluate(
      async ([d, l, rs]) => {
        const w = window as never as { H: Harness; makeHdr(w: number, h: number, f: (u: number, v: number) => number[]): Uint8Array };
        const bands = [[0.5, 0.02, 0.02], [0.02, 0.5, 0.02], [0.02, 0.02, 0.5], [0.5, 0.5, 0.5]];
        const bytes = l === 'longitude' ? w.makeHdr(64, 32, (u) => bands[Math.floor(u * 4)]) : w.makeHdr(64, 32, (_u, v) => (v < 0.5 ? [0.5, 0.02, 0.02] : [0.02, 0.02, 0.5]));
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        d.environment!.hdr = btoa(bin);
        await w.H.build(d);
        w.H.render();
        return Object.fromEntries(Object.entries(rs).map(([k, [x, y, ww, hh]]) => [k, w.H.region(x, y, ww, hh)]));
      },
      [desc, layout, REGIONS] as const,
    );
  }
  const sphere = (metalness: number, roughness: number, babylonRotationY = 0): SceneDesc => ({
    size: 128,
    objects: [{ shape: 'sphere', size: 80, position: [0, 0, -70], material: { kind: 'pbr', color: '#ffffff', metalness, roughness } }],
    lights: [],
    environment: { kind: 'hdr', intensity: 1, babylonRotationY },
  });

  test('latitude: up and down agree (engine +Y up on both); a rough sphere within the same-look tolerance', async ({ page }) => {
    const r = await onBoth(page, 128, () => shootEnv(page, sphere(0, 1), 'latitude'));
    const m = await onBoth(page, 128, () => shootEnv(page, sphere(1, 0.05), 'latitude'));
    console.log('env latitude', JSON.stringify({ r, m }));
    for (const engine of ENGINES) {
      expect(m[engine].top[0], `${engine} mirror top is red`).toBeGreaterThan(m[engine].top[2] + 100);
      expect(m[engine].bottom[2], `${engine} mirror bottom is blue`).toBeGreaterThan(m[engine].bottom[0] + 100);
    }
    for (const k of Object.keys(REGIONS)) expect(maxDiff(r.babylon[k], r.three[k]), k).toBeLessThanOrEqual(LOOK);
  });

  // Both scale with environmentIntensity; the residual (a hue difference: Babylon.js slightly redder, less blue) grows
  // with brightness: measured 6, 8 and 10.5 levels at 0.5, 1 and 2. Within look up to 1, beyond it at 2.
  const ENV_RESIDUAL: Record<number, [number, number]> = { 0.5: [0, LOOK], 1: [0, LOOK], 2: [LOOK, 12] };
  for (const intensity of [0.5, 1, 2]) {
    test(`intensity ${intensity}, k = 1: a rough sphere, residual in [${ENV_RESIDUAL[intensity].join(', ')}] levels (channels in 30..225)`, async ({ page }) => {
      const desc = (i: number): SceneDesc => ({ ...sphere(0, 1), environment: { kind: 'hdr', intensity: i } });
      const r = await onBoth(page, 128, () => shootEnv(page, desc(intensity), 'latitude'));
      console.log('env intensity', intensity, JSON.stringify(r));
      let judged = 0;
      let worst = 0;
      for (const k of Object.keys(REGIONS)) {
        for (const ch of [0, 1, 2]) {
          if (r.three[k][ch] < 30 || r.three[k][ch] > 225) continue;
          judged++;
          worst = Math.max(worst, Math.abs(r.babylon[k][ch] - r.three[k][ch]));
        }
      }
      expect(judged).toBeGreaterThanOrEqual(4);
      const [low, high] = ENV_RESIDUAL[intensity];
      expect(worst).toBeGreaterThanOrEqual(low);
      expect(worst).toBeLessThanOrEqual(high);
      if (intensity !== 1) {
        // Control: the intensity changes what Three.js renders, so the comparison is not of two unchanged frames.
        const one = await onBoth(page, 128, () => shootEnv(page, desc(1), 'latitude'));
        for (const engine of ENGINES) expect(Math.abs(r[engine].top[0] - one[engine].top[0]), engine).toBeGreaterThan(LOOK);
      }
    });
  }

  test('longitude as loaded: a quarter turn apart', async ({ page }) => {
    const m = await onBoth(page, 128, () => shootEnv(page, sphere(1, 0.05), 'longitude'));
    console.log('env longitude', JSON.stringify(m));
    expect(maxDiff(m.babylon.left, m.three.left)).toBeGreaterThan(LOOK);
  });

  test('longitude with Babylon.js rotationY 90°: the same bands in the same directions', async ({ page }) => {
    const m = await onBoth(page, 128, (engine) => shootEnv(page, sphere(1, 0.05, engine === 'babylon' ? 90 : 0), 'longitude'));
    console.log('env longitude rotated', JSON.stringify(m));
    for (const k of ['left', 'right']) expect(maxDiff(m.babylon[k], m.three[k]), `${k}: ${rgb(m.three[k])} / ${rgb(m.babylon[k])}`).toBeLessThanOrEqual(LOOK);
  });

  test("Babylon.js's default environment fetches from assets.babylonjs.com: with the network blocked the scene never gets ready", async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('http') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        requests.push(url);
        return route.abort();
      }
      return route.continue();
    });
    await open(page, 'babylon', 128, true);
    const desc: SceneDesc = { ...sphere(1, 0.05), environment: { kind: 'default', intensity: 1 } };
    const error = await page.evaluate(async (d) => {
      try {
        await (window as never as { H: Harness }).H.build(d);
        return null;
      } catch (err) {
        return String(err);
      }
    }, desc);
    expect(requests.some((u) => u.includes('assets.babylonjs.com'))).toBe(true);
    expect(error).toContain('not ready'); // it waits for a texture that never arrives
  });
});

test.describe('conformance: fog in the browser (centre of the view)', () => {
  // A black unlit plane at depth d in white fog: the pixel is the fog as each engine blends it. Three.js mixes after the
  // sRGB encode (so the pixel is f · 255), Babylon.js before it (fogFragment before pbrBlockImageProcessing).
  const at = (d: number, fog: SceneDesc['fog']): SceneDesc => ({ size: 128, objects: [{ ...FILL, size: 3 * d, position: [0, 0, -d], material: { kind: 'basic', color: '#000000' } }], lights: [], fog });
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const cases: Array<{ name: string; d: number; fog: SceneDesc['fog']; three: number; babylon: number }> = [
    { name: 'linear 100–1000, 200 mm', d: 200, fog: { mode: 'linear', color: '#ffffff', near: 100, far: 1000 }, three: 255 * smooth(100 / 900), babylon: 133 },
    { name: 'linear 100–1000, 500 mm', d: 500, fog: { mode: 'linear', color: '#ffffff', near: 100, far: 1000 }, three: 255 * smooth(400 / 900), babylon: 222 },
    { name: 'exp2 0.002, 200 mm', d: 200, fog: { mode: 'exp2', color: '#ffffff', density: 0.002 }, three: 255 * (1 - Math.exp(-0.16)), babylon: 150 },
    { name: 'exp2 0.002, 500 mm', d: 500, fog: { mode: 'exp2', color: '#ffffff', density: 0.002 }, three: 255 * (1 - Math.exp(-1)), babylon: 242 },
  ];
  for (const c of cases) {
    test(`${c.name}: Three.js follows its formula after the encode; Babylon.js pinned, not equivalent`, async ({ page }) => {
      const r = await onBoth(page, 128, () => shoot(page, at(c.d, c.fog), { c: CENTRE }));
      expect(Math.abs(r.three.c[0] - c.three), `three ${r.three.c[0]}`).toBeLessThanOrEqual(SAME);
      expect(Math.abs(r.babylon.c[0] - c.babylon), `babylon ${r.babylon.c[0]}`).toBeLessThanOrEqual(SAME);
      expect(Math.abs(r.babylon.c[0] - r.three.c[0])).toBeGreaterThan(LOOK);
    });
  }
});

test.describe('conformance: under the marker anchor (rotated 90° about X, translated)', () => {
  const ANCHOR = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 10, -5, -60, 1];
  const plane = { ...FILL, position: [0, 0, 0] as [number, number, number], rotation: [-90, 0, 0] as [number, number, number], material: { kind: 'pbr' as const, color: '#808080', noSpecular: true } };

  test('a directional light and a plane under the anchor: the same on both', async ({ page }) => {
    const desc: SceneDesc = { size: 128, anchor: ANCHOR, objects: [plane], lights: [{ kind: 'directional', intensity: 3, direction: D45, position: [0, 0, 0] }] };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    expect(unclipped(r.three.c)).toBe(true);
    expect(maxDiff(r.babylon.c, r.three.c)).toBeLessThanOrEqual(SAME);
  });

  test("a hemisphere light under the anchor: Babylon.js's HemisphericLight ignores its parent (the adapter compensates, babylon-adapter.ts:197)", async ({ page }) => {
    const desc: SceneDesc = { size: 128, anchor: ANCHOR, objects: [plane], lights: [{ kind: 'hemisphere', intensity: 2, direction: [0, 1, 0], ground: '#000000' }], babylonLightScale: 1 / Math.PI };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    expect(r.three.c[0]).toBeLessThan(10); // the sky turned to face away from the plane
    expect(r.babylon.c[0]).toBeGreaterThan(60); // still lit from the engine's +Y
  });
});

test.describe('conformance: facing', () => {
  // Front faces only; seen from the camera at the origin. A visible object covers the centre (alpha 255).
  const cases: Array<{ name: string; desc: Partial<SceneDesc['objects'][number]>; visible: { three: boolean; babylon: boolean } }> = [
    // Untranslated (raw): what each engine's builder gives.
    { name: 'raw: a plane, as built, faces +Z on Three.js and −Z on Babylon.js', desc: { shape: 'plane', raw: true }, visible: { three: true, babylon: false } },
    { name: 'raw: a plane turned 180° about Y', desc: { shape: 'plane', raw: true, rotation: [0, 180, 0] }, visible: { three: false, babylon: true } },
    { name: 'raw: a custom triangle counter-clockwise from +Z is a front face on Three.js, a back face on Babylon.js', desc: { shape: 'triangle', raw: true }, visible: { three: true, babylon: false } },
    { name: 'raw: a custom triangle clockwise from +Z', desc: { shape: 'triangle', raw: true, clockwise: true }, visible: { three: false, babylon: true } },
    { name: 'raw: an unindexed triangle wound to face the camera on each engine: Babylon.js draws nothing', desc: { shape: 'triangleUnindexed', raw: true }, visible: { three: true, babylon: false } },
    { name: 'raw: an unindexed triangle clockwise from +Z: still nothing on Babylon.js', desc: { shape: 'triangleUnindexed', raw: true, clockwise: true }, visible: { three: false, babylon: false } },
    // Translated (the harness default: Babylon plane BACKSIDE, custom indices reversed).
    { name: 'translated: a plane faces +Z on both', desc: { shape: 'plane' }, visible: { three: true, babylon: true } },
    { name: 'translated: a plane turned 180° about Y is culled on both', desc: { shape: 'plane', rotation: [0, 180, 0] }, visible: { three: false, babylon: false } },
    { name: 'translated: a custom triangle counter-clockwise from +Z shows on both', desc: { shape: 'triangle' }, visible: { three: true, babylon: true } },
    // Built-in solids need no translation.
    { name: 'a box, from outside', desc: { shape: 'box', size: 40 }, visible: { three: true, babylon: true } },
    { name: 'a sphere, from outside', desc: { shape: 'sphere', size: 40 }, visible: { three: true, babylon: true } },
    { name: 'a box mirrored (scale x −1) still shows its outside', desc: { shape: 'box', size: 40, scale: [-1, 1, 1] }, visible: { three: true, babylon: true } },
  ];
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      const r = await onBoth(page, 128, () =>
        shoot(page, { size: 128, objects: [{ ...FILL, size: 60, ...c.desc, material: { kind: 'basic', color: '#ffffff' } } as SceneDesc['objects'][number]], lights: [] }, { c: [60, 60, 8, 8] }),
      );
      for (const engine of ENGINES) expect(r[engine].c[3] > 128, `${engine} alpha ${r[engine].c[3]}`).toBe(c.visible[engine]);
    });
  }
});

test.describe('conformance: material defaults', () => {
  test('a fresh PBR material on each engine', async ({ page }) => {
    const r = await onBoth(page, 64, () => page.evaluate(() => (window as never as { H: Harness }).H.state('materialDefaults')));
    console.log('materialDefaults', JSON.stringify(r));
    expect(r.three).toEqual({ color: 'ffffff', metalness: 0, roughness: 1, emissive: '000000', opacity: 1, side: 'front' });
    expect(r.babylon).toEqual({ color: '#FFFFFF', metalness: null, roughness: null, emissive: '#000000', opacity: 1, backFaceCulling: true });
  });
});

