// Source code export (#64): the walk, the file assembly and the refusals, on pinball-three.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import type { GraphDocument } from '../../src/core/graph';
import { generateSource, CodegenError, codeEmittersFor } from '../../src/export/codegen';

const graph = (name: string): GraphDocument => JSON.parse(readFileSync(`public/graphs/${name}.json`, 'utf8'));
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const pkg = (name: string) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version as string;

describe('source code export, Three.js (#64)', () => {
  it("pinball-three's main.js, top to bottom (golden)", async () => {
    const { files } = generateSource(graph('pinball-three'), 'three', codeEmittersFor('three'));
    await expect(lf(files['src/main.js'])).toMatchFileSnapshot('golden/pinball-three.main.js');
  });

  it('main.js is a valid module, and names every node of the graph', () => {
    const doc = graph('pinball-three');
    const main = generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(() => parse(main, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    for (const node of doc.nodes) expect(main, node.id).toContain(`// ${node.id} (${node.type})`);
  });

  it('the project: exact versions of what the studio uses, no file of the studio, a README with the commands', () => {
    const { files } = generateSource(graph('pinball-three'), 'three', codeEmittersFor('three'));
    const json = JSON.parse(files['package.json']);
    expect({ ...json.dependencies, ...json.devDependencies }).toEqual({
      three: pkg('three'),
      '@webarkit/jsartoolkit-nft': pkg('@webarkit/jsartoolkit-nft'),
      '@webarkit/camera-view': pkg('@webarkit/camera-view'),
      vite: pkg('vite'),
    });
    expect(Object.keys(files).sort()).toEqual(['README.md', 'index.html', 'package.json', 'scripts/copy-jsartoolkit-nft.mjs', 'src/main.js', 'vite.config.js']);
    expect(files['README.md']).toContain('npm install');
    expect(files['README.md']).toContain('npm run dev');
    // Nothing of the studio: every import is one of the four packages above, or Node's own.
    const imports = Object.values(files).join('\n').match(/from '[^']+'/g) ?? [];
    for (const line of imports) expect(line).toMatch(/^from '(three(\/.*)?|vite|@webarkit\/jsartoolkit-nft\/client|@webarkit\/camera-view|node:[a-z]+)'$/);
  });

  it.each([
    ['script.lite', { script: '/*\n*/\n' }],
    ['three.script', {}],
    ['three.renderScript', {}],
    ['page.event', {}],
    ['ui.button', {}],
    ['ui.slider', {}],
    ['math.add', {}],
    ['babylon.renderer', {}],
  ])('refuses a graph with a %s node, by name, and points to the standalone app', (type, params) => {
    const doc = graph('pinball-three');
    doc.nodes.push({ id: 'extra', type, params, position: { x: 0, y: 0 } } as GraphDocument['nodes'][number]);
    let error: unknown;
    try {
      generateSource(doc, 'three', codeEmittersFor('three'));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CodegenError);
    expect((error as Error).message).toContain(`extra (${type})`);
    expect((error as Error).message).toContain('Standalone app');
  });

  it('lists every node it cannot write, not only the first', () => {
    const doc = graph('pinball-three');
    for (const [id, type] of [['a', 'ui.toggle'], ['b', 'logic.and']]) doc.nodes.push({ id, type, params: {}, position: { x: 0, y: 0 } } as GraphDocument['nodes'][number]);
    expect(() => generateSource(doc, 'three', codeEmittersFor('three'))).toThrow(/a \(ui\.toggle\)[\s\S]*b \(logic\.and\)/);
  });

  it.each(['td', 'auto'])("refuses the controller's %s build by name: it needs a cross-origin isolated page", (build) => {
    const doc = graph('pinball-three');
    doc.nodes.find((n) => n.id === 'controller')!.params.build = build;
    expect(() => generateSource(doc, 'three', codeEmittersFor('three'))).toThrow(/controller \(jsartoolkitNFT\.controller\): .*(Threaded|cross-origin)/);
  });

  it('refuses a hemisphere light on an anchor by name: its sky is its world position, which the anchor would move', () => {
    const doc = graph('pinball-three');
    doc.nodes.find((n) => n.id === 'keylight')!.params.kind = 'hemisphere';
    expect(() => generateSource(doc, 'three', codeEmittersFor('three'))).toThrow(/anchor_pinball \(scene\.anchor\): .*hemisphere.*keylight/);
    // In the scene root, it is written.
    doc.edges = doc.edges.filter((e) => !(e.from.node === 'keylight' && e.to.node === 'anchor_pinball'));
    expect(generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js']).toContain('new THREE.HemisphereLight');
  });

  it.each([
    ['prim_pinball', 'position'],
    ['keylight', 'color'],
  ])("refuses %s with its %s input wired: the first version writes the params only", (id, port) => {
    // A stand-in for a node that would drive the input (math.*, color.* have no emitter yet).
    const emitters = { ...codeEmittersFor('three'), 'math.vector3': () => ({ outputs: { vector: '[0, 0, 0]' } }) };
    const doc = graph('pinball-three');
    doc.nodes.push({ id: 'driver', type: 'math.vector3', params: {}, position: { x: 0, y: 0 } } as GraphDocument['nodes'][number]);
    doc.edges.push({ id: 'drive', from: { node: 'driver', port: 'vector' }, to: { node: id, port } });
    expect(() => generateSource(doc, 'three', emitters)).toThrow(new RegExp(`${id} \\(scene\\.[a-z]+\\): its ${port} input`));
  });

  it('the first frame has a delta of 0, as the renderer adapters do', () => {
    const main = generateSource(graph('pinball-three'), 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(main).toContain('const delta = last === null ? 0 : time - last;');
  });

  it('node ids become distinct, valid variable names', () => {
    const doc = graph('pinball-three');
    const rename = (from: string, to: string) => {
      doc.nodes.find((n) => n.id === from)!.id = to;
      for (const e of doc.edges) {
        if (e.from.node === from) e.from.node = to;
        if (e.to.node === from) e.to.node = to;
      }
    };
    rename('keylight', 'key-light');
    rename('filllight', 'key_light');
    rename('scene', 'class');
    rename('renderer', '3d');
    rename('controller', 'createNFTTrackerWorker'); // the name of an import
    rename('arcamera', 'THREE');
    const main = generateSource(doc, 'three', codeEmittersFor('three')).files['src/main.js'];
    expect(() => parse(main, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
  });

  it("the plugin's emitters give the values its runtime nodes give: settings (clamped) and the dataset's name", async () => {
    const { artkSettings, artkNftDataset } = await import('../../plugins/jsartoolkit-nft/nodes');
    const { NODE_CATALOG } = await import('../../src/nodes/catalog');
    const { resolveParams } = await import('../../src/core/graph');
    const emit = codeEmittersFor('three');
    const valueOf = (type: string, params: Record<string, unknown>) => {
      const node = { id: 'n', type, params, position: { x: 0, y: 0 } } as GraphDocument['nodes'][number];
      const out = emit[type]({ node, params: resolveParams(NODE_CATALOG[type], params as never), inputs: {}, from: () => undefined, fromEach: () => [], name: () => 'n', literal: JSON.stringify });
      return JSON.parse(out.setup!.split('const n = ')[1].replace(/;$/, ''));
    };
    const settingsParams = { searchFeatureNum: 99, simThresh: 3, lostTimeout: -5, logLevel: '1' };
    const runtime = (artkSettings(resolveParams(NODE_CATALOG['jsartoolkitNFT.settings'], settingsParams as never), {} as never).init!({}) as { settings: { ar2: object } }).settings;
    expect(valueOf('jsartoolkitNFT.settings', settingsParams)).toEqual(runtime);
    const ctx = { baseUrl: 'http://x/' } as never;
    for (const params of [{ url: 'data/DataNFT/my%20marker', name: '' }, { url: 'data/DataNFT/pinball', name: 'p' }]) {
      const ran = (artkNftDataset(resolveParams(NODE_CATALOG['jsartoolkitNFT.dataset'], params as never), ctx).init!({}) as { dataset: { name: string } }).dataset;
      expect(valueOf('jsartoolkitNFT.dataset', params).name).toBe(ran.name);
    }
  });

  it('the jsartoolkitNFT plugin brings the emitters of its own nodes, keyed by target', async () => {
    const { default: plugin } = await import('../../plugins/jsartoolkit-nft/index');
    expect(Object.keys(plugin.codeEmitters?.three ?? {}).sort()).toEqual([
      'jsartoolkitNFT.cameraParams',
      'jsartoolkitNFT.controller',
      'jsartoolkitNFT.dataset',
      'jsartoolkitNFT.settings',
    ]);
  });
});
