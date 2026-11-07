/**
 * A tiny glTF 2.0 binary (GLB) written from scratch: a one-unit cube resting
 * on y = 0, flat normals, one pink PBR material. It is the scene.gltf default
 * (public/models/cube.glb, checked against this by tests/unit/gltf.test.ts)
 * and the model the e2e tests upload. Regenerate the file with:
 *
 *   npx tsx -e "import('./tests/helpers/cube-glb.ts').then(m => require('node:fs').writeFileSync('public/models/cube.glb', m.cubeGlb()))"
 *
 * cubeAnimatedGlb() is the same cube with a clip, public/models/cube-animated.glb, the same way:
 *
 *   npx tsx -e "import('./tests/helpers/cube-glb.ts').then(m => require('node:fs').writeFileSync('public/models/cube-animated.glb', m.cubeAnimatedGlb()))"
 */

/** A clip that turns the cube about glTF +Y, from 0 to `degrees`, in `seconds`: one rotation channel, two keyframes, LINEAR. */
export interface CubeClip {
  name?: string;
  seconds: number;
  degrees: number;
}

/** The cube with these clips. By default one unnamed clip, which both renderers must call animation0. */
export function cubeAnimatedGlb(clips: CubeClip[] = [{ seconds: 2, degrees: 90 }]): Uint8Array {
  return buildCube(clips);
}

export function cubeGlb(): Uint8Array {
  return buildCube([]);
}

function buildCube(clips: CubeClip[]): Uint8Array {
  // Six faces: normal, then the two axes spanning the face.
  const faces: Array<[number[], number[], number[]]> = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, u, v], f) => {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      // Centre of the cube at (0, 0.5, 0): it rests on y = 0.
      positions.push(...[0, 1, 2].map((i) => n[i] * 0.5 + u[i] * su * 0.5 + v[i] * sv * 0.5 + (i === 1 ? 0.5 : 0)));
      normals.push(...n);
    }
    const b = f * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });

  const pos = new Float32Array(positions);
  const nor = new Float32Array(normals);
  const idx = new Uint16Array(indices);
  // Each clip: its two times, then its two quaternions, after the geometry.
  const animationData = clips.map(({ seconds, degrees }) => {
    const half = (degrees * Math.PI) / 360;
    return { times: new Float32Array([0, seconds]), turns: new Float32Array([0, 0, 0, 1, 0, Math.sin(half), 0, Math.cos(half)]) };
  });
  const geometryLength = pos.byteLength + nor.byteLength + idx.byteLength + ((4 - (idx.byteLength % 4)) % 4);
  const bin = new Uint8Array(geometryLength + animationData.reduce((n, a) => n + a.times.byteLength + a.turns.byteLength, 0));
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nor.byteLength);

  const animationViews: object[] = [];
  const animationAccessors: object[] = [];
  const animations: object[] = [];
  let at = geometryLength;
  animationData.forEach(({ times, turns }, i) => {
    bin.set(new Uint8Array(times.buffer), at);
    bin.set(new Uint8Array(turns.buffer), at + times.byteLength);
    animationViews.push({ buffer: 0, byteOffset: at, byteLength: times.byteLength }, { buffer: 0, byteOffset: at + times.byteLength, byteLength: turns.byteLength });
    at += times.byteLength + turns.byteLength;
    const input = 3 + i * 2;
    animationAccessors.push(
      { bufferView: input, componentType: 5126, count: 2, type: 'SCALAR', min: [times[0]], max: [times[1]] },
      { bufferView: input + 1, componentType: 5126, count: 2, type: 'VEC4' },
    );
    animations.push({
      ...(clips[i].name !== undefined && { name: clips[i].name }),
      samplers: [{ input, output: input + 1, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
    });
  });

  const json = {
    asset: { version: '2.0', generator: 'webarkit-studio tests/helpers/cube-glb.ts' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'cube' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0.33, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: idx.byteLength, target: 34963 },
      ...animationViews,
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
      ...animationAccessors,
    ],
    ...(animations.length && { animations }),
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.byteLength % 4)) % 4;
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);

  const out = new Uint8Array(12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  view.setUint32(binAt, bin.byteLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // "BIN\0"
  out.set(bin, binAt + 8);
  return out;
}

/** The same cube as a JSON glTF with its buffer embedded as a data: URI (a self-contained .gltf). */
export function cubeGltf(): string {
  const glb = cubeGlb();
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const binAt = 20 + jsonLength;
  const bin = glb.subarray(binAt + 8, binAt + 8 + view.getUint32(binAt, true));
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
  return JSON.stringify(json);
}
