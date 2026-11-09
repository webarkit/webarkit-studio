/**
 * Runs part of a graph without a browser, for tracking_run (#8): the nodes
 * that feed a tracker node's inputs (camera params, datasets, settings,
 * filter). They are value nodes: their factories (the registry's, so plugins
 * included) are called and initialised as the runtime does, then disposed.
 * A script node (#35) is never run here: its code would run in the server's process.
 */
import { pathToFileURL } from 'node:url';
import { parseAssetRef } from '../core/assets';
import { resolveParams, topologicalOrder, type GraphDocument, type GraphNode } from '../core/graph';
import { effectiveDefinition, isScriptType } from '../core/script';
import { NODE_REGISTRY } from '../runtime/registry';
import type { PortValues, RuntimeContext, RuntimeNode } from '../runtime/types';

/** The base URL a graph's relative URLs resolve against: the directory the studio serves (public/). */
export const dirUrl = (dir: string) => pathToFileURL(dir).href.replace(/\/?$/, '/');

/**
 * Initialises the nodes upstream of `nodeId`'s inputs (all but `skip`) and
 * returns that node's input values (an array for `multiple` inputs, like the
 * runtime). `asset://` params are refused: uploaded assets live in the studio.
 */
export async function evaluateInputs(doc: GraphDocument, nodeId: string, skip: readonly string[], baseUrl: string, log: (m: string) => void): Promise<PortValues> {
  const into = (id: string) => doc.edges.filter((e) => e.to.node === id);
  const needed = new Set<string>();
  const queue = into(nodeId).filter((e) => !skip.includes(e.to.port)).map((e) => e.from.node);
  while (queue.length) {
    const id = queue.shift()!;
    if (needed.has(id)) continue;
    needed.add(id);
    queue.push(...into(id).map((e) => e.from.node));
  }

  const outputs = new Map<string, PortValues>();
  const instances: RuntimeNode[] = [];
  const gather = (node: GraphNode, ports: (port: string) => boolean): PortValues => {
    const inputs: PortValues = {};
    // Effective ports: a script node's come from its header (src/core/script.ts).
    for (const [key, spec] of Object.entries(effectiveDefinition(node)!.inputs)) {
      if (!ports(key)) continue;
      const values = into(node.id)
        .filter((e) => e.to.port === key)
        .map((e) => outputs.get(e.from.node)?.[e.from.port])
        .filter((v) => v !== undefined);
      inputs[key] = spec.multiple ? values : values[0];
    }
    return inputs;
  };
  // Never a script (#35): its code would run in this Node process, with no trust prompt. Checked before any node runs.
  const script = doc.nodes.find((n) => needed.has(n.id) && isScriptType(n.type));
  if (script) throw new Error(`node ${script.id} (${script.type}) is a script: the MCP server never runs scripts`);
  try {
    for (const node of topologicalOrder({ ...doc, nodes: doc.nodes.filter((n) => needed.has(n.id)) })) {
      const def = effectiveDefinition(node)!;
      const params = resolveParams(def, node.params);
      for (const [key, spec] of Object.entries(def.params)) {
        if (spec.kind === 'string' && spec.asset && parseAssetRef(String(params[key]))) {
          throw new Error(`node ${node.id}: param "${key}" is an uploaded asset (${String(params[key])}), which only the studio has; use a file path`);
        }
      }
      const ctx: RuntimeContext = {
        nodeId: node.id,
        stage: undefined as unknown as HTMLElement, // value nodes do not render
        baseUrl,
        log,
        report: () => {},
        studio: false,
        virtualFiles: {},
      };
      const instance = NODE_REGISTRY[node.type](params, ctx);
      instances.push(instance);
      outputs.set(node.id, { ...((await instance.init?.(gather(node, () => true))) ?? {}) });
    }
    return gather(doc.nodes.find((n) => n.id === nodeId)!, (port) => !skip.includes(port));
  } finally {
    for (const instance of instances.reverse()) instance.dispose?.();
  }
}

/** Pins Date.now to the frame clock while `fn` runs, so a run is repeatable (AR2 seeds rand with time(NULL)). */
export async function withPinnedClock<T>(fn: (setClock: (now: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    return await fn((now) => (clock = now));
  } finally {
    Date.now = realNow;
  }
}
