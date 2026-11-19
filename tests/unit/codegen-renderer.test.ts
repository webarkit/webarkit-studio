// The source code export of three.renderer's options (#137): with the defaults the code is what it was before; each
// option set on the node is written with three.js's own names, run here against three; the pixel ratio cap sizes the
// canvas the way AR View does in the studio.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument, ParamValue } from '../../src/core/graph';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';

function withRenderer(params: Record<string, ParamValue>): GraphDocument {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
  const node = doc.nodes.find((n) => n.id === 'renderer')!;
  node.params = { ...node.params, ...params };
  return doc;
}
const main = (doc: GraphDocument) => generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];

/** The renderer's statements, run with three (WebGLRenderer replaced by a stand-in that keeps what it was given). */
function runRenderer(code: string) {
  const start = code.indexOf('const renderer = new THREE.WebGLRenderer(');
  const end = code.indexOf('renderer.shadowMap.type = THREE.PCFShadowMap;', start);
  const block = code.slice(start, end);
  class Stand {
    shadowMap = { enabled: false, type: 0 };
    toneMapping = THREE.NoToneMapping;
    toneMappingExposure = 1;
    outputColorSpace = THREE.SRGBColorSpace;
    constructor(public params: object) {}
  }
  return new Function('THREE', `${block}\nreturn renderer;`)({ ...THREE, WebGLRenderer: Stand }) as Stand;
}

describe('the exported three.renderer (#137)', () => {
  it('with the defaults, the renderer and the canvas size are written as before', () => {
    const code = main(withRenderer({}));
    expect(code).toContain('const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });');
    expect(code).not.toContain('toneMapping');
    expect(code).not.toContain('outputColorSpace');
    expect(code).toMatch(/renderer\.setSize\(\w+\.videoWidth \* devicePixelRatio, \w+\.videoHeight \* devicePixelRatio, false\);/);
  });

  it('each option with three.js names, as the studio sets them; it parses', () => {
    const code = main(
      withRenderer({ antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: true, toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1.25, outputColorSpace: 'srgb-linear' }),
    );
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    const r = runRenderer(code);
    expect(r.params).toEqual({ alpha: true, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true, stencil: true });
    expect(r).toMatchObject({ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.25, outputColorSpace: THREE.LinearSRGBColorSpace });
  });

  it('the cap and the exposure are read as the studio reads them: a cap below the floor is the floor, a string is not a number', () => {
    const code = main(withRenderer({ maxPixelRatio: 0.001, toneMapping: 'LinearToneMapping', toneMappingExposure: '2' }));
    expect(code).toContain('const renderer_pixel_ratio = Math.min(devicePixelRatio, 0.25);');
    expect(code).not.toContain('toneMappingExposure');
  });

  it('a pixel ratio cap: the canvas is sized at the capped ratio', () => {
    const code = main(withRenderer({ maxPixelRatio: 1.5 }));
    expect(code).toContain('const renderer_pixel_ratio = Math.min(devicePixelRatio, 1.5);');
    expect(code).toMatch(/renderer\.setSize\(\w+\.videoWidth \* renderer_pixel_ratio, \w+\.videoHeight \* renderer_pixel_ratio, false\);/);
  });
});
