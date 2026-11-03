import { describe, expect, it } from 'vitest';
import { light, primitive } from '../../src/runtime/nodes/scene';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { resolveParams, type ParamValue } from '../../src/core/graph';
import { transformMatrix, type SceneHandle, type SceneObject } from '../../src/runtime/renderers/adapter';
import type { FrameInfo, RuntimeContext } from '../../src/runtime/types';

const round = (m: ArrayLike<number>) => Array.from(m, (v) => Math.round(v * 1e6) / 1e6 + 0);

function fakeScene() {
  const matrices: number[][] = [];
  const mesh = { scene: null, native: 'mesh' } as unknown as SceneObject;
  const scene = {
    createPrimitive: () => mesh,
    setMatrix: (_o: SceneObject, m: ArrayLike<number>) => void matrices.push(round(m)),
    setColor: () => {},
  } as unknown as SceneHandle;
  return { scene, matrices };
}
const ctx = {} as RuntimeContext;
const frame = (delta: number) => ({ delta }) as FrameInfo;
const params = (extra: Record<string, ParamValue> = {}): Record<string, ParamValue> => ({
  ...resolveParams(NODE_CATALOG['scene.primitive'], {}),
  spin: false,
  ...extra,
});

describe('scene.primitive transform', () => {
  it('rests on the marker by default: lifted by half its size', () => {
    const { scene, matrices } = fakeScene();
    primitive(params({ size: 80 }), ctx).init!({ scene });
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [0, 0, 40], rotation: [0, 0, 0], scale: 1 })));
  });

  it('adds its position (mm) and rotation (degrees) to that resting point', () => {
    const { scene, matrices } = fakeScene();
    primitive(params({ size: 80, position: [10, -20, 5], rotation: [90, 0, 45] }), ctx).init!({ scene });
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [10, -20, 45], rotation: [90, 0, 45], scale: 1 })));
  });

  it('applies position and rotation live', () => {
    const { scene, matrices } = fakeScene();
    const p = params({ size: 80 });
    const node = primitive(p, ctx);
    node.init!({ scene });
    p.position = [0, 0, 100];
    node.onParamChange!('position', p.position);
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [0, 0, 140], rotation: [0, 0, 0], scale: 1 })));
  });

  it('spins about its own Z axis, on top of its rotation', () => {
    const { scene, matrices } = fakeScene();
    const p = params({ size: 80, rotation: [90, 0, 0], spin: true });
    const node = primitive(p, ctx);
    node.init!({ scene });
    // 0.0005 rad per ms: π/2 after π / 0.001 ms.
    node.update!({}, frame(Math.PI / 0.001));
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [0, 0, 40], rotation: [90, 0, 90], scale: 1 })));
  });

  it('a connected position input overrides the position param, frame by frame', () => {
    const { scene, matrices } = fakeScene();
    const node = primitive(params({ size: 80, position: [10, 0, 0] }), ctx);
    node.init!({ scene, position: [0, 0, 20] });
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [0, 0, 60], rotation: [0, 0, 0], scale: 1 })));
    node.update!({ scene, position: [0, 0, 30] }, frame(16));
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [0, 0, 70], rotation: [0, 0, 0], scale: 1 })));
    // Unchanged input, no spin: nothing to redraw.
    const count = matrices.length;
    node.update!({ scene, position: [0, 0, 30] }, frame(16));
    expect(matrices).toHaveLength(count);
  });

  it('without a position input (or with an invalid one) the param applies', () => {
    const { scene, matrices } = fakeScene();
    const node = primitive(params({ size: 80, position: [10, 0, 0] }), ctx);
    node.init!({ scene });
    node.update!({ scene, position: 'nope' }, frame(16));
    expect(matrices.at(-1)).toEqual(round(transformMatrix({ position: [10, 0, 40], rotation: [0, 0, 0], scale: 1 })));
  });

  it('the position input has the same name and type as the param it overrides', () => {
    expect(NODE_CATALOG['scene.primitive'].inputs.position).toMatchObject({ type: 'vector3', optional: true });
  });

  it('position and rotation are live vector3 params', () => {
    const { position, rotation } = NODE_CATALOG['scene.primitive'].params;
    expect([position.kind, position.live, rotation.kind, rotation.live]).toEqual(['vector3', true, 'vector3', true]);
  });
});

describe('colour inputs', () => {
  function colourScene() {
    const colours: number[][] = [];
    const object = { scene: null, native: 'o' } as unknown as SceneObject;
    const scene = {
      createPrimitive: () => object,
      createLight: () => object,
      addRoot: () => {},
      setMatrix: () => {},
      setColor: (_o: SceneObject, c: readonly number[]) => void colours.push([...c]),
    } as unknown as SceneHandle;
    return { scene, colours };
  }

  it('Primitive: a connected colour (with alpha) overrides the colour param', () => {
    const { scene, colours } = colourScene();
    const p = params({ color: '#ff0000' });
    const node = primitive(p, ctx);
    node.init!({ scene, color: [0, 1, 0, 0.5] });
    expect(colours.at(-1)).toEqual([0, 1, 0, 0.5]);
    // While driven, a param edit changes nothing on screen.
    p.color = '#0000ff';
    node.onParamChange!('color', '#0000ff');
    expect(colours.at(-1)).toEqual([0, 1, 0, 0.5]);
    // Unwired (no value any more): back to the param, opaque.
    node.update!({ scene }, frame(16));
    expect(colours.at(-1)).toEqual([0, 0, 1, 1]);
  });

  it('Primitive and Light are created with the param colour normalised to #rrggbb', () => {
    const specs: Array<{ color: string }> = [];
    const object = { scene: null, native: 'o' } as unknown as SceneObject;
    const scene = {
      createPrimitive: (spec: { color: string }) => (specs.push(spec), object),
      createLight: (spec: { color: string }) => (specs.push(spec), object),
      addRoot: () => {},
      setMatrix: () => {},
      setColor: () => {},
    } as unknown as SceneHandle;
    primitive(params({ color: '#f00' }), ctx).init!({ scene });
    light(resolveParams(NODE_CATALOG['scene.light'], { color: '#0f0' }), ctx).init!({ scene });
    expect(specs.map((s) => s.color)).toEqual(['#ff0000', '#00ff00']);
  });

  it('Primitive: without a colour input nothing is re-applied every frame', () => {
    const { scene, colours } = colourScene();
    const node = primitive(params({ color: '#ff0000' }), ctx);
    node.init!({ scene });
    const count = colours.length;
    node.update!({ scene }, frame(16));
    expect(colours).toHaveLength(count);
  });

  it('Light: its colour param is live, and a connected colour overrides it', () => {
    const { scene, colours } = colourScene();
    const p = resolveParams(NODE_CATALOG['scene.light'], { color: '#ffffff' });
    const node = light(p, ctx);
    node.init!({ scene });
    p.color = '#ff0000';
    node.onParamChange!('color', '#ff0000');
    expect(colours.at(-1)).toEqual([1, 0, 0, 1]);
    node.update!({ scene, color: [0, 0, 1, 0.2] }, frame(16));
    expect(colours.at(-1)).toEqual([0, 0, 1, 0.2]);
  });
});
