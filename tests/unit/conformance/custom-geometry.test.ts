/**
 * Renderer conformance, custom geometry (#129, for geometry.custom in Phase 5): what each engine does with the
 * same positions, indices and vertex colours. Node: Three.js BufferGeometry; Babylon.js VertexData on a Mesh of a
 * NullEngine scene. Which side shows is checked in the browser (tests/e2e/conformance.spec.ts, "facing").
 */
import { afterEach, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';

/** One triangle in the XY plane, counter-clockwise seen from +Z, as a marker-space custom shape would be. */
const POSITIONS = [0, 0, 0, 10, 0, 0, 0, 10, 0];
const RGB = [1, 0, 0, 0, 1, 0, 0, 0, 1];

let engine: NullEngine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});
function babylonMesh(data: VertexData): Mesh {
  engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true; // as the adapter (babylon-adapter.ts:90)
  const mesh = new Mesh('custom', scene);
  data.applyToMesh(mesh);
  return mesh;
}

describe('custom geometry conformance', () => {
  test('unindexed: Three.js keeps no index and draws the vertices in order; Babylon.js keeps no index and is not marked unindexed', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(POSITIONS, 3));
    expect(g.getIndex()).toBeNull();
    expect(g.getAttribute('position').count).toBe(3);

    const data = new VertexData();
    data.positions = POSITIONS;
    const mesh = babylonMesh(data);
    expect(mesh.getTotalVertices()).toBe(3);
    // No indices given: Babylon reports none, and draws the vertices in order only once the mesh says so.
    expect(mesh.getTotalIndices()).toBe(0);
    expect(mesh.isUnIndexed).toBe(false);
  });

  test('indices 0..n−1 generated for an unindexed geometry give the same triangle on both', () => {
    const indices = [0, 1, 2];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(POSITIONS, 3));
    g.setIndex(indices);
    const data = new VertexData();
    data.positions = POSITIONS;
    data.indices = indices;
    const mesh = babylonMesh(data);
    expect(Array.from(mesh.getIndices()!)).toEqual(Array.from(g.getIndex()!.array));
  });

  test('vertex colours: Three.js keeps RGB (itemSize 3); Babylon.js holds RGBA, stride 4, and must be given four', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('color', new THREE.Float32BufferAttribute(RGB, 3));
    expect(g.getAttribute('color').itemSize).toBe(3);

    const data = new VertexData();
    data.positions = POSITIONS;
    data.indices = [0, 1, 2];
    data.colors = RGB.flatMap((v, i) => (i % 3 === 2 ? [v, 1] : [v])); // padded with alpha 1
    const mesh = babylonMesh(data);
    const buffer = mesh.getVertexBuffer(VertexBuffer.ColorKind)!;
    expect(buffer.getSize()).toBe(4);
    expect(Array.from(mesh.getVerticesData(VertexBuffer.ColorKind)!)).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  });

  test('vertex colours given as RGB to Babylon.js: it infers stride 3 from the count, and keeps them as given', () => {
    // The issue expected Babylon to hold RGBA always; at 9.30.0 the stride follows the data's length.
    const data = new VertexData();
    data.positions = POSITIONS;
    data.indices = [0, 1, 2];
    data.colors = RGB; // 9 values for 3 vertices
    const mesh = babylonMesh(data);
    expect(mesh.getVertexBuffer(VertexBuffer.ColorKind)!.getSize()).toBe(3);
    expect(Array.from(mesh.getVerticesData(VertexBuffer.ColorKind)!)).toEqual(RGB);
  });
});
