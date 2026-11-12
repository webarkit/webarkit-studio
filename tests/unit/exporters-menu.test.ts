import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphDocument } from '../../src/core/graph';
import { defaultFilename, EXPORTERS } from '../../src/export/exporters';

describe('the Export menu', () => {
  it('lists the core formats, the source code export last, where its placeholder was before #30 (#64)', () => {
    expect(EXPORTERS.map((e) => e.id)).toEqual(['graph-json', 'project', 'app-bundle', 'pages-project', 'source-code']);
  });
});

describe('the default file name, before the export runs (#118)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const MANIFEST = {
    entry: 'player.html',
    files: ['player.html', 'assets/player.js', 'assets/jsartoolkit-nft.js'],
    chunks: { 'assets/jsartoolkit-nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] } },
  };

  it.each(EXPORTERS.map((e) => [e.id, e] as const))('is the name %s gives its file, with its type', async (_, exporter) => {
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
      if (url.endsWith('player.html')) return new Response('<title>x</title><script src="./assets/player.js"></script></head>');
      return new Response(`body of ${url}`);
    });
    const doc = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    doc.name = 'My Graph';
    const { filename, blob } = await exporter.run(doc, { baseUrl: 'https://studio.example.com/', log: () => {} });
    expect(defaultFilename(exporter, doc)).toBe(filename);
    expect(filename).toBe(`my-graph${exporter.suffix}`);
    expect(blob.type).toBe(exporter.mime);
    expect(exporter.suffix.endsWith(exporter.extension)).toBe(true);
  });

  it("the source code export refuses a graph it cannot write before the save dialog, with run()'s own message", async () => {
    const source = EXPORTERS.find((e) => e.id === 'source-code')!;
    const refused = JSON.parse(readFileSync('public/graphs/pinball-babylon.json', 'utf8')) as GraphDocument;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => (fetched.push(String(input)), new Response('x')));
    let checked: unknown;
    try {
      source.precheck!(refused);
    } catch (err) {
      checked = err;
    }
    expect((checked as Error).message).toContain('babylon.renderer');
    expect(fetched).toEqual([]); // no zip, no asset
    const ran = await source.run(refused, { baseUrl: 'https://studio.example.com/', log: () => {} }).catch((err: unknown) => err);
    expect((ran as Error).message).toBe((checked as Error).message);
    // A graph it writes passes, untouched.
    const written = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    const before = JSON.stringify(written);
    expect(() => source.precheck!(written)).not.toThrow();
    expect(JSON.stringify(written)).toBe(before);
  });

  it('keeps webar-app for a graph with no name', () => {
    expect(EXPORTERS.map((e) => defaultFilename(e, { name: '' }))).toEqual([
      'webar-app.json',
      'webar-app.webarkit.zip',
      'webar-app.zip',
      'webar-app-pages.zip',
      'webar-app-source.zip',
    ]);
  });
});
