/**
 * Per-frame cost of the graph runtime itself (scheduling + input gathering),
 * with no-op nodes: what the runtime adds on top of the nodes' own work.
 *
 *   npm run bench
 */
import { Bench } from 'tinybench';
import { GraphRuntime } from '../../src/runtime/runtime';
import { chainGraph, TEST_CATALOG, testRegistry } from '../helpers/fake-catalog';

export async function runtimeBench(): Promise<Bench> {
  const bench = new Bench({ name: 'runtime.tick() — one frame, no-op nodes', time: 500 });
  for (const size of [16, 64, 256]) {
    const doc = chainGraph(size, Math.floor(size / 4));
    const runtime = new GraphRuntime(doc, {
      stage: {} as HTMLElement,
      log: () => {},
      catalog: TEST_CATALOG,
      registry: testRegistry(),
      frameLoop: false,
    });
    await runtime.start();
    let t = 0;
    bench.add(`${doc.nodes.length} nodes / ${doc.edges.length} edges`, () => runtime.tick((t += 16)));
  }
  return bench;
}
