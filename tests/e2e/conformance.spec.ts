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
    expect(three.premultipliedAlpha).toBe(true);
    expect(three.toneMappingExposure).toBe(1);
    expect(three.clearAlpha).toBe(0);
    expect(babylon.premultipliedAlpha).toBe(false);
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

test.describe('conformance: lights in the current adapters (scene.light on scene.primitive)', () => {
  // Today: Three.js MeshStandardMaterial; Babylon.js StandardMaterial (specularColor 0.2, babylon-adapter.ts:135) with
  // every light x BABYLON_INTENSITY 0.4. Red channel of a #808080 box whose front face looks at the camera (+Z). Both
  // adapters point a hemisphere's sky along +Z (three-adapter.ts:20, babylon-adapter.ts:181), so with the sky black and
  // the box facing it, the ground weighs nothing: what Babylon.js shows is its hemispheric light's specular (white by
  // default; the adapter blacks it out for ambient only, :188), which Three.js's HemisphereLight does not have.
  const RX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  const cases = {
    hemisphereSpecular: { lights: [{ kind: 'hemisphere', color: '#000000', intensity: 1 }] },
    ambient: { lights: [{ kind: 'ambient', color: '#ffffff', intensity: 1 }] },
    directional: { lights: [{ kind: 'directional', color: '#ffffff', intensity: 1 }] },
    // The hemisphere under a group turned 180 degrees about X: the adapters re-orient an adopted hemisphere from its
    // parent, so the sky points away and the front face sees only the ground (0x444444 on Three.js, 0.3 on Babylon.js).
    groundOnly: { lights: [{ kind: 'hemisphere', color: '#000000', intensity: 1 }], lightsMatrix: RX180 },
  };
  // groundOnly is read on the second frame: on the first, the Three.js adapter still points the adopted hemisphere along
  // +Z (its direction comes from parent.updateWorldMatrix(true, false), which does not force a group whose
  // matrixAutoUpdate is off: three/src/core/Object3D.js:1237). See "known difference: … one frame late" below.
  type Name = keyof typeof cases;
  const pinned: Record<Name, { three: number; babylon: number }> = {
    hemisphereSpecular: { three: 0, babylon: 20 },
    ambient: { three: 74, babylon: 51 },
    directional: { three: 72, babylon: 56 },
    groundOnly: { three: 13, babylon: 15 },
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
      false,
    );

  test('pinned: what each adapter renders today', async ({ page }) => {
    const r = await measure(page);
    for (const name of Object.keys(pinned) as Name[]) {
      expect(Math.abs(r.three[name] - pinned[name].three), `three ${name} ${r.three[name]}`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.babylon[name] - pinned[name].babylon), `babylon ${name} ${r.babylon[name]}`).toBeLessThanOrEqual(1);
    }
  });

  test("the hemisphere's 20 on Babylon.js is its specular: black, it gives 0; the ground case does not change", async ({ page }) => {
    const r = await measure(page, { babylonSpecularBlack: true });
    expect(r.babylon.hemisphereSpecular).toBe(0);
    expect(Math.abs(r.babylon.groundOnly - pinned.groundOnly.babylon)).toBeLessThanOrEqual(1);
  });

  test('the ground colour alone: the two adapters agree today (13 and 15)', async ({ page }) => {
    const r = await measure(page);
    expect(Math.abs(r.babylon.groundOnly - r.three.groundOnly)).toBeLessThanOrEqual(SAME);
  });

  test('pinned: the first frame after a hemisphere is adopted, Three.js 0 (still the old direction), Babylon.js 15', async ({ page }) => {
    const r = await measure(page, {}, 1);
    expect(r.three.groundOnly).toBe(0);
    expect(Math.abs(r.babylon.groundOnly - 15)).toBeLessThanOrEqual(1);
  });

  test('known difference: the Three.js adapter re-orients an adopted hemisphere one frame late', async ({ page }) => {
    test.fail(true, 'three-adapter.ts reads the parent with updateWorldMatrix(true, false) before render(), which does not update a group whose matrixAutoUpdate is off');
    const r = await measure(page, {}, 1);
    expect(Math.abs(r.babylon.groundOnly - r.three.groundOnly)).toBeLessThanOrEqual(SAME);
  });

  for (const name of ['hemisphereSpecular', 'ambient', 'directional'] as const) {
    test(`known difference (#131): ${name} renders alike on both adapters`, async ({ page }) => {
      test.fail(true, 'Babylon.js StandardMaterial with BABYLON_INTENSITY 0.4, and a white specular on its hemispheric light: the pinned values differ; #131 fixes it');
      const r = await measure(page);
      expect(Math.abs(r.babylon[name] - r.three[name])).toBeLessThanOrEqual(SAME);
    });
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
  // The canvas is composited over the camera video: Three.js's context is premultiplied, the Babylon.js adapter's is not
  // (babylon-adapter.ts:76). A half-transparent unlit plane of #c08040 over a clear canvas, then over a #4080c0 element.
  const BG = [0x40, 0x80, 0xc0];
  const desc: SceneDesc = { size: 128, objects: [{ ...FILL, material: { kind: 'basic', color: '#c08040', opacity: 0.5 } }], lights: [] };
  /** The page's composite of a framebuffer pixel, per the context's premultipliedAlpha. */
  const composite = (px: number[], premultiplied: boolean) => {
    const a = px[3] / 255;
    return [0, 1, 2].map((k) => (premultiplied ? px[k] : px[k] * a) + BG[k] * (1 - a));
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
      const computed = composite(framebuffer, engine === 'three');
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
    // Three.js: 0.5 · #c08040 + 0.5 · #4080c0 in sRGB values, as the page blends.
    expect(maxDiff(r.three.screen, [128, 128, 128])).toBeLessThanOrEqual(SAME);
  });

  test('known difference: a half-transparent object looks the same over the camera on both adapters', async ({ page }) => {
    test.fail(true, 'the Babylon.js adapter creates its context with premultipliedAlpha: false, and its framebuffer holds colour × alpha: the page multiplies by alpha again');
    const r = await measure(page);
    expect(maxDiff(r.babylon.screen, r.three.screen)).toBeLessThanOrEqual(SAME);
  });
});

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

