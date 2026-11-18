/**
 * Everything that walks a document's nodes and must see inside its macros (#140): script trust, the player's refusal
 * of linked code, the plugins a graph needs, the assets of the exports, the project file and the source export.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { GRAPH_FORMAT, GRAPH_VERSION, graphPlugins, type GraphDocument } from '../../src/core/graph';
import { everyNode } from '../../src/core/macros';
import { scriptNodesIn } from '../../src/core/script';
import { assetRef } from '../../src/core/assets';
import { createScriptTrust } from '../../src/app/script-trust';
import { collectAssets } from '../../src/export/app-bundle';
import { usesAsset, usesUploadedAssets, type ExportContext } from '../../src/export/exporters';
import { exportSourceCode } from '../../src/export/codegen/export';
import { checkSourceCode } from '../../src/export/codegen/check';
import { packProject, unpackProject } from '../../src/export/project';
import { loadUnfinishedGraphDocument } from '../../src/core/migrations';
import { pluginIdsOf } from '../../src/plugins/host';
import type { StoredAsset } from '../../src/assets/asset';
import { foldIntoMacro } from '../helpers/fold-macro';

const SCRIPT = '/*\nout y number\n*/\ny = 1;';

/** Its only script is inside a macro. */
const scripted = (): GraphDocument => ({
  format: GRAPH_FORMAT,
  version: GRAPH_VERSION,
  nodes: [{ id: 'm', type: 'macro', params: { definition: 'd' } }],
  edges: [],
  macros: { d: { name: 'Scripted', nodes: [{ id: 's', type: 'script.lite', params: { script: SCRIPT } }], edges: [], outputs: { y: { node: 's', port: 'y' } } } },
});

describe('macros: scripts', () => {
  it('scriptNodesIn finds a script inside a macro, named by its definition', () => {
    expect(scriptNodesIn(scripted()).map((n) => n.id)).toEqual(['d/s']);
  });

  it('script trust asks about a script that is only inside a macro', async () => {
    const trust = createScriptTrust([]);
    expect((await trust.untrusted(scripted())).map((n) => n.id)).toEqual(['d/s']);
    await trust.trust([SCRIPT]);
    expect(await trust.untrusted(scripted())).toEqual([]);
  });
});

describe('macros: plugins', () => {
  it('pluginIdsOf and graphPlugins count the nodes inside macros', () => {
    const doc = { nodes: [{ id: 'm', type: 'macro', params: { definition: 'd' } }], macros: { d: { name: 'D', nodes: [{ id: 'x', type: 'acme.thing', params: {} }], edges: [] } } };
    expect(pluginIdsOf(doc)).toEqual(['acme']);
    expect(graphPlugins(everyNode(doc as unknown as GraphDocument).map((e) => e.node), { acme: '1.2.3' })).toEqual([{ id: 'acme', version: '1.2.3' }]);
  });
});

describe('macros: assets', () => {
  const base = new URL('http://localhost:5173/index.html');
  const uploads: StoredAsset[] = [
    { id: 'g1', name: 'inner.glb', kind: 'model', files: { '': new Blob(['glTF']) } },
    { id: 'g2', name: 'promoted.glb', kind: 'model', files: { '': new Blob(['glTF']) } },
  ];
  const ctx: ExportContext = { baseUrl: base.href, log: () => {}, assets: { get: (id) => uploads.find((a) => a.id === id), list: () => uploads } };
  const modelDoc = (): GraphDocument => ({
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    nodes: [
      { id: 'm1', type: 'macro', params: { definition: 'model' } },
      { id: 'm2', type: 'macro', params: { definition: 'model', url: assetRef('g2', 'promoted.glb') } },
    ],
    edges: [],
    macros: {
      model: {
        name: 'Model',
        nodes: [{ id: 'g', type: 'scene.gltf', params: { url: assetRef('g1', 'inner.glb') } }],
        edges: [],
        params: { url: { node: 'g', param: 'url' } },
      },
      unused: { name: 'Unused', nodes: [{ id: 'g', type: 'scene.gltf', params: { url: assetRef('nowhere', 'x.glb') } }], edges: [] },
    },
  });
  afterEach(() => vi.unstubAllGlobals());

  it('bundles an asset used only inside a macro, and one set on a macro node as a promoted param, and rewrites both', async () => {
    const doc = modelDoc();
    const files = await collectAssets(doc, base, ctx);
    expect(Object.keys(files).sort()).toEqual(['data/assets/g1/inner.glb', 'data/assets/g2/promoted.glb']);
    expect(doc.macros!.model.nodes[0].params.url).toBe('data/assets/g1/inner.glb');
    expect(doc.nodes[1].params.url).toBe('data/assets/g2/promoted.glb');
    // A macro node that does not set the promoted param keeps the definition's value: nothing written on it.
    expect(doc.nodes[0].params).toEqual({ definition: 'model' });
  });

  it('rewrites a promoted asset param named "__proto__" as an own key', async () => {
    const doc = modelDoc();
    doc.macros!.model.params = JSON.parse('{"__proto__": {"node": "g", "param": "url"}}');
    doc.nodes = [JSON.parse(`{"id": "m3", "type": "macro", "params": {"definition": "model", "__proto__": ${JSON.stringify(assetRef('g2', 'promoted.glb'))}}}`)];
    const files = await collectAssets(doc, base, ctx);
    // Its only instance overrides the definition's url: only the promoted asset is collected.
    expect(Object.keys(files)).toEqual(['data/assets/g2/promoted.glb']);
    expect(Object.getOwnPropertyDescriptor(doc.nodes[0].params, '__proto__')?.value).toBe('data/assets/g2/promoted.glb');
    expect(Object.getPrototypeOf(doc.nodes[0].params)).toBe(Object.prototype);
  });

  it('skips a definition’s asset that every instance overrides, and collects it when one instance leaves it unset (Qodo on #174)', async () => {
    // The definition's own value is an upload that is not in this project; both instances set the promoted url.
    const overridden = () => {
      const doc = modelDoc();
      doc.macros!.model.nodes[0].params.url = assetRef('gone', 'missing.glb');
      doc.nodes = [
        { id: 'm1', type: 'macro', params: { definition: 'model', url: assetRef('g1', 'inner.glb') } },
        { id: 'm2', type: 'macro', params: { definition: 'model', url: assetRef('g2', 'promoted.glb') } },
      ];
      return doc;
    };
    const doc = overridden();
    const files = await collectAssets(doc, base, ctx);
    expect(Object.keys(files).sort()).toEqual(['data/assets/g1/inner.glb', 'data/assets/g2/promoted.glb']);
    // The definition's value is left as it is: no instance reads it.
    expect(doc.macros!.model.nodes[0].params.url).toBe(assetRef('gone', 'missing.glb'));
    // One instance that leaves the promoted url unset reads the definition's value: the export fails, naming it.
    const unset = overridden();
    unset.nodes[1].params = { definition: 'model' };
    await expect(collectAssets(unset, base, ctx)).rejects.toThrow('model:g.url: asset "missing.glb" is not in this project');
  });

  it('usesUploadedAssets sees an upload inside a macro', () => {
    const doc = modelDoc();
    doc.nodes = [doc.nodes[0]];
    expect(usesUploadedAssets(doc)).toBe(true);
  });

  it('an asset used only inside a macro is in use: the Assets panel does not offer to delete it as unused', () => {
    const doc = modelDoc();
    doc.nodes = [doc.nodes[0]];
    expect(usesAsset(doc, 'g1')).toBe(true);
    expect(usesAsset(doc, 'g2')).toBe(false);
    doc.nodes = [modelDoc().nodes[1]];
    expect(usesAsset(doc, 'g2')).toBe(true);
  });

  it('a project file keeps the macros', async () => {
    const doc = modelDoc();
    const { graph } = await unpackProject(await packProject(doc, []));
    expect(loadUnfinishedGraphDocument(graph).doc.macros).toEqual(doc.macros);
  });
});

describe('macros: source code export', () => {
  afterEach(() => vi.unstubAllGlobals());
  const demo = () => JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
  // The pinball's model, anchor and logic, as in the issue.
  const folded = () => foldIntoMacro(demo(), ['select_pinball', 'anchor_pinball', 'prim_pinball', 'prim_pinball_geometry']);

  it('writes the flat graph: inner nodes get variables from their flat ids', () => {
    const { doc } = checkSourceCode(folded());
    expect(doc.nodes.some((n) => n.type === 'macro')).toBe(false);
    expect(doc.nodes.map((n) => n.id)).toContain('m1/anchor_pinball');
  });

  it('exports the same code as the flat demo, but for the names', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(`body of ${url}`));
    const ctx: ExportContext = { baseUrl: 'http://localhost:5173/', log: () => {} };
    const code = async (doc: GraphDocument) => {
      const entries = unzipSync(new Uint8Array(await (await exportSourceCode(doc, ctx)).blob.arrayBuffer()));
      return Object.keys(entries)
        .filter((n) => n.endsWith('/src/main.js'))
        .map((n) => new TextDecoder().decode(entries[n]))
        .join('\n');
    };
    const flat = await code(demo());
    const macro = await code(folded());
    expect(macro).toContain('m1_anchor_pinball');
    // The same program once the macro's prefix is removed from the variables (m1_) and the comments (m1/).
    const strip = (text: string) => text.replaceAll('m1_', '').replaceAll('// m1/', '// ');
    expect(strip(macro)).toBe(flat);
  });
});
