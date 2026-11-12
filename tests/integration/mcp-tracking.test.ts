// tracking_run (#8): the graph's tracker on still images, with the Node build. Needs `npm run assets`.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { FIXTURE_PHOTO } from '../helpers/frames';
import { call, connectStudio } from '../helpers/mcp-client';

let client: Client;
beforeAll(async () => {
  client = await connectStudio();
});
afterAll(() => client.close());

const FRAMES = [
  { image: FIXTURE_PHOTO, count: 10 },
  { image: 'blank', count: 12 },
];

/** Builds the tracking graph the way an agent would: only types, ports and params that catalog_list returns. */
async function agentGraph(): Promise<unknown> {
  const { value: catalog } = (await call(client, 'catalog_list', { category: 'tracking' })) as { value: { nodes: Array<{ type: string; inputs: Record<string, { type: string }>; outputs: Record<string, { type: string }> }> } };
  const byOutput = (socket: string) => catalog.nodes.find((n) => Object.values(n.outputs).some((o) => o.type === socket))!;
  const controller = catalog.nodes.find((n) => Object.values(n.outputs).some((o) => o.type === 'trackingResult') && n.inputs.video)!;
  const { value: sources } = (await call(client, 'catalog_list', { category: 'source' })) as { value: { nodes: Array<{ type: string }> } };
  const image = sources.nodes.find((n) => n.type === 'source.image')!;
  const ops: unknown[] = [
    { op: 'addNode', type: image.type, id: 'image' },
    { op: 'addNode', type: controller.type, id: 'tracker' },
    { op: 'connect', from: { node: 'image', port: 'video' }, to: { node: 'tracker', port: 'video' } },
  ];
  for (const [port, spec] of Object.entries(controller.inputs)) {
    if (port === 'video' || port === 'settings' || port === 'filter') continue;
    const source = byOutput(spec.type);
    ops.push({ op: 'addNode', type: source.type, id: port });
    ops.push({ op: 'connect', from: { node: port, port: Object.keys(source.outputs)[0] }, to: { node: 'tracker', port } });
  }
  const { value } = (await call(client, 'graph_create', { name: 'Agent graph', ops })) as { value: { graph: unknown; valid: boolean; problems: string[] } };
  expect(value.problems).toEqual([]);
  return value.graph;
}

describe('tracking_run', () => {
  it('finds the marker in the test photo with a graph built from catalog_list alone (acceptance of #8)', async () => {
    const graph = await agentGraph();
    const result = await call(client, 'tracking_run', { graph, frames: FRAMES });
    expect(result.ok).toBe(true);
    const { header, markers, frames } = (result as { value: any }).value;
    expect(header.format).toBe('webarkit-studio/trace');
    expect(frames).toHaveLength(22);
    expect(markers[0]).toMatchObject({ index: 0, name: 'pinball' });
    expect(markers[0].firstFoundFrame).toBeLessThan(10);
    expect(markers[0].foundFrames).toBeGreaterThan(0);
    const found = frames.find((f: any) => f.targets[0].found);
    expect(found.targets[0].pose).toHaveLength(16);
    expect(found.transitions).toContainEqual({ type: 'found', id: header.targets[0].id });
    expect(frames.flatMap((f: any) => f.transitions)).toContainEqual({ type: 'lost', id: header.targets[0].id });
    expect(frames[1].time - frames[0].time).toBe(33);
  });

  it('runs a demo graph by path with its settings and filter, the same way twice', async () => {
    const args = { graphPath: 'public/graphs/pinball-image.json', frames: FRAMES };
    const [a, b] = [(await call(client, 'tracking_run', args)) as { value: any }, (await call(client, 'tracking_run', args)) as { value: any }];
    expect(a.value.header.filter).toMatchObject({ kind: 'oneEuro' });
    expect(a.value.header.settings).toMatchObject({ detectionInterval: 300 });
    const poses = (r: { value: any }) => r.value.frames.map((f: any) => f.targets.map((t: any) => t.pose));
    expect(poses(a)).toEqual(poses(b));
    expect(a.value.markers[0].foundFrames).toBeGreaterThan(0);
  });

  it('rejects a controller id that is not a tracker node', async () => {
    const result = await call(client, 'tracking_run', { graphPath: 'public/graphs/multi-three.json', frames: FRAMES, controller: 'nope' });
    expect(result).toEqual({ ok: false, error: 'no tracker node "nope" (tracker nodes: controller)' });
  });

  it('tracks an older graph, upgraded, exactly as the current one, and logs the upgrade', async () => {
    const { plugins: _plugins, ...graph } = JSON.parse(readFileSync('public/graphs/pinball-image.json', 'utf8'));
    const run = async (doc: unknown) => (await call(client, 'tracking_run', { graph: doc, frames: FRAMES })) as { ok: true; value: any };
    const untimed = ({ log: _log, ...value }: any) => ({ ...value, frames: value.frames.map(({ processMs: _ms, ...f }: any) => f) });
    const [current, upgraded] = [await run({ ...graph, plugins: _plugins }), await run({ ...graph, version: 4 })];
    expect(current.value.markers[0].foundFrames).toBeGreaterThan(0);
    expect(untimed(upgraded.value)).toEqual(untimed(current.value));
    expect(upgraded.value.log[0]).toBe('↑ upgraded from v4 to v5');
    const refused = await call(client, 'tracking_run', { graph: { ...graph, version: 3 }, frames: FRAMES, summaryOnly: true });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('versions 4 to 5') });
  });

  it('writes repo-relative dataset paths and a replayable source for a photo that fills the frame', async () => {
    const { value } = (await call(client, 'tracking_run', { graphPath: 'public/graphs/pinball-image.json', frames: FRAMES, summaryOnly: true })) as { value: any };
    expect(value.header.targets.map((t: { url: string }) => t.url)).toEqual(['public/data/DataNFT/pinball']);
    expect(value.markers[0].url).toBe('public/data/DataNFT/pinball');
    expect(value.header.source).toEqual({ kind: 'sequence', photo: FIXTURE_PHOTO, sequence: [['photo', 10], ['blank', 12]], startMs: 1_700_000_000_000, frameMs: 33 });
  });

  it('rejects uploaded assets, which only the studio has', async () => {
    const graph = await agentGraph();
    const edited = (await call(client, 'graph_edit', { graph, ops: [{ op: 'setParam', node: 'dataset', key: 'url', value: 'asset://abc/pinball' }] })) as { value: { graph: unknown } };
    const result = await call(client, 'tracking_run', { graph: edited.value.graph, frames: FRAMES });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('uploaded asset') });
  });

  it('rejects images of another size than the first one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webarkit-mcp-'));
    const small = join(dir, 'small.jpg');
    writeFileSync(small, jpeg.encode({ data: Buffer.alloc(64 * 48 * 4, 128), width: 64, height: 48 }, 80).data);
    const result = await call(client, 'tracking_run', { graph: await agentGraph(), frames: [{ image: FIXTURE_PHOTO }, { image: small }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('small.jpg is 64 × 48') });
  });

  it('runs overlapping calls one after the other and gives Date.now back', async () => {
    const args = { graphPath: 'public/graphs/pinball-image.json', frames: [{ image: FIXTURE_PHOTO, count: 3 }] };
    const results = await Promise.all([call(client, 'tracking_run', args), call(client, 'tracking_run', args)]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now()).toBeGreaterThan(before);
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000);
  });

  it('returns only the summary when asked', async () => {
    const { value } = (await call(client, 'tracking_run', { graphPath: 'public/graphs/pinball-image.json', frames: FRAMES, summaryOnly: true })) as { value: any };
    expect(value.frames).toBeUndefined();
    expect(value.markers[0].foundFrames).toBeGreaterThan(0);
    expect(value.markers[0].firstPose).toHaveLength(16);
  });

  it('caps the number of frames of a run', async () => {
    const result = await call(client, 'tracking_run', { graphPath: 'public/graphs/pinball-image.json', frames: [{ image: FIXTURE_PHOTO, count: 1000 }, { image: 'blank', count: 1000 }, { image: 'blank', count: 1 }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('at most 2000 frames') });
  });

  it('caps the frames before it reads any image', async () => {
    const result = await call(client, 'tracking_run', { graphPath: 'public/graphs/pinball-image.json', frames: [{ image: 'missing.jpg', count: 1000 }, { image: 'blank', count: 1000 }, { image: 'blank', count: 1 }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('at most 2000 frames') });
  });

  it('needs a frame that is an image', async () => {
    const result = await call(client, 'tracking_run', { graph: await agentGraph(), frames: [{ image: 'blank', count: 3 }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('at least one image') });
  });
});
