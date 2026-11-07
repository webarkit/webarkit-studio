import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { parse } from 'yaml';
import { exportAppBundle } from '../../src/export/app-bundle';
import type { ExportContext } from '../../src/export/exporters';
import { assemblePagesProject, exportPagesProject } from '../../src/export/pages-project';
import type { GraphDocument } from '../../src/core/graph';

const WORKFLOW = '.github/workflows/deploy-pages.yml';
const NOTHING = new Uint8Array(0);
const doc = { name: 'My <app>' } as GraphDocument;
/** A player build with what the demo needs: the plugin's chunk. */
const MANIFEST = {
  entry: 'player.html',
  files: ['player.html', 'assets/player.js', 'assets/jsartoolkit-nft.js'],
  chunks: { 'assets/jsartoolkit-nft.js': { imports: [], dynamicImports: [], modules: ['plugins/jsartoolkit-nft/index.ts'] } },
};

interface Workflow {
  on: { push: { branches: string[] }; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, { environment: { name: string; url: string }; steps: Array<{ id?: string; uses?: string; with?: Record<string, string> }> }>;
}

const project = () => assemblePagesProject({ 'index.html': strToU8('<html>'), '.nojekyll': NOTHING, 'data/_ext/cube.glb': strToU8('glb') }, doc);
const workflowText = () => strFromU8(project()[WORKFLOW]);
const workflow = () => parse(workflowText()) as Workflow;
const steps = () => Object.values(workflow().jobs).flatMap((job) => job.steps);

describe('the GitHub Pages project', () => {
  it('has the app under site/, with the workflow, the README and .gitattributes beside it', () => {
    expect(Object.keys(project()).sort()).toEqual(
      ['.gitattributes', WORKFLOW, 'README.md', 'site/.nojekyll', 'site/data/_ext/cube.glb', 'site/index.html'].sort(),
    );
    expect(strFromU8(project()['site/data/_ext/cube.glb'])).toBe('glb');
  });

  it('commits every file byte for byte, whatever the line-ending setting of the machine', () => {
    expect(strFromU8(project()['.gitattributes']).trim()).toBe('* -text');
  });

  it('refuses a file whose name starts with a dot, which the deploy would drop with no error', () => {
    expect(() => assemblePagesProject({ 'index.html': NOTHING, 'data/assets/a/.cube.glb': NOTHING }, doc)).toThrow(/data\/assets\/a\/\.cube\.glb.*starts with a dot/);
    expect(() => assemblePagesProject({ 'data/.hidden/cube.glb': NOTHING }, doc)).toThrow(/data\/\.hidden\/cube\.glb/);
    // A dot inside a name, or a path starting with "_", is served.
    expect(Object.keys(assemblePagesProject({ 'data/_ext/a.b.glb': NOTHING }, doc))).toContain('site/data/_ext/a.b.glb');
  });

  describe('the workflow', () => {
    it('runs on a push to the default branch, under either usual name, and by hand', () => {
      expect(workflow().on.push.branches).toEqual(['main', 'master']);
      expect('workflow_dispatch' in workflow().on).toBe(true);
    });

    it("pins each action to the version GitHub's documentation names, in order", () => {
      // Written here as well, so that changing a version means changing this list on purpose.
      expect(steps().map((s) => s.uses)).toEqual([
        'actions/checkout@v6',
        'actions/configure-pages@v5',
        'actions/upload-pages-artifact@v4',
        'actions/deploy-pages@v4',
      ]);
    });

    it('publishes site, and nothing else', () => {
      expect(steps().find((s) => s.uses?.startsWith('actions/upload-pages-artifact'))?.with).toEqual({ path: 'site' });
    });

    it('asks for the permissions of a Pages deploy, in the github-pages environment', () => {
      expect(workflow().permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' });
      const [job] = Object.values(workflow().jobs);
      expect(job.environment.name).toBe('github-pages');
      expect(job.environment.url).toBe('${{ steps.deployment.outputs.page_url }}');
      expect(job.steps.find((s) => s.uses?.startsWith('actions/deploy-pages'))?.id).toBe('deployment');
    });

    it('uses no secret or token (id-token is the permission a Pages deploy asks for)', () => {
      expect(workflowText()).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|(?<!id-)token:/i);
    });
  });

  describe('the README', () => {
    const readme = () => strFromU8(project()['README.md']);

    it('gives the steps: a repository, the Pages source, the push and the URL', () => {
      expect(readme()).toMatch(/Create a .*repository/);
      expect(readme()).toMatch(/Settings → Pages/);
      expect(readme()).toMatch(/\*\*GitHub Actions\*\*/);
      expect(readme()).toContain('git push -u origin main');
      expect(readme()).toContain('https://<you>.github.io/<repo>/');
    });

    it('says that a camera on a phone needs the HTTPS URL', () => {
      expect(readme()).toMatch(/camera.*HTTPS/s);
    });

    it("writes the graph's name as plain text", () => {
      expect(readme().split('\n')[0]).toBe('# My app');
    });
  });
});

describe('exporting it', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The demo, reading its camera parameters from another origin: that file goes under data/_ext/. */
  function graph(): GraphDocument {
    const demo = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    demo.name = 'Pinball';
    demo.nodes.find((n) => n.type === 'jsartoolkitNFT.cameraParams')!.params.url = 'https://cdn.example.com/m/camera_para.dat';
    return demo;
  }

  /** Answers as a static host with the player built. Records what it is asked for. */
  function stubHost() {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
      if (url.endsWith('player.html')) return new Response('<title>x</title><script src="./assets/player.js"></script></head>');
      return new Response(`body of ${url}`);
    });
    return requested;
  }

  const ctx: ExportContext = { baseUrl: 'https://studio.example.com/app/index.html', log: () => {} };
  const entries = async (blob: Blob) => unzipSync(new Uint8Array(await blob.arrayBuffer()));

  it('zips the project in one folder named after the graph', async () => {
    stubHost();
    const { filename, blob } = await exportPagesProject(graph(), ctx);
    expect(filename).toBe('pinball-pages.zip');
    const files = await entries(blob);
    for (const name of ['site/index.html', 'site/graph.json', 'site/.nojekyll', 'site/assets/player.js', WORKFLOW, 'README.md', '.gitattributes']) {
      expect(Object.keys(files)).toContain(`pinball-pages/${name}`);
    }
  });

  it('carries a file from another origin under data/_ext/, and the graph points to it', async () => {
    stubHost();
    const files = await entries((await exportPagesProject(graph(), ctx)).blob);
    expect(strFromU8(files['pinball-pages/site/data/_ext/camera_para.dat'])).toBe('body of https://cdn.example.com/m/camera_para.dat');
    const site = JSON.parse(strFromU8(files['pinball-pages/site/graph.json'])) as GraphDocument;
    expect(site.nodes.find((n) => n.type === 'jsartoolkitNFT.cameraParams')!.params.url).toBe('data/_ext/camera_para.dat');
  });

  it('makes no request to GitHub, and carries no credential', async () => {
    const requested = stubHost();
    const files = await entries((await exportPagesProject(graph(), ctx)).blob);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => /github/i.test(new URL(url).hostname))).toEqual([]);
    for (const [name, data] of Object.entries(files)) {
      expect(strFromU8(data), name).not.toMatch(/gh[opsu]_[A-Za-z0-9]{20,}|github_pat_|authorization:|secrets\./i);
    }
  });

  it('refuses a graph the app export refuses: a required input left unconnected', async () => {
    stubHost();
    const unfinished = graph();
    unfinished.edges = [];
    await expect(exportPagesProject(unfinished, ctx)).rejects.toThrow(/is not connected/);
  });
});

describe('the standalone app', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has .nojekyll, so a Pages site built from a branch keeps paths starting with "_"', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(MANIFEST));
      return new Response('</head>');
    });
    const demo = JSON.parse(readFileSync('public/graphs/pinball-three.json', 'utf8')) as GraphDocument;
    demo.name = 'Pinball';
    const { blob } = await exportAppBundle(demo, { baseUrl: 'https://studio.example.com/', log: () => {} });
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(files['pinball/.nojekyll']).toEqual(new Uint8Array(0));
    expect(strFromU8(files['pinball/README.txt'])).toContain('.nojekyll');
  });
});
