/**
 * Per-frame cost of a graph of math nodes (#65): chains of Add and Multiply, half fed by Time (their inputs
 * change every frame), half by a Number (their inputs never change, so pure nodes need not compute).
 *
 *   npm run bench -- math
 */
import { Bench } from 'tinybench';
import { GRAPH_VERSION, type GraphDocument } from '../../src/core/graph';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { GraphRuntime } from '../../src/runtime/runtime';

/** `chains` chains of `length` math nodes each; even chains start from Time, odd ones from a Number. */
export function mathGraph(chains: number, length: number): GraphDocument {
  const nodes: GraphDocument['nodes'] = [];
  const edges: GraphDocument['edges'] = [];
  for (let c = 0; c < chains; c++) {
    const head = `h${c}`;
    nodes.push(c % 2 === 0 ? { id: head, type: 'math.time', params: { speed: 1 } } : { id: head, type: 'math.number', params: { value: 2 } });
    let from = { node: head, port: c % 2 === 0 ? 'seconds' : 'value' };
    for (let i = 0; i < length; i++) {
      const id = `c${c}n${i}`;
      nodes.push({ id, type: i % 2 === 0 ? 'math.add' : 'math.multiply', params: { a: 0, b: 1.0001 } });
      edges.push({ id: `e${c}-${i}`, from, to: { node: id, port: 'a' } });
      from = { node: id, port: 'value' };
    }
  }
  return { format: 'webarkit-studio/graph', version: GRAPH_VERSION, nodes, edges };
}

export async function mathBench(): Promise<Bench> {
  const bench = new Bench({ name: 'runtime.tick() — one frame, math nodes (half the chains quiet)', time: 500 });
  for (const [chains, length] of [
    [4, 16],
    [8, 32],
  ]) {
    const doc = mathGraph(chains, length);
    const runtime = new GraphRuntime(doc, { stage: {} as HTMLElement, log: () => {}, catalog: NODE_CATALOG, registry: NODE_REGISTRY, frameLoop: false });
    await runtime.start();
    let t = 0;
    bench.add(`${doc.nodes.length} nodes (${chains} chains × ${length})`, () => runtime.tick((t += 16)));
  }
  return bench;
}
