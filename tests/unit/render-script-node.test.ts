// three.renderScript's factory (#37), with a minimal DOM and a WebGLRenderer that draws nothing: the tests run in Node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamValue } from '../../src/core/graph';
import { effectiveDefinition, scriptHeaderOf } from '../../src/core/script';
import { resolveParams } from '../../src/core/graph';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { examplesFor } from '../../src/editor/script-examples';
import { threeRenderScript } from '../../src/runtime/nodes/three-render-script';
import type { FrameInfo, RuntimeContext } from '../../src/runtime/types';

const made: FakeRenderer[] = [];
class FakeRenderer {
  disposed = false;
  constructor() {
    made.push(this);
  }
  setSize() {}
  render() {}
  dispose() {
    this.disposed = true;
  }
}
vi.mock('three', async (importOriginal) => ({ ...(await importOriginal<typeof import('three')>()), WebGLRenderer: FakeRenderer }));

class El {
  className = '';
  style = { cssText: '' };
  children: El[] = [];
  parent: El | null = null;
  appendChild(child: El) {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  made.length = 0;
  g.document = { createElement: () => new El() };
  g.window = { devicePixelRatio: 1 };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

function make(script?: string) {
  const reports: string[] = [];
  const stage = new El();
  const ctx = { nodeId: 'render', stage, report: (t: string) => void reports.push(t), log: () => {} } as unknown as RuntimeContext;
  const params: Record<string, ParamValue> = script ? { script } : {};
  const def = effectiveDefinition({ type: 'three.renderScript', params })!;
  const node = threeRenderScript({ ...resolveParams(def, params) }, ctx);
  const inputs = { video: { element: new El(), width: 640, height: 480 }, pose: null, found: false, projection: null };
  return { node, stage, reports, inputs };
}
const FRAME = { delta: 16, time: 16 } as unknown as FrameInfo;

describe('three.renderScript, the node (#37)', () => {
  it('a render that throws shows on the node, and the frame goes on (the graph is not stopped)', async () => {
    const { node, reports, inputs } = make('/*\n*/\nfunction onInit({ renderer }) { renderer.render = () => { throw new Error("render broke"); }; }\n');
    await node.init!(inputs as never);
    expect(() => node.update!(inputs as never, FRAME)).not.toThrow();
    expect(reports.at(-1)).toMatch(/^✗ .*render broke/);
  });

  it('stopped while three.js loads: it mounts nothing, and leaves no renderer', async () => {
    const { node, stage, inputs } = make();
    const started = node.init!(inputs as never);
    node.dispose!();
    await started;
    expect(stage.children).toHaveLength(0);
    expect(made.every((r) => r.disposed)).toBe(true);
  });
});

describe('the Import menu examples (#37)', () => {
  it('every script node type has examples, and each one is accepted by its type', () => {
    for (const def of Object.values(NODE_CATALOG).filter((d) => d.runsCode)) {
      const examples = examplesFor(def.type);
      expect(examples.length, def.type).toBeGreaterThan(0);
      for (const ex of examples) expect(scriptHeaderOf(ex.text, def.type).errors, `${def.type}: ${ex.file}`).toEqual([]);
    }
  });
});
