/**
 * Param controls, shared by the node bodies (LitRenderPlugin) and the
 * Inspector panel. Array params (vector3, matrix4) are never changed in
 * place: every edit sets a new array, so history and the document keep theirs.
 */
import { html, nothing, type TemplateResult } from 'lit';
import type { ParamValue } from '../core/graph';
import type { ParamSpec } from '../nodes/catalog';
import { checkExpression, EXPRESSION_VARIABLES } from '../core/expression';

/** Column-major 4x4 identity. */
export const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A copy of `values` with `values[index] = value`. */
export function withComponent(values: readonly number[], index: number, value: number): number[] {
  const next = [...values];
  next[index] = value;
  return next;
}

/** The number typed in a field, or `previous` when the text is empty or not a finite number. */
export function parseNumber(text: string, previous: number): number {
  const n = text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(n) ? n : previous;
}

/** Where the control is drawn: in a node (compact) or in the Inspector (full size). */
export type ControlPlace = 'node' | 'inspector';

const numberField = (
  value: number,
  set: (v: number) => void,
  attrs: { step?: number | string; min?: number; max?: number; label?: string; disabled?: boolean },
) =>
  html`<input type="number" .value=${String(value)} step=${attrs.step ?? 'any'} min=${attrs.min ?? nothing} max=${attrs.max ?? nothing}
    aria-label=${attrs.label ?? nothing} ?disabled=${attrs.disabled}
    @change=${(e: Event) => {
      const input = e.target as HTMLInputElement;
      // Empty or invalid text keeps the value; out of range is clamped.
      const next = Math.min(attrs.max ?? Infinity, Math.max(attrs.min ?? -Infinity, parseNumber(input.value, value)));
      input.value = String(next);
      if (next !== value) set(next);
    }} />`;

/** `disabled` applies to single-field kinds; multi-field rows are disabled by their fieldset (paramRow). */
export function paramControl(
  spec: ParamSpec,
  value: ParamValue,
  set: (v: ParamValue) => void,
  place: ControlPlace = 'node',
  disabled = false,
): TemplateResult {
  switch (spec.kind) {
    case 'boolean':
      return html`<input type="checkbox" .checked=${Boolean(value)} ?disabled=${disabled}
        @change=${(e: Event) => set((e.target as HTMLInputElement).checked)} />`;
    case 'number':
      return numberField(Number(value), set, { step: spec.step, min: spec.min, max: spec.max, disabled });
    case 'select':
      // .selected (property): the attribute is ignored once the user picked an option.
      return html`<select ?disabled=${disabled} @change=${(e: Event) => set((e.target as HTMLSelectElement).value)}>
        ${Object.entries(spec.options).map(([label, v]) => html`<option value=${v} .selected=${v === value}>${label}</option>`)}
      </select>`;
    case 'color':
      return html`<input type="color" .value=${String(value)} ?disabled=${disabled} @input=${(e: Event) => set((e.target as HTMLInputElement).value)} />`;
    case 'vector3': {
      const v = Array.isArray(value) && value.length === 3 ? value : spec.default;
      return html`<span class="vector" title=${spec.unit ? `x, y, z (${spec.unit})` : 'x, y, z'}>
        ${['x', 'y', 'z'].map((axis, i) => numberField(v[i], (n) => set(withComponent(v, i, n)), { step: spec.step, label: `${spec.label} ${axis}` }))}
      </span>`;
    }
    case 'matrix4': {
      const m = Array.isArray(value) && value.length === 16 ? value : spec.default;
      if (place === 'node') return html`<span class="matrix-summary" title="Edit it in the Inspector">4×4 matrix</span>`;
      // Shown row by row; stored column-major: row r, column c is m[c * 4 + r].
      return html`<span class="matrix">
          ${[0, 1, 2, 3].map((r) =>
            [0, 1, 2, 3].map((c) => numberField(m[c * 4 + r], (n) => set(withComponent(m, c * 4 + r, n)), { label: `${spec.label} row ${r + 1} column ${c + 1}` })),
          )}
        </span>
        <button class="matrix-reset" @click=${() => set([...IDENTITY_MATRIX])}>Identity</button>`;
    }
    default:
      // Asset params suggest the project's uploads of their kind (datalists kept by the assets panel).
      return html`<input type="text" .value=${String(value)} ?disabled=${disabled} list=${spec.kind === 'string' && spec.asset ? `assets-${spec.asset}` : nothing}
        @change=${(e: Event) => set((e.target as HTMLInputElement).value)} />`;
  }
}

let rowIds = 0;

/**
 * A labelled param row: the name (⚡ for live params) and its control. Rows
 * with several fields (vector3, matrix4) are a group named by the label, not
 * a <label>, which would only label the first field.
 */
export function paramRow(
  spec: ParamSpec,
  value: ParamValue,
  set: (v: ParamValue) => void,
  place: ControlPlace = 'node',
  /** Set by a connected input of the same name: shown, not editable. */
  driven = false,
): TemplateResult {
  const name = html`${spec.label}${spec.kind === 'vector3' && spec.unit ? ` (${spec.unit})` : ''}${spec.live ? html`<i class="live">⚡</i>` : nothing}`;
  const title = driven ? 'Set by the connected input' : spec.live ? 'Live: applied while running' : 'Applied on the next Run';
  const cls = `param param-${spec.kind} ${driven ? 'driven' : ''}`;
  if (spec.kind !== 'vector3' && spec.kind !== 'matrix4') {
    const row = html`<label class=${cls} title=${title}><span>${name}</span>${paramControl(spec, value, set, place, driven)}</label>`;
    // A formula (math.expression) shows where it is wrong, under its field.
    const error = spec.kind === 'string' && spec.syntax === 'expression' ? checkExpression(String(value), EXPRESSION_VARIABLES) : null;
    return error ? html`${row}<small class="param-error" role="alert">✗ ${error.message} (character ${error.position + 1})</small>` : row;
  }
  // A disabled fieldset disables every field of a vector or a matrix.
  const id = `param-row-${++rowIds}`;
  return html`<div class=${cls} title=${title} role="group" aria-labelledby=${id}><span id=${id}>${name}</span
    ><fieldset class="param-control" ?disabled=${driven}>${paramControl(spec, value, set, place)}</fieldset></div>`;
}
