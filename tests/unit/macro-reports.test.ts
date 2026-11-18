import { describe, expect, it } from 'vitest';
import { GRAPH_FORMAT, GRAPH_VERSION, type GraphDocument } from '../../src/core/graph';
import { macroReports } from '../../src/app/macro-reports';

const doc = (): GraphDocument => ({
  format: GRAPH_FORMAT,
  version: GRAPH_VERSION,
  nodes: [
    { id: 't', type: 'math.time', params: {} },
    { id: 'm', type: 'macro', params: { definition: 'd' } },
  ],
  edges: [],
  macros: {
    d: {
      name: 'Two inspectors',
      nodes: [
        { id: 'a', type: 'debug.inspector', params: {} },
        { id: 'b', type: 'debug.inspector', params: {} },
      ],
      edges: [],
    },
  },
});

describe('macroReports (#140)', () => {
  it('shows an inner node’s report on its macro node, prefixed with its label, one line per inner node', () => {
    const shown: Array<[string, unknown]> = [];
    const reports = macroReports(doc(), (node, status) => shown.push([node, status]));
    expect(reports.route('m/a', '1')).toBe(true);
    expect(reports.route('m/b', '2')).toBe(true);
    expect(shown.at(-1)).toEqual(['m', { text: 'Inspector (a): 1\nInspector (b): 2' }]);
    // An empty report clears that inner node's line only, then the whole status.
    reports.route('m/a', '');
    expect(shown.at(-1)).toEqual(['m', { text: 'Inspector (b): 2' }]);
    reports.route('m/b', '');
    expect(shown.at(-1)).toEqual(['m', null]);
  });

  it('an error shows as an error on the macro node', () => {
    const shown: Array<[string, unknown]> = [];
    const reports = macroReports(doc(), (node, status) => shown.push([node, status]));
    reports.route('m/b', 'Node m/b failed to init: boom', true);
    expect(shown.at(-1)).toEqual(['m', { text: 'Inspector (b): Node m/b failed to init: boom', error: true }]);
  });

  it('passes each inner node’s own report on, as it is, for the inside of the macro', () => {
    const inner: Array<[string, string, unknown]> = [];
    const reports = macroReports(doc(), () => {}, (macro, node, status) => inner.push([macro, node, status]));
    reports.route('m/a', '1');
    reports.route('m/b', 'boom', true);
    reports.route('m/a', '');
    expect(inner).toEqual([
      ['m', 'a', { text: '1' }],
      ['m', 'b', { text: 'boom', error: true }],
      ['m', 'a', null],
    ]);
  });

  it('leaves a node of the outer graph to the caller', () => {
    const reports = macroReports(doc(), () => {
      throw new Error('not called');
    });
    expect(reports.route('t', '1')).toBe(false);
  });
});
