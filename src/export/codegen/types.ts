/**
 * Source code export (#64): the types of the per-node emitters, shared by the core and the plugins (through the
 * plugin API). An emitter turns one node into source text for one target; it holds no renderer and no catalog data.
 *
 * Targets are keys, so a second one (an A-Frame page, later) is additive: `three` is the only one implemented.
 */
import type { GraphNode, ParamValue } from '../../core/graph';

/** What the generated project is written for. Only `three` exists today. */
export type CodeTarget = 'three';

/** What an emitter gets: its node, and helpers that keep the generated code safe and consistent. */
export interface CodeEmitContext {
  node: GraphNode;
  /** The node's params, with the catalog defaults filled in. */
  params: Record<string, ParamValue>;
  /**
   * The source expression of each wired input: the variable an upstream emitter named for that output. A port
   * that takes several links gets an array (in link order); an unwired port is absent. A value is resolved when it
   * is read, so `port in inputs` tells whether a port is wired without needing an upstream value.
   */
  inputs: Record<string, string | string[] | undefined>;
  /**
   * Everything the node wired to `port` gives, by name: its outputs, and the extra values an emitter exposes for
   * the nodes after it (the Scene gives `renderer`). Undefined when the port is unwired.
   */
  from(port: string): Record<string, string> | undefined;
  /** As `from`, for every link of a port that takes several: the upstream node's id, and what it gives. */
  fromEach(port: string): Array<{ node: string; outputs: Record<string, string> }>;
  /** A variable name of this node's, unique in the file: `name()` is the node's own, `name('x')` one derived from it. */
  name(suffix?: string): string;
  /** A JavaScript literal of a value (strings quoted and escaped). */
  literal(value: unknown): string;
}

/** One node's part of the generated project. */
export interface EmittedNode {
  /** Import lines this code needs; the same line from several nodes is written once. */
  imports?: string[];
  /** Code run once, top to bottom, after the nodes before it in the graph's order. */
  setup?: string;
  /** Code run every frame, in the graph's order. `delta` (ms) and `time` (ms) are in scope. */
  frame?: string;
  /**
   * The variable (or expression) each output port gives to the nodes it is wired to, with the same values as the
   * studio's ports (a `video` is a playing HTMLVideoElement). Extra keys are read through `from()`.
   */
  outputs?: Record<string, string>;
  /**
   * Names the code declares itself, other than through `name()`: its block locals, callback parameters and
   * destructured names. No node gets one of them as its variable, so none is shadowed or declared twice.
   */
  locals?: string[];
  /** npm dependencies of the generated project: exact versions. */
  dependencies?: Record<string, string>;
  /** Files of the generated project, by path (text). */
  files?: Record<string, string>;
  /** Commands the project runs before `dev` and `build` (for example a script that copies worker files). */
  prepare?: string[];
}

/** The emitter of one node type, for one target. Throwing an Error refuses the node, with the error's message. */
export type CodeEmitter = (ctx: CodeEmitContext) => EmittedNode;

/** Emitters by target, then by node type: what the core and each plugin contribute. */
export type CodeEmitters = Partial<Record<CodeTarget, Record<string, CodeEmitter>>>;
