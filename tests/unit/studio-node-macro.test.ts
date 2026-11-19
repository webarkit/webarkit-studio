import { describe, expect, it } from 'vitest';
import { StudioNode } from '../../src/editor/studio-node';
import type { MacroDefinition, MacroDefinitions } from '../../src/core/macros';

/**
 * A macro node's ports follow its definition (#140): an exposed input that keeps its socket type but changes between
 * one wire and several must be rebuilt, or the editor's connection pipe enforces the old limit (Qodo on #175).
 */
describe('a macro node in the editor', () => {
  /** One exposed input `p`, of type sceneObject: a group's children (several wires), or Set Visible's target (one). */
  const definition = (multiple: boolean): MacroDefinition => ({
    name: 'P',
    nodes: [multiple ? { id: 'g', type: 'scene.group', params: {} } : { id: 'g', type: 'action.setVisible', params: {} }],
    edges: [],
    inputs: { p: { node: 'g', port: multiple ? 'children' : 'target' } },
  });

  it('rebuilds an exposed input that changes between one wire and several, with the same socket type', () => {
    let macros: MacroDefinitions = { d: definition(true) };
    const node = new StudioNode('macro', { definition: 'd' }, () => macros);
    expect((node.inputs.p!.socket as { type: string }).type).toBe('sceneObject');
    expect(node.inputs.p!.multipleConnections).toBe(true);

    macros = { d: definition(false) };
    node.syncPorts();
    expect((node.inputs.p!.socket as { type: string }).type).toBe('sceneObject');
    expect(node.inputs.p!.multipleConnections).toBe(false);

    macros = { d: definition(true) };
    node.syncPorts();
    expect(node.inputs.p!.multipleConnections).toBe(true);
  });
});
