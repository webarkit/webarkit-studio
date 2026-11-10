import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { threeScript } from '../../src/runtime/nodes/three-script';
import { disposeObject3D } from '../../src/runtime/renderers/three-dispose';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { THREE_SCRIPT_EXAMPLES } from '../../src/editor/script-examples';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { effectiveDefinition } from '../../src/core/script';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import type { SceneHandle, SceneObject } from '../../src/runtime/renderers/adapter';
import type { FrameInfo, RuntimeContext } from '../../src/runtime/types';

const frame = (deltaMs = 16): FrameInfo => ({ time: 0, delta: deltaMs, frame: 1 });
const head = (...lines: string[]) => `/*\n${lines.join('\n')}\n*/\n`;

/** A Three.js scene with the adapter calls three.script uses: groups, children, release. */
function fakeScene(kind = 'Three.js') {
  const released: SceneObject[] = [];
  const scene = {
    renderer: { kind },
    createGroup: (): SceneObject => ({ scene, native: new THREE.Group() }) as never,
    addChild: (parent: SceneObject, child: SceneObject) => void (parent.native as THREE.Object3D).add(child.native as THREE.Object3D),
    release: (o: SceneObject) => {
      released.push(o);
      disposeObject3D(o.native as THREE.Object3D);
    },
  } as unknown as SceneHandle;
  return { scene, released };
}

function make(script: string, params: Record<string, ParamValue> = {}) {
  const reports: string[] = [];
  const logs: string[] = [];
  const ctx = { nodeId: 'scenery', report: (t: string) => void reports.push(t), log: (m: string) => void logs.push(m) } as unknown as RuntimeContext;
  const def = effectiveDefinition({ type: 'three.script', params: { script } })!;
  const p = { ...resolveParams(def, { script, ...params }) };
  return { node: threeScript(p, ctx), p, reports, logs };
}

const children = (o: unknown) => (o as SceneObject & { native: THREE.Object3D }).native.children;

describe('three.script (#36)', () => {
  it('is registered, marked as running code, with a scene input and an object output', () => {
    expect(NODE_REGISTRY['three.script']).toBe(threeScript);
    expect(NODE_CATALOG['three.script']).toMatchObject({ runsCode: true, provider: 'Three.js', category: 'scene' });
    expect(NODE_CATALOG['three.script'].inputs.scene.type).toBe('scene');
    expect(NODE_CATALOG['three.script'].outputs.object.type).toBe('sceneObject');
  });

  it('onInit builds in a group, in marker space; Object is a group around it', async () => {
    const { scene } = fakeScene();
    const { node } = make(head() + 'function onInit({ THREE, group }) { group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); }');
    const out = (await node.init!({ scene })) as { object: SceneObject };
    const [inner] = children(out.object);
    expect(inner).toBeInstanceOf(THREE.Group);
    expect(inner.children[0]).toBeInstanceOf(THREE.Mesh);
  });

  it('onFrame animates with time, delta (seconds) and the inputs, a wired input over its param', async () => {
    const { scene } = fakeScene();
    const { node } = make(head('in height number d=30') + 'function onFrame({ group, time, delta, inputs }) { group.position.set(time, delta, inputs.height); }');
    const out = (await node.init!({ scene })) as { object: SceneObject };
    const group = children(out.object)[0];
    node.update!({ scene }, frame(500));
    expect(group.position.toArray()).toEqual([0.5, 0.5, 30]);
    node.update!({ scene, height: 12 }, frame(250));
    expect(group.position.toArray()).toEqual([0.75, 0.25, 12]);
  });

  it('the default script builds a cube that bobs', async () => {
    const { scene } = fakeScene();
    const { node, reports } = make(NODE_CATALOG['three.script'].params.script.default as string);
    const out = (await node.init!({ scene })) as { object: SceneObject };
    node.update!({ scene }, frame(500));
    const group = children(out.object)[0];
    expect(group.children).toHaveLength(1);
    expect(group.position.z).toBeCloseTo(70);
    expect(reports.filter((r) => r)).toEqual([]);
  });

  it('an error in onInit or onFrame shows on the node with its line, once in the log, and never throws out of the node', async () => {
    const { scene } = fakeScene();
    const script = head() + 'function onInit() {}\nfunction onFrame({ time }) {\n  if (time > 1) throw new Error("late");\n}\n';
    const { node, reports, logs } = make(script);
    await node.init!({ scene });
    node.update!({ scene }, frame(500));
    expect(() => node.update!({ scene }, frame(800))).not.toThrow();
    // Line 1 is the header's /*, line 3 its */.
    expect(reports.at(-1)).toBe('✗ line 6: late');
    node.update!({ scene }, frame(16));
    expect(logs.filter((l) => l.includes('late'))).toEqual(['✗ scenery: line 6: late']);

    const broken = make(head() + 'function onInit() {\n  throw new Error("no");\n}\n');
    await expect(broken.node.init!({ scene })).resolves.toMatchObject({ object: expect.anything() });
    expect(broken.reports.at(-1)).toBe('✗ line 5: no');
  });

  it('a live code change disposes the old group (onDispose, then its resources) and runs onInit on a fresh one', async () => {
    const { scene, released } = fakeScene();
    const first = head() + 'function onInit({ THREE, group }) { group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); }\nfunction onDispose() { globalThis.__disposed = (globalThis.__disposed ?? 0) + 1; }';
    const { node, p } = make(first);
    const out = (await node.init!({ scene })) as { object: SceneObject };
    const old = children(out.object)[0];
    const geometry = (old.children[0] as THREE.Mesh).geometry;
    let disposedGeometry = false;
    geometry.addEventListener('dispose', () => (disposedGeometry = true));
    p.script = head() + 'function onInit({ THREE, group }) { group.add(new THREE.Mesh(new THREE.SphereGeometry(1))); }';
    node.onParamChange!('script', p.script);
    expect((globalThis as { __disposed?: number }).__disposed).toBe(1);
    expect(released).toHaveLength(1);
    expect(disposedGeometry).toBe(true);
    expect(children(out.object)).toHaveLength(1);
    expect((children(out.object)[0].children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.SphereGeometry);
  });

  it('a live change that does not compile keeps the running script and shows the error until one compiles', async () => {
    const { scene } = fakeScene();
    const { node, p, reports } = make(head() + 'function onFrame({ group, time }) { group.position.x = time; }');
    const out = (await node.init!({ scene })) as { object: SceneObject };
    p.script = head() + 'function onFrame( {';
    node.onParamChange!('script', p.script);
    const error = reports.at(-1)!;
    expect(error).toMatch(/^✗ /);
    node.update!({ scene }, frame(500));
    expect(children(out.object)[0].position.x).toBe(0.5); // still running
    expect(reports.at(-1)).toBe(error);
  });

  it('a syntax error shows its line, at start and on a live edit (Qodo, #101)', async () => {
    const stray = make(head() + 'let a = 1;\nfunction onInit() { a = a 2; }\n');
    await stray.node.init!({ scene: fakeScene().scene });
    expect(stray.reports.at(-1)).toMatch(/^✗ line 5: /);
    const open = make(head() + 'function onFrame({ group }) {\n  group.position.x = 1;\n');
    await open.node.init!({ scene: fakeScene().scene });
    expect(open.reports.at(-1)).toMatch(/^✗ line 5: /);
    const { node, p, reports } = make(head() + 'function onFrame() {}');
    await node.init!({ scene: fakeScene().scene });
    p.script = head() + 'function onFrame() {}\nfunction onInit( {\n';
    node.onParamChange!('script', p.script);
    expect(reports.at(-1)).toMatch(/^✗ line 5: /);
  });

  it('after onInit throws, onFrame does not run on the half-built group, and the error stays until a build succeeds (Qodo, #101)', async () => {
    const { scene } = fakeScene();
    const script = head() + 'function onInit() {\n  throw new Error("half");\n}\nfunction onFrame({ group }) { group.position.x += 1; }\n';
    const { node, p, reports } = make(script);
    const out = (await node.init!({ scene })) as { object: SceneObject };
    expect(reports.at(-1)).toBe('✗ line 5: half');
    node.update!({ scene }, frame());
    node.update!({ scene }, frame());
    expect(children(out.object)[0].position.x).toBe(0); // onFrame never ran
    expect(reports.at(-1)).toBe('✗ line 5: half');
    p.script = head() + 'function onInit() {}\nfunction onFrame({ group }) { group.position.x += 1; }\n';
    node.onParamChange!('script', p.script);
    expect(reports.at(-1)).toBe('');
    node.update!({ scene }, frame());
    expect(children(out.object)[0].position.x).toBe(1);
  });

  it('with another renderer, it fails at init with a message that names what it needs', async () => {
    const { scene } = fakeScene('Babylon.js');
    const { node } = make(head());
    await expect(node.init!({ scene })).rejects.toThrow('three.js Script needs the Three.js renderer (three.renderer); this scene is rendered by Babylon.js');
  });

  it('disposeObject3D detaches an object and disposes the geometries, materials and textures under it', () => {
    const parent = new THREE.Group();
    const group = new THREE.Group();
    parent.add(group);
    const texture = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: texture }));
    group.add(mesh);
    const disposed: string[] = [];
    mesh.geometry.addEventListener('dispose', () => disposed.push('geometry'));
    (mesh.material as THREE.Material).addEventListener('dispose', () => disposed.push('material'));
    texture.addEventListener('dispose', () => disposed.push('texture'));
    disposeObject3D(group);
    expect(parent.children).toEqual([]);
    expect(disposed.sort()).toEqual(['geometry', 'material', 'texture']);
  });

  it("disposeObject3D disposes a uniform's array of textures too (Qodo, #101)", () => {
    const textures = [new THREE.Texture(), new THREE.Texture()];
    const material = new THREE.ShaderMaterial({ uniforms: { maps: { value: textures } } });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    let disposed = 0;
    for (const t of textures) t.addEventListener('dispose', () => disposed++);
    disposeObject3D(group);
    expect(disposed).toBe(2);
  });

  it("the ring example follows its count live: onFrame adds or removes spheres (Qodo, #101)", async () => {
    const ring = THREE_SCRIPT_EXAMPLES.find((e) => e.file === 'ring.js')!;
    const { scene } = fakeScene();
    const { node, reports } = make(ring.text);
    const out = (await node.init!({ scene })) as { object: SceneObject };
    const group = children(out.object)[0];
    expect(group.children).toHaveLength(8);
    node.update!({ scene, count: 3 }, frame());
    expect(group.children).toHaveLength(3);
    node.update!({ scene, count: 12 }, frame());
    expect(group.children).toHaveLength(12);
    expect(reports.filter((r) => r)).toEqual([]);
  });
});
