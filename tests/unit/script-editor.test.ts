import { describe, expect, it } from 'vitest';
import { StudioNode } from '../../src/editor/studio-node';
import { staleConnections, staleParams } from '../../src/editor/script-ports';
import { effectiveDefinition } from '../../src/core/script';
import { GRAPH_FORMAT, GRAPH_VERSION, validateGraph } from '../../src/core/graph';

const head = (...lines: string[]) => `/*\n${lines.join('\n')}\n*/\n`;

describe('script nodes in the editor (#35)', () => {
  it("a StudioNode's ports are its header's, and follow a new script", () => {
    const node = new StudioNode('script.lite', { script: head('in a number', 'in b vector3', 'out y number') });
    expect(Object.keys(node.inputs)).toEqual(['a', 'b']);
    expect(Object.keys(node.outputs)).toEqual(['y']);
    expect(node.def.params.a).toMatchObject({ kind: 'number' });

    node.params.script = head('in a color', 'in c number', 'out y number', 'out z boolean');
    node.syncPorts();
    expect(Object.keys(node.inputs).sort()).toEqual(['a', 'c']);
    expect((node.inputs.a!.socket as { type: string }).type).toBe('color');
    expect(Object.keys(node.outputs).sort()).toEqual(['y', 'z']);
  });

  it('the params to drop when a script changes: gone, another kind, or an option that no longer exists', () => {
    const before = effectiveDefinition({ type: 'script.lite', params: { script: head('in x number', 'in y number', 'in keep number', 'enum mode a b') } })!;
    const after = effectiveDefinition({ type: 'script.lite', params: { script: head('in x vector3', 'in keep number', 'enum mode b c') } })!;
    const params = { script: 'old', file: 'f.js', x: 5, y: 2, keep: 9, mode: 'a' };
    expect(staleParams(params, before, after)).toEqual(['x', 'y', 'mode']);
    // The node without them validates: a number left on a vector3 param would not.
    const doc = {
      format: GRAPH_FORMAT,
      version: GRAPH_VERSION,
      nodes: [{ id: 's', type: 'script.lite', params: { script: head('in x vector3', 'in keep number', 'enum mode b c'), keep: 9 } }],
      edges: [],
    };
    expect(() => validateGraph(doc)).not.toThrow();
    expect(() => validateGraph({ ...doc, nodes: [{ ...doc.nodes[0], params: { ...doc.nodes[0].params, x: 5 } }] })).toThrow('param "x" must be 3 numbers');
    // The node's own params never go.
    expect(staleParams({ script: 'x', file: 'y' }, before, after)).toEqual([]);
  });

  it('the wires to drop when a script changes: ports that are gone or changed type', () => {
    const before = effectiveDefinition({ type: 'script.lite', params: { script: head('in a number', 'in b vector3', 'out y number', 'out z vector3') } })!;
    const after = effectiveDefinition({ type: 'script.lite', params: { script: head('in a number', 'in b color', 'out y number') } })!;
    const wires = [
      { id: 'in-a', source: 'x', sourceOutput: 'value', target: 's', targetInput: 'a' },
      { id: 'in-b', source: 'x', sourceOutput: 'vector', target: 's', targetInput: 'b' },
      { id: 'out-y', source: 's', sourceOutput: 'y', target: 'w', targetInput: 'value' },
      { id: 'out-z', source: 's', sourceOutput: 'z', target: 'w', targetInput: 'position' },
      { id: 'other', source: 'x', sourceOutput: 'value', target: 'w', targetInput: 'a' },
    ];
    expect(staleConnections('s', before, after, wires).map((c) => c.id)).toEqual(['in-b', 'out-z']);
  });
});
