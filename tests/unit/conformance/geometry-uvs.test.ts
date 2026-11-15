/**
 * How each engine's UVs relate on the core's shapes (#133), in Node: at points inside every triangle of the Three.js
 * adapter's geometry (threeGeometry), the UV of the Babylon.js adapter's geometry (babylonVertexData) at the same
 * surface point is read, and the exact relation between the two is found: a sign or swap of u and v, plus an offset,
 * wrapped on an axis that goes round the shape. A texture shows the same on both engines where the relation is the
 * identity. This pins what each shape does today (docs/proposals/scene-nodes-equivalence.md, "UVs on other shapes"):
 * #162 builds Babylon.js's shapes from Three.js's generators, which makes every line `t = (u, v) + (0.0000, 0.0000)`.
 */
import { describe, expect, it } from 'vitest';
import { threeGeometry } from '../../../src/runtime/renderers/three-adapter';
import { babylonVertexData } from '../../../src/runtime/renderers/babylon-adapter';
import type { GeometrySpec } from '../../../src/core/geometry';

type V3 = [number, number, number];
interface Tri { p: [V3, V3, V3]; uv: [[number, number], [number, number], [number, number]] }

function tris(pos: ArrayLike<number>, uv: ArrayLike<number>, idx: ArrayLike<number> | null): Tri[] {
  const n = idx ? idx.length : pos.length / 3;
  const at = (i: number) => (idx ? idx[i] : i);
  const out: Tri[] = [];
  for (let t = 0; t < n; t += 3) {
    const v = [at(t), at(t + 1), at(t + 2)];
    out.push({ p: v.map((i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]) as Tri['p'], uv: v.map((i) => [uv[2 * i], uv[2 * i + 1]]) as Tri['uv'] });
  }
  return out;
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Barycentric of p in t, and its distance to t's plane. */
function bary(t: Tri, p: V3) {
  const [a, b, c] = t.p;
  const n = cross(sub(b, a), sub(c, a));
  const area = Math.hypot(...n);
  if (area < 1e-12) return null;
  const nn: V3 = [n[0] / area, n[1] / area, n[2] / area];
  const dist = Math.abs(dot(sub(p, a), nn));
  const w0 = dot(cross(sub(b, p), sub(c, p)), nn) / area;
  const w1 = dot(cross(sub(c, p), sub(a, p)), nn) / area;
  return { w: [w0, w1, 1 - w0 - w1], dist, normal: nn };
}
function uvAt(ts: Tri[], p: V3, normal: V3): [number, number] | null {
  let best: { uv: [number, number]; d: number } | null = null;
  for (const t of ts) {
    const b = bary(t, p);
    if (!b || b.w.some((w) => w < -1e-3)) continue;
    if (Math.abs(dot(b.normal, normal)) < 0.5) continue;
    if (b.dist > 0.5) continue;
    if (!best || b.dist < best.d) best = { d: b.dist, uv: [0, 1].map((k) => b.w[0] * t.uv[0][k] + b.w[1] * t.uv[1][k] + b.w[2] * t.uv[2][k]) as [number, number] };
  }
  return best?.uv ?? null;
}

const LINEAR: Record<string, (u: number, v: number) => [number, number]> = {
  'u, v': (u, v) => [u, v],
  '-u, v': (u, v) => [-u, v],
  'u, -v': (u, v) => [u, -v],
  '-u, -v': (u, v) => [-u, -v],
  'v, u': (u, v) => [v, u],
  '-v, u': (u, v) => [-v, u],
  'v, -u': (u, v) => [v, -u],
  '-v, -u': (u, v) => [-v, -u],
};
const frac = (x: number) => x - Math.floor(x);
/** A difference, wrapped to -0.5..0.5 on a periodic axis. */
const wrapd = (d: number, periodic: boolean) => (periodic ? frac(d + 0.5) - 0.5 : d);
const PERIODIC: Record<string, [boolean, boolean]> = { sphere: [true, false], torus: [true, true], torusKnot: [true, true], cylinder: [true, false], capsule: [true, false], box: [false, false], plane: [false, false] };
function fit(samples: Array<{ three: [number, number]; babylon: [number, number] }>, periodic: [boolean, boolean]) {
  const out: string[] = [];
  const worst: Array<[number, string, number[]]> = [];
  for (const [name, L] of Object.entries(LINEAR)) {
    const ds = samples.map(({ three, babylon }) => { const l = L(babylon[0], babylon[1]); return [three[0] - l[0], three[1] - l[1]]; });
    const off = [0, 1].map((k) => { const ref = ds[0][k]; const m = ds.reduce((a, d) => a + wrapd(d[k] - ref, periodic[k]), 0) / ds.length; return ref + m; });
    const res = Math.max(...ds.map((d) => Math.max(...[0, 1].map((k) => Math.abs(wrapd(d[k] - off[k], periodic[k]))))));
    worst.push([res, name, off]);
    if (res < 2e-3) out.push(`t = (${name}) + (${off.map((x) => (periodic[0] ? x : x).toFixed(4)).join(', ')})`);
  }
  if (!out.length) {
    worst.sort((a, b) => a[0] - b[0]);
    out.push(`NO EXACT FIT; closest: (${worst[0][1]}) + (${worst[0][2].map((x) => x.toFixed(4))}) residual ${worst[0][0].toFixed(4)}`);
  }
  return out;
}

const SHAPES: Record<string, GeometrySpec> = {
  box: { shape: 'box', width: 60, depth: 40, height: 20 },
  sphere: { shape: 'sphere', radius: 30, detail: 32 },
  cylinder: { shape: 'cylinder', radiusTop: 20, radiusBottom: 30, height: 40, detail: 32 },
  plane: { shape: 'plane', width: 60, depth: 40 },
  torus: { shape: 'torus', radius: 30, tube: 10, detail: 32 },
  torusKnot: { shape: 'torusKnot', radius: 30, tube: 8, p: 2, q: 3, detail: 64 },
  capsule: { shape: 'capsule', radius: 15, height: 60, detail: 32 },
};

/** A group of a probe: the box's faces by normal, the cylinder's caps and side, the capsule's caps and middle. */
function groupOf(shape: string, p: V3, n: V3): string {
  if (shape === 'box') {
    const k = [0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0);
    return `${n[k] > 0 ? '+' : '-'}${'XYZ'[k]}`;
  }
  if (shape === 'cylinder') return Math.abs(n[2]) > 0.9 ? (n[2] > 0 ? 'top' : 'bottom') : 'side';
  if (shape === 'capsule') return p[2] > 15 ? 'top cap' : p[2] < -15 ? 'bottom cap' : 'middle';
  return 'all';
}

function relations(name: string, spec: GeometrySpec): Record<string, string> {
  const g = threeGeometry(spec);
  const t3 = tris(g.getAttribute('position').array, g.getAttribute('uv').array, g.getIndex()?.array ?? null);
  const vd = babylonVertexData(spec);
  const tb = tris(vd.positions!, vd.uvs!, vd.indices!);
  const groups = new Map<string, Array<{ three: [number, number]; babylon: [number, number] }>>();
  for (const t of t3) {
    const b0 = bary(t, t.p[0]);
    if (!b0) continue;
    for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
      const p: V3 = [0, 1, 2].map((k) => w[0] * t.p[0][k] + w[1] * t.p[1][k] + w[2] * t.p[2][k]) as V3;
      const three: [number, number] = [0, 1].map((k) => w[0] * t.uv[0][k] + w[1] * t.uv[1][k] + w[2] * t.uv[2][k]) as [number, number];
      const babylon = uvAt(tb, p, b0.normal);
      if (!babylon) throw new Error(`${name}: no Babylon.js triangle at ${p}`);
      const key = groupOf(name, p, b0.normal);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push({ three, babylon });
    }
  }
  return Object.fromEntries([...groups].map(([key, samples]) => [key, fit(samples, PERIODIC[name])[0]]));
}

describe('UVs on the core shapes: Babylon.js against Three.js (#133)', () => {
  it('the plane: the same', () => {
    expect(relations('plane', SHAPES.plane)).toEqual({ all: 't = (u, v) + (0.0000, 0.0000)' });
  });

  it('pinned: the box, each face a sign or swap of u and v', () => {
    expect(relations('box', SHAPES.box)).toEqual({
      '+X': 't = (v, u) + (0.0000, -0.0000)',
      '-X': 't = (v, u) + (0.0000, -0.0000)',
      '+Y': 't = (-v, -u) + (1.0000, 1.0000)',
      '-Y': 't = (v, u) + (0.0000, -0.0000)',
      '+Z': 't = (u, -v) + (-0.0000, 1.0000)',
      '-Z': 't = (-u, v) + (1.0000, -0.0000)',
    });
  });

  it('pinned: the cylinder, its caps swapped, its side a quarter turn round', () => {
    const r = relations('cylinder', SHAPES.cylinder);
    expect(r.top).toBe('t = (v, u) + (-0.0000, -0.0000)');
    expect(r.bottom).toBe('t = (v, -u) + (-0.0000, 1.0000)');
    expect(r.side).toMatch(/^t = \(u, v\) \+ \(-0\.74\d\d, 0\.0000\)$/);
  });

  it.each(['sphere', 'torusKnot', 'capsule'] as const)('pinned: %s, no exact relation', (name) => {
    for (const fit of Object.values(relations(name, SHAPES[name]))) expect(fit).toMatch(/^NO EXACT FIT/);
  });

  it('pinned: the torus, u mirrored a quarter turn on, v half a turn round the tube', () => {
    expect(relations('torus', SHAPES.torus)).toEqual({ all: 't = (-u, v) + (0.2500, -0.5000)' });
  });

  // Known differences: #162 builds Babylon.js's shapes from Three.js's generators, and these pass then (remove `fails`
  // and the pinned tests above).
  it.fails.each(['box', 'sphere', 'cylinder', 'torus', 'torusKnot', 'capsule'] as const)('known difference (#162): %s, the same as Three.js', (name) => {
    for (const fit of Object.values(relations(name, SHAPES[name]))) expect(fit).toBe('t = (u, v) + (0.0000, 0.0000)');
  });
});
