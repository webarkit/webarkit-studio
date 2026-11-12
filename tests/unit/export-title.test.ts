// The exported page's title (#120): a graph with an empty or blank name exports as "WebAR app", and the three
// exporters that write a title give the same one.
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphDocument } from '../../src/core/graph';
import { exportAppBundle } from '../../src/export/app-bundle';
import { codeEmittersFor, generateSource } from '../../src/export/codegen';
import { exportPagesProject } from '../../src/export/pages-project';

const MANIFEST = {
  entry: 'player.html',
  files: ['player.html', 'assets/player.js', 'assets/jsartoolkit-nft.js'],
  chunks: { 'assets/jsartoolkit-nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] } },
};
const ctx = { baseUrl: 'https://studio.example.com/', log: () => {} };

/** The pinball demo, named `name` (left out when undefined). */
function demo(name: string | undefined): GraphDocument {
  const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
  if (name === undefined) delete doc.name;
  else doc.name = name;
  return doc;
}

/** Answers as a static host with the player built. */
function stubHost() {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input);
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
    if (url.endsWith('player.html')) return new Response('<title>x</title><script src="./assets/player.js"></script></head>');
    return new Response(`body of ${url}`);
  });
}

const unzip = async (blob: Blob) => {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return (end: string) => strFromU8(entries[Object.keys(entries).find((name) => name.endsWith(end))!]);
};
const pageTitle = (html: string) => html.match(/<title>([^<]*)<\/title>/)![1];

afterEach(() => vi.unstubAllGlobals());

describe('the exported page title (#120)', () => {
  it.each(['', '   '])('an app bundle of a graph named %j is titled WebAR app, page and README', async (name) => {
    stubHost();
    const file = await unzip((await exportAppBundle(demo(name), ctx)).blob);
    expect(pageTitle(file('/index.html'))).toBe('WebAR app');
    expect(file('/README.txt').startsWith('WebAR app\n=========\n')).toBe(true);
  });

  it.each([
    [undefined, 'WebAR app'],
    ['', 'WebAR app'],
    ['   ', 'WebAR app'],
    ['My <app>', 'My app'],
    ['  two   spaces ', 'two spaces'],
  ])('the app bundle, the Pages project and the source code give %j the same title', async (name, title) => {
    stubHost();
    const app = await unzip((await exportAppBundle(demo(name), ctx)).blob);
    const pages = await unzip((await exportPagesProject(demo(name), ctx)).blob);
    const source = generateSource(demo(name), 'three', codeEmittersFor('three')).files;
    expect({
      app: pageTitle(app('/index.html')),
      appReadme: app('/README.txt').split('\n')[0],
      pages: pageTitle(pages('/site/index.html')),
      pagesReadme: pages('/README.md').split('\n')[0],
      source: pageTitle(source['index.html']),
      sourceReadme: source['README.md'].split('\n')[0],
    }).toEqual({ app: title, appReadme: title, pages: title, pagesReadme: `# ${title}`, source: title, sourceReadme: `# ${title}` });
  });
});
