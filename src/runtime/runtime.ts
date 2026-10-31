/**
 * GraphRuntime ("player"): executes a GraphDocument.
 *
 * It depends on the graph format and the node registry only. It never imports
 * Rete.js, so the same code runs inside the studio preview and in the
 * standalone player page.
 */
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';
import { resolveParams, topologicalOrder, validateGraph, type GraphDocument, type GraphNode, type ParamValue } from '../core/graph';
import { NODE_REGISTRY } from './registry';
import type { NodeFactory, PortValues, RuntimeContext, RuntimeNode } from './types';

/** Where an input reads from: resolved once at start, read every frame. */
interface InputPlan {
  key: string;
  multiple: boolean;
  sources: Array<{ instance: Instance; port: string }>;
}

interface Instance {
  node: GraphNode;
  /** Resolved input sources (see planInputs). */
  inputs: InputPlan[];
  impl: RuntimeNode;
  /** The object handed to the factory: live param changes mutate it in place. */
  params: Record<string, ParamValue>;
  outputs: PortValues;
}

export interface RuntimeOptions {
  stage: HTMLElement;
  baseUrl?: string;
  log?: (message: string) => void;
  /** Receives per-node feedback (Inspector values). */
  onReport?: (nodeId: string, text: string) => void;
  /** Running in the studio, where someone controls the graph (see RuntimeContext.studio). */
  studio?: boolean;
  /** Node definitions and implementations; injectable for tests and benchmarks. */
  catalog?: Record<string, NodeDefinition>;
  registry?: Record<string, NodeFactory>;
  /** false = no requestAnimationFrame loop: the caller drives frames with tick(). */
  frameLoop?: boolean;
}

/** An error raised by a specific node, so the studio can point at it. */
export class NodeRuntimeError extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
  }
}

/** Result of a param change while running. */
export type ParamChangeResult = 'live' | 'restart' | 'not-running';

export class GraphRuntime {
  private readonly doc: GraphDocument;
  private readonly opts: RuntimeOptions;
  private instances = new Map<string, Instance>();
  private raf = 0;
  private running = false;

  private readonly catalog: Record<string, NodeDefinition>;
  private readonly registry: Record<string, NodeFactory>;
  private lastTime = 0;
  private frame = 0;

  constructor(doc: unknown, opts: RuntimeOptions) {
    this.catalog = opts.catalog ?? NODE_CATALOG;
    this.registry = opts.registry ?? NODE_REGISTRY;
    this.doc = validateGraph(doc, this.catalog);
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const log = this.opts.log ?? ((m: string) => console.info(`[webarkit-studio] ${m}`));

    for (const node of topologicalOrder(this.doc)) {
      const factory = this.registry[node.type];
      if (!factory) throw new NodeRuntimeError(node.id, `No runtime implementation for "${node.type}"`);
      const ctx: RuntimeContext = {
        nodeId: node.id,
        stage: this.opts.stage,
        baseUrl: this.opts.baseUrl ?? globalThis.document?.baseURI ?? 'http://localhost/',
        log,
        report: (text) => this.opts.onReport?.(node.id, text),
        studio: this.opts.studio ?? false,
      };
      const params = resolveParams(this.catalog[node.type], node.params);
      const instance: Instance = { node, inputs: [], impl: factory(params, ctx), params, outputs: {} };
      this.instances.set(node.id, instance);
      instance.inputs = this.planInputs(node);
      try {
        log(`init ${node.type} (${node.id})`);
        instance.outputs = { ...((await instance.impl.init?.(this.gatherInputs(instance))) ?? {}) };
      } catch (err) {
        this.stop();
        throw new NodeRuntimeError(node.id, `Node ${node.id} (${node.type}) failed to init: ${(err as Error).message}`);
      }
      if (!this.running) return; // stopped while awaiting
    }

    this.lastTime = performance.now();
    this.frame = 0;
    if (this.opts.frameLoop === false) return;
    const loop = (time: number) => {
      if (!this.running) return;
      this.tick(time);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Runs one frame: update() on every node, in topological order. */
  tick(time = performance.now()): void {
    if (!this.running) return;
    const delta = time - this.lastTime;
    this.lastTime = time;
    this.frame++;
    for (const inst of this.instances.values()) {
      const changed = inst.impl.update?.(this.gatherInputs(inst), { time, delta, frame: this.frame });
      if (changed) Object.assign(inst.outputs, changed);
    }
  }

  /**
   * Applies a param change to the running graph. `live` params reach the node
   * immediately; the others take effect on the next start().
   */
  setParam(nodeId: string, key: string, value: ParamValue): ParamChangeResult {
    const inst = this.instances.get(nodeId);
    if (!this.running || !inst) return 'not-running';
    const spec = this.catalog[inst.node.type]?.params[key];
    if (!spec?.live) return 'restart';
    inst.params[key] = value;
    const changed = inst.impl.onParamChange?.(key, value);
    if (changed) Object.assign(inst.outputs, changed);
    return 'live';
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const inst of [...this.instances.values()].reverse()) {
      try {
        inst.impl.dispose?.();
      } catch (err) {
        console.warn(err);
      }
    }
    this.instances.clear();
  }

  /**
   * Resolves each input to its source instances. Instances are created in
   * topological order, so every source already exists. Done once per start,
   * which keeps the per-frame cost linear in the number of edges.
   */
  private planInputs(node: GraphNode): InputPlan[] {
    const def = this.catalog[node.type];
    return Object.entries(def.inputs).map(([key, spec]) => ({
      key,
      multiple: Boolean(spec.multiple),
      sources: this.doc.edges
        .filter((e) => e.to.node === node.id && e.to.port === key)
        .map((e) => ({ instance: this.instances.get(e.from.node)!, port: e.from.port }))
        .filter((s) => s.instance),
    }));
  }

  /** Current input values for a node: single value, or an array for `multiple` inputs. */
  private gatherInputs(inst: Instance): PortValues {
    const inputs: PortValues = {};
    for (const plan of inst.inputs) {
      if (plan.multiple) {
        const values: unknown[] = [];
        for (const s of plan.sources) {
          const v = s.instance.outputs[s.port];
          if (v !== undefined) values.push(v);
        }
        inputs[plan.key] = values;
      } else {
        const s = plan.sources[0];
        inputs[plan.key] = s ? s.instance.outputs[s.port] : undefined;
      }
    }
    return inputs;
  }
}
