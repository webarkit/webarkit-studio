import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { markerMatrix, markerOffset, transformMatrix } from '../../src/core/math';
import { applyArProjection, placeOnMarker } from '../../src/runtime/renderers/three-ar';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { effectiveDefinition, isScriptType, scriptHeaderOf } from '../../src/core/script';

const close = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(b).forEach((v, i) => expect(a[i], `[${i}]`).toBeCloseTo(v, 9));
const INFO = { id: 0, name: 'pinball', width: 1000, height: 600, dpi: 100, widthMM: 254, heightMM: 152.4 };

describe('AR helpers shared by the Three.js adapter, the Anchor and three.renderScript (#37)', () => {
  it("markerOffset: the marker's centre (mm) when centred, else its corner", () => {
    expect(markerOffset(INFO, true)).toEqual([127, 76.2, 0]);
    expect(markerOffset(INFO, false)).toEqual([0, 0, 0]);
    expect(markerOffset(undefined, true)).toEqual([0, 0, 0]);
  });

  it('markerMatrix: the pose, then the offset in marker space (pose · T)', () => {
    const pose = transformMatrix({ position: [10, 20, -300], rotation: [0, 0, 90], scale: 1 });
    const m = markerMatrix(pose, [5, 0, 0]);
    // A quarter turn about Z sends marker +X to camera +Y.
    close(m.slice(12, 15), [10, 25, -300]);
  });

  it('applyArProjection puts the tracker projection on the camera, with its inverse; null keeps the last', () => {
    const camera = new THREE.Camera();
    const projection = new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 1, 1000).toArray();
    applyArProjection(camera, projection);
    close(camera.projectionMatrix.elements, projection);
    close(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.projectionMatrixInverse).elements, new THREE.Matrix4().elements);
    applyArProjection(camera, null);
    close(camera.projectionMatrix.elements, projection);
  });

  it('placeOnMarker: the object takes pose · offset and shows only while found', () => {
    const object = new THREE.Group();
    const pose = transformMatrix({ position: [0, 0, -400], rotation: [0, 0, 0], scale: 1 });
    placeOnMarker(object, pose, true, INFO, true);
    expect(object.matrixAutoUpdate).toBe(false);
    close(object.matrix.elements.slice(12, 15), [127, 76.2, -400]);
    expect(object.visible).toBe(true);
    placeOnMarker(object, null, false, INFO, true);
    expect(object.visible).toBe(false);
    placeOnMarker(object, pose, false, INFO, true);
    expect(object.visible).toBe(false); // a pose that is not found yet: hidden, as an Anchor does
  });
});

describe('three.renderScript (#37)', () => {
  it('is in the catalog and the registry, runs code, takes the tracker side, and has no outputs', () => {
    const def = NODE_CATALOG['three.renderScript'];
    expect(NODE_REGISTRY['three.renderScript']).toBeTypeOf('function');
    expect(def).toMatchObject({ runsCode: true, provider: 'Three.js', outputs: {} });
    expect(isScriptType('three.renderScript')).toBe(true);
    expect(Object.fromEntries(Object.entries(def.inputs).map(([k, v]) => [k, [v.type, Boolean(v.optional)]]))).toEqual({
      video: ['video', false],
      pose: ['pose', false],
      found: ['boolean', true],
      projection: ['projection', false],
      markerInfo: ['markerInfo', true],
    });
  });

  it('its header adds value inputs, and takes no out lines (no outputs) nor a fixed port name', () => {
    const text = '/*\nin size number d=60\nout x number\nin pose number\n*/\n';
    expect(scriptHeaderOf(text, 'three.renderScript').errors.map((e) => e.line)).toEqual([3, 4]);
    const ok = effectiveDefinition({ type: 'three.renderScript', params: { script: '/*\nin size number d=60\n*/\n' } })!;
    expect(Object.keys(ok.inputs)).toEqual(['video', 'pose', 'found', 'projection', 'markerInfo', 'size']);
    expect(ok.outputs).toEqual({});
  });
});
