/**
 * Minimal Rete.js v2 render plugin based on lit-html.
 *
 * Rete ships maintained renderers for React, Vue, Angular and Svelte only
 * (the community rete-lit-plugin has not been updated since 2023), so this
 * plugin implements the same contract as rete-react-plugin's classic preset:
 *  - listens to `render` / `unmount` signals coming from the area plugin;
 *  - emits `render` for every socket element, so DOMSocketPosition and the
 *    connection plugin can locate sockets;
 *  - emits `rendered` after a node is drawn (the area measures it) and for
 *    every socket (DOMSocketPosition measures sockets on that signal).
 */
import { html, render, nothing, svg, type TemplateResult } from 'lit';
import { Scope } from 'rete';
import type { RenderSignal as AreaRenderSignal } from 'rete-area-plugin';
import { classicConnectionPath, getDOMSocketPosition } from 'rete-render-utils';
import type { StudioConnection, StudioNode } from './studio-node';
import { SOCKET_TYPES } from '../core/sockets';
import type { ParamSpec } from '../nodes/catalog';
import type { ParamValue } from '../core/graph';

type Position = { x: number; y: number };
type Side = 'input' | 'output';

type NodeRender = { type: 'node'; element: HTMLElement; payload: StudioNode; filled?: boolean };
type ConnectionRender = {
  type: 'connection';
  element: HTMLElement;
  payload: StudioConnection;
  start?: Position;
  end?: Position;
  filled?: boolean;
};

/** Signals exchanged with the area plugin (same shape as rete-react-plugin's). */
export type RenderSignal =
  | AreaRenderSignal<'node', { payload: StudioNode }>
  | AreaRenderSignal<'connection', { payload: StudioConnection; start?: Position; end?: Position }>
  | AreaRenderSignal<'socket', { payload: unknown; nodeId: string; side: Side; key: string }>
  | { type: 'unmount'; data: { element: HTMLElement } };

export interface LitRenderOptions {
  onParamChange: (node: StudioNode, key: string, value: ParamValue) => void;
  onRemoveNode: (node: StudioNode) => void;
  onRemoveConnection: (connection: StudioConnection) => void;
}

interface ConnectionState {
  start: Position | null;
  end: Position | null;
  unwatch: Array<() => void>;
  data: ConnectionRender;
}

export class LitRenderPlugin extends Scope<never, [RenderSignal]> {
  private readonly positions = getDOMSocketPosition<any, any>();
  private readonly nodeSockets = new Map<HTMLElement, Set<HTMLElement>>();
  private readonly connections = new Map<HTMLElement, ConnectionState>();

  constructor(private readonly opts: LitRenderOptions) {
    super('lit-render');
    this.addPipe((context) => {
      if (!context || typeof context !== 'object' || !('type' in context)) return context;
      if (context.type === 'unmount') this.unmount(context.data.element);
      else if (context.type === 'render' && !context.data.filled) {
        if (context.data.type === 'node') this.renderNode(context.data as NodeRender);
        else if (context.data.type === 'connection') this.renderConnection(context.data as ConnectionRender);
        // Socket elements are drawn as part of their node; acknowledging them with
        // `rendered` lets DOMSocketPosition measure them (connections need this).
        else if (context.data.type === 'socket') void this.parentScope().emit({ type: 'rendered', data: context.data } as RenderSignal);
        else return context;
        return { ...context, data: { ...context.data, filled: true } } as typeof context;
      }
      return context;
    });
  }

  setParent(scope: Scope<RenderSignal>): void {
    super.setParent(scope);
    this.positions.attach(this as any);
  }

  // ---------------------------------------------------------------- nodes

  private renderNode(data: NodeRender) {
    const node = data.payload;
    const stop = (e: Event) => e.stopPropagation();

    const socket = (side: Side, key: string, type: keyof typeof SOCKET_TYPES) =>
      html`<span class="socket" data-side=${side} data-key=${key} title=${SOCKET_TYPES[type].label}
        style="--socket-color:${SOCKET_TYPES[type].color}"></span>`;

    render(
      html`<div class="studio-node ${node.selected ? 'selected' : ''} cat-${node.def.category}">
        <div class="title">
          <span>${node.label}${node.def.provider !== 'core' ? html`<small>${node.def.provider}</small>` : nothing}</span>
          <button class="remove" title="Remove node" @pointerdown=${stop} @click=${() => this.opts.onRemoveNode(node)}>×</button>
        </div>
        ${Object.entries(node.def.outputs).map(
          ([key, spec]) => html`<div class="port output"><span class="port-label">${spec.label}</span>${socket('output', key, spec.type)}</div>`,
        )}
        ${Object.keys(node.def.params).length
          ? html`<div class="params" @pointerdown=${stop} @wheel=${stop}>
              ${Object.entries(node.def.params).map(([key, spec]) => this.paramEditor(node, key, spec))}
            </div>`
          : nothing}
        ${node.status
          ? html`<pre class="status ${node.status.error ? 'error' : ''}" @pointerdown=${stop} @wheel=${stop}>${node.status.text}</pre>`
          : nothing}
        ${Object.entries(node.def.inputs).map(
          ([key, spec]) =>
            html`<div class="port input">${socket('input', key, spec.type)}<span class="port-label ${spec.optional ? 'optional' : ''}"
              title=${spec.optional ? 'Optional' : 'Required'}>${spec.label}${spec.multiple ? ' ⋯' : ''}${spec.optional ? ' (opt.)' : ''}</span></div>`,
        )}
      </div>`,
      data.element,
    );

    // Register socket elements (once per element) with the area / connection plugin.
    const parent = this.parentScope();
    const known = this.nodeSockets.get(data.element) ?? new Set<HTMLElement>();
    this.nodeSockets.set(data.element, known);
    data.element.querySelectorAll<HTMLElement>('.socket').forEach((el) => {
      if (known.has(el)) return;
      known.add(el);
      const side = el.dataset.side as Side;
      const key = el.dataset.key!;
      const payload = side === 'input' ? node.inputs[key]?.socket : node.outputs[key]?.socket;
      void parent.emit({ type: 'render', data: { type: 'socket', element: el, payload, nodeId: node.id, side, key } });
    });
    void parent.emit({ type: 'rendered', data } as RenderSignal);
  }

  private paramEditor(node: StudioNode, key: string, spec: ParamSpec): TemplateResult {
    const value = node.params[key] ?? spec.default;
    const set = (v: ParamValue) => this.opts.onParamChange(node, key, v);
    let control: TemplateResult;
    switch (spec.kind) {
      case 'boolean':
        control = html`<input type="checkbox" .checked=${Boolean(value)} @change=${(e: Event) => set((e.target as HTMLInputElement).checked)} />`;
        break;
      case 'number':
        control = html`<input type="number" .value=${String(value)} min=${spec.min ?? ''} max=${spec.max ?? ''} step=${spec.step ?? 'any'}
          @change=${(e: Event) => set(Number((e.target as HTMLInputElement).value))} />`;
        break;
      case 'select':
        control = html`<select @change=${(e: Event) => set((e.target as HTMLSelectElement).value)}>
          ${Object.entries(spec.options).map(([label, v]) => html`<option value=${v} ?selected=${v === value}>${label}</option>`)}
        </select>`;
        break;
      case 'color':
        control = html`<input type="color" .value=${String(value)} @input=${(e: Event) => set((e.target as HTMLInputElement).value)} />`;
        break;
      default:
        control = html`<input type="text" .value=${String(value)} @change=${(e: Event) => set((e.target as HTMLInputElement).value)} />`;
    }
    return html`<label class="param"><span title=${spec.live ? 'Live: applied while running' : 'Applied on the next Run'}
      >${spec.label}${spec.live ? html`<i class="live">⚡</i>` : nothing}</span>${control}</label>`;
  }

  // ---------------------------------------------------------- connections

  private renderConnection(data: ConnectionRender) {
    let state = this.connections.get(data.element);
    if (!state) {
      state = { start: null, end: null, unwatch: [], data };
      const s = state;
      const { source, sourceOutput, target, targetInput } = data.payload;
      if (!data.start) s.unwatch.push(this.positions.listen(source, 'output', sourceOutput, (p) => ((s.start = p), this.drawConnection(data.element))));
      if (!data.end) s.unwatch.push(this.positions.listen(target, 'input', targetInput, (p) => ((s.end = p), this.drawConnection(data.element))));
      this.connections.set(data.element, s);
    }
    state.data = data;
    if (data.start) state.start = data.start;
    if (data.end) state.end = data.end;
    this.drawConnection(data.element);
  }

  private drawConnection(element: HTMLElement) {
    const state = this.connections.get(element);
    if (!state?.start || !state.end) return;
    const conn = state.data.payload;
    const path = classicConnectionPath([state.start, state.end], 0.3);
    const isPseudo = Boolean(state.data.start || state.data.end);
    render(
      html`<svg class="connection" style="overflow:visible;position:absolute;pointer-events:none;width:9999px;height:9999px">
        ${svg`<path d=${path} class=${isPseudo ? 'pseudo' : ''} style="pointer-events:${isPseudo ? 'none' : 'auto'}"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @dblclick=${() => this.opts.onRemoveConnection(conn)}><title>Double-click to remove</title></path>`}
      </svg>`,
      element,
    );
  }

  // --------------------------------------------------------------- unmount

  private unmount(element: HTMLElement) {
    const sockets = this.nodeSockets.get(element);
    if (sockets) {
      const parent = this.parentScope();
      sockets.forEach((el) => void parent.emit({ type: 'unmount', data: { element: el } }));
      this.nodeSockets.delete(element);
    }
    const conn = this.connections.get(element);
    if (conn) {
      conn.unwatch.forEach((u) => u());
      this.connections.delete(element);
    }
    render(nothing, element);
  }
}
