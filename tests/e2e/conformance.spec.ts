// Renderer conformance in the browser (#129; #130 adds its cases): one table per item, run on both real adapters through
// tests/e2e/harness/conformance-harness.ts. Pixel tolerances are stated per table; the report
// (docs/proposals/scene-nodes-equivalence.md) explains each and names the Chromium revision they were measured on.
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { Harness, SceneDesc } from './harness/conformance-harness';

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

/** exactSrgb: Babylon.js with useExactSrgbConversions, the translation the report asks #131 for. */
async function open(page: Page, engine: Engine, size = 128, exactSrgb = false) {
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

/** Both engines' results, each from `run(engine)` in a fresh page; Babylon.js with exact sRGB unless `exactSrgb` is false. */
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
  });
});

test.describe('conformance: colour pipeline', () => {
  test('unlit: a hex colour comes out unchanged on both, when Babylon.js is given it in linear', async ({ page }) => {
    const r = await onBoth(page, 128, () =>
      shoot(page, { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#8040c0' } }], lights: [] }, { c: CENTRE }),
    );
    for (const engine of ENGINES) expect(maxDiff(r[engine].c, [128, 64, 192]), engine).toBeLessThanOrEqual(SAME);
  });

  test('unlit: the hex colour given to Babylon.js unconverted (Color3.FromHexString, as the adapter does) comes out brighter', async ({ page }) => {
    await open(page, 'babylon');
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
    expect(r.c[0]).toBeGreaterThan(90); // Three.js gives 22 here
  });

  test('point: decay other than 2 is Three.js only (Babylon.js has no decay exponent)', async ({ page }) => {
    const desc: SceneDesc = { size: 128, objects: [diffusePlane('#808080', -100, 300)], lights: [{ kind: 'point', intensity: 200, position: [0, 0, 0], decay: 1 }] };
    const r = await onBoth(page, 128, () => shoot(page, desc, { c: CENTRE }));
    expect(unclipped(r.three.c)).toBe(true);
    expect(r.babylon.c[0]).toBeLessThan(10); // inverse square regardless
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

test.describe('conformance: lights in the current adapters (scene.light on scene.primitive)', () => {
  // Today: Three.js MeshStandardMaterial; Babylon.js StandardMaterial with every light × BABYLON_INTENSITY 0.4, a
  // hemisphere ground of 0.3 grey against 0x444444. Pinned here, then the equality the Phase 4 work must reach.
  const pinned = {
    groundOnly: { three: 0, babylon: 20 },
    ambient: { three: 74, babylon: 51 },
    directional: { three: 72, babylon: 56 },
  } as const;
  const lights = {
    groundOnly: [{ kind: 'hemisphere', color: '#000000', intensity: 1 }],
    ambient: [{ kind: 'ambient', color: '#ffffff', intensity: 1 }],
    directional: [{ kind: 'directional', color: '#ffffff', intensity: 1 }],
  };
  const measure = (page: Page) =>
    onBoth(
      page,
      128,
      () =>
        page.evaluate(async (all) => {
          const H = (window as never as { H: Harness }).H;
          const out: Record<string, number> = {};
          for (const [name, ls] of Object.entries(all)) {
            await H.buildWithAdapter({ size: 40, color: '#808080', position: [0, 0, -60], lights: ls as never });
            H.render();
            out[name] = Math.round(H.region(60, 60, 8, 8)[0]);
          }
          return out;
        }, lights),
      false,
    );

  test('pinned: what each adapter renders today', async ({ page }) => {
    const r = await measure(page);
    for (const name of Object.keys(pinned) as Array<keyof typeof pinned>) {
      expect(Math.abs(r.three[name] - pinned[name].three), `three ${name} ${r.three[name]}`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.babylon[name] - pinned[name].babylon), `babylon ${name} ${r.babylon[name]}`).toBeLessThanOrEqual(1);
    }
  });

  for (const name of Object.keys(pinned) as Array<keyof typeof pinned>) {
    test(`known difference (#131): ${name} renders alike on both adapters`, async ({ page }) => {
      test.fail(true, 'Babylon.js StandardMaterial with BABYLON_INTENSITY 0.4 and a 0.3 ground: the pinned values differ; #131 fixes it');
      const r = await measure(page);
      expect(Math.abs(r.babylon[name] - r.three[name])).toBeLessThanOrEqual(SAME);
    });
  }
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

