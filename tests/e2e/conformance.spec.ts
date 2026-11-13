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

async function open(page: Page, engine: Engine, size = 128) {
  await page.setContent('<!doctype html><title>conformance</title><body style="margin:0">');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ([e, s]) => {
      const w = window as never as { H: Harness; openConformance(e: string, s: number): Promise<Harness> };
      w.H = await w.openConformance(e, s);
    },
    [engine, size] as const,
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

/** Both engines' results for one scene, with the scene built by `make(engine)`. */
async function onBoth<T>(page: Page, size: number, run: (engine: Engine) => Promise<T>): Promise<Record<Engine, T>> {
  const out = {} as Record<Engine, T>;
  for (const engine of ENGINES) {
    await open(page, engine, size);
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

// Used by the cases added below (kept while they are written).
void [LOOK, rgb, toLinear, unclipped];
