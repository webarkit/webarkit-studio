import { ClassicPreset, type GetSchemes } from 'rete';
import { NODE_CATALOG, type NodeDefinition } from '../nodes/catalog';
import type { ParamValue } from '../core/graph';
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

/** Editor-side node: a view of a catalog definition plus its params. */
export class StudioNode extends ClassicPreset.Node<
  Record<string, TypedSocket>,
  Record<string, TypedSocket>,
  Record<string, never>
> {
  readonly def: NodeDefinition;
  params: Record<string, ParamValue>;
  /** Runtime feedback shown in the node (Inspector values, init errors). Not saved. */
  status: { text: string; error?: boolean } | null = null;

  constructor(
    readonly type: string,
    params: Record<string, ParamValue> = {},
  ) {
    const def = NODE_CATALOG[type];
    if (!def) throw new Error(`Unknown node type "${type}"`);
    super(def.label);
    this.def = def;
    this.params = { ...params };
    for (const [key, spec] of Object.entries(def.inputs)) {
      this.addInput(key, new ClassicPreset.Input(socketFor(spec.type), spec.label, Boolean(spec.multiple)));
    }
    for (const [key, spec] of Object.entries(def.outputs)) {
      this.addOutput(key, new ClassicPreset.Output(socketFor(spec.type), spec.label));
    }
  }
}

// Typed against the base Node so the scheme satisfies the ClassicScheme constraint of rete plugins.
export class StudioConnection extends ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node> {}

export type Schemes = GetSchemes<StudioNode, StudioConnection>;
