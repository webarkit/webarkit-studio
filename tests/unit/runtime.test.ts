import { describe, expect, it } from 'vitest';
import { GraphRuntime, NodeRuntimeError } from '../../src/runtime/runtime';
import type { NodeFactory } from '../../src/runtime/types';
import { graph, TEST_CATALOG, testRegistry, type Journal } from '../helpers/fake-catalog';

function runtimeFor(doc: ReturnType<typeof graph>, registry = testRegistry()) {
  return new GraphRuntime(doc, {
    stage: {} as HTMLElement,
    baseUrl: 'http://localhost/',
    log: () => {},
    catalog: TEST_CATALOG,
    registry,
    frameLoop: false,
  });
}

const chain = () =>
  graph(
    [['sink', 'test.sink'], ['b', 'test.pass'], ['a', 'test.source'], ['c', 'test.source']],
    [['a', 'value', 'b', 'value'], ['b', 'value', 'sink', 'values'], ['c', 'value', 'sink', 'values']],
  );

describe('GraphRuntime', () => {
  it('inits in topological order, updates every frame, disposes in reverse', async () => {
    const journal: Journal = [];
    const rt = runtimeFor(chain(), testRegistry(journal));
    await rt.start();
    expect(journal).toEqual(['init:a', 'init:c', 'init:b', 'init:sink']);

    journal.length = 0;
    rt.tick(16);
    expect(journal).toEqual(['update:a', 'update:c', 'update:b', 'update:sink']);

    journal.length = 0;
    rt.stop();
    expect(journal).toEqual(['dispose:sink', 'dispose:b', 'dispose:c', 'dispose:a']);
  });

  it('passes values downstream within the same frame; multiple inputs become arrays', async () => {
    const sink: unknown[][] = [];
    const rt = runtimeFor(chain(), testRegistry(undefined, sink));
    await rt.start();
    rt.tick(16); // frame 1: sources output false
    rt.tick(32); // frame 2: sources output true
    expect(sink).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it('does nothing after stop()', async () => {
    const journal: Journal = [];
    const rt = runtimeFor(chain(), testRegistry(journal));
    await rt.start();
    rt.stop();
    journal.length = 0;
    rt.tick(16);
    expect(journal).toEqual([]);
  });

  it('applies live params immediately and reports the others as restart', async () => {
    const journal: Journal = [];
    const rt = runtimeFor(chain(), testRegistry(journal));
    expect(rt.setParam('a', 'start', true)).toBe('not-running');
    await rt.start();
    expect(rt.setParam('a', 'start', true)).toBe('live');
    expect(journal).toContain('param:a.start');
    expect(rt.setParam('b', 'label', 'x')).toBe('restart');
  });

  it('reports which node failed to init and disposes the ones already created', async () => {
    const journal: Journal = [];
    const failing: Record<string, NodeFactory> = {
      ...testRegistry(journal),
      'test.pass': () => ({
        init: () => {
          throw new Error('boom');
        },
      }),
    };
    const rt = runtimeFor(chain(), failing);
    const err = await rt.start().catch((e) => e);
    expect(err).toBeInstanceOf(NodeRuntimeError);
    expect((err as NodeRuntimeError).nodeId).toBe('b');
    expect((err as Error).message).toContain('boom');
    expect(journal.filter((j) => j.startsWith('dispose'))).toEqual(['dispose:c', 'dispose:a']);
  });

  it('stops cleanly when stop() is called during an async init', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const journal: Journal = [];
    const slow: Record<string, NodeFactory> = {
      ...testRegistry(journal),
      'test.pass': () => ({
        init: async () => {
          await gate;
          return { value: true };
        },
        dispose: () => void journal.push('dispose:slow'),
      }),
    };
    const rt = runtimeFor(chain(), slow);
    const starting = rt.start();
    rt.stop(); // e.g. Reload pressed while the tracker is loading
    release();
    await starting;
    journal.length = 0;
    rt.tick(16);
    expect(journal).toEqual([]);
  });
});
