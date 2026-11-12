import { ClassicPreset, type GetSchemes } from 'rete';
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';
import type { ParamValue } from '../core/graph';
import { effectiveDefinition } from '../core/script';
import { socketsCompatible, type SocketType } from '../core/sockets';

/** One Rete socket instance per socket type; compatibility = same type. */
export class TypedSocket extends ClassicPreset.Socket {
  constructor(public readonly type: SocketType) {
    super(type);
  }
  /** `this` is the output socket, `other` the input socket. */
  isCompatibleWith(other: TypedSocket) {
    return socketsCompatible(this.type, other.type);
  }
}

const sockets = new Map<SocketType, TypedSocket>();
const socketFor = (type: SocketType) => {
  if (!sockets.has(type)) sockets.set(type, new TypedSocket(type));
  return sockets.get(type)!;
};

/**
 * Editor-side node: a view of its definition plus its params. The definition is the effective one
 * (src/core/script.ts): a script node's ports and params come from its header, and follow its script.
 */
export class StudioNode extends ClassicPreset.Node<
  Record<string, TypedSocket>,
  Record<string, TypedSocket>,
  Record<string, never>
> {
  params: Record<string, ParamValue>;
  /** Runtime feedback shown in the node (Inspector values, init errors). Not saved. */
  status: { text: string; error?: boolean } | null = null;
  /** Params set by a connected input of the same name (shown disabled). Not saved: derived from the wires. */
  driven = new Set<string>();
  /** Drawn size in px, measured by the renderer (minimap, Arrange); an estimate until then. */
  width = 230;
  height = 160;

  constructor(
    readonly type: string,
    params: Record<string, ParamValue> = {},
  ) {
    const def = NODE_CATALOG[type];
    if (!def) throw new Error(`Unknown node type "${type}"`);
    super(def.label);
    this.params = { ...params };
    this.syncPorts();
  }

  /** The node's definition: the catalog's, with a script node's header ports and params. Parsed once per script text. */
  get def(): NodeDefinition {
    return effectiveDefinition({ type: this.type, params: this.params })!;
  }

  /** Makes the Rete ports match the definition: a port that is gone or changed type is removed, a new one added. */
  syncPorts(): void {
    const { inputs, outputs } = this.def;
    for (const [key, port] of Object.entries(this.inputs)) {
      if ((port?.socket as TypedSocket | undefined)?.type !== inputs[key]?.type) this.removeInput(key);
    }
    for (const [key, port] of Object.entries(this.outputs)) {
      if ((port?.socket as TypedSocket | undefined)?.type !== outputs[key]?.type) this.removeOutput(key);
    }
    for (const [key, spec] of Object.entries(inputs)) {
      if (!this.inputs[key]) this.addInput(key, new ClassicPreset.Input(socketFor(spec.type), spec.label, Boolean(spec.multiple)));
    }
    for (const [key, spec] of Object.entries(outputs)) {
      if (!this.outputs[key]) this.addOutput(key, new ClassicPreset.Output(socketFor(spec.type), spec.label));
    }
  }
}

// Typed against the base Node so the scheme satisfies the ClassicScheme constraint of rete plugins.
export class StudioConnection extends ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node> {}

export type Schemes = GetSchemes<StudioNode, StudioConnection>;
