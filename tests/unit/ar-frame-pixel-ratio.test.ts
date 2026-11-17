/**
 * The pixel ratio cap (#137, the ruling on the issue): AR View sizes the renderer's drawing buffer at the video's size
 * times devicePixelRatio, capped by the renderer node's maxPixelRatio, the same way for both engines; 0 is no cap
 * (the behaviour before #137). A live change of the cap sizes the buffer again on the next frame, without a restart.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cappedPixelRatio, mountArFrame } from '../../src/runtime/ar-frame';
import { arView } from '../../src/runtime/nodes/ar-view';
import type { RuntimeContext, VideoValue } from '../../src/runtime/types';

const g = globalThis as Record<string, unknown>;
const element = () => ({ style: {} as Record<string, string>, className: '', textContent: '', hidden: false, appendChild() {}, remove() {}, classList: { contains: () => false } });
beforeEach(() => {
  g.document = { createElement: element };
  g.window = { devicePixelRatio: 3 };
});
afterEach(() => {
  delete g.document;
  delete g.window;
});

describe('cappedPixelRatio', () => {
  test.each([
    ['no cap (0)', 3, 0, 3],
    ['a cap below the device', 3, 1, 1],
    ['a fractional cap', 3, 1.5, 1.5],
    ['a cap above the device: the device', 2, 4, 2],
    ['a negative cap: no cap', 3, -1, 3],
    ['NaN: no cap', 3, Number.NaN, 3],
    ['Infinity: no cap', 3, Infinity, 3],
    ['a cap above 0 but below the floor: the floor, 0.25, so the buffer is never empty', 3, 0.001, 0.25],
    ['a device ratio that is not a positive number: 1', 0, 0, 1],
    ['a device ratio of NaN, capped: 1', Number.NaN, 2, 1],
  ])('%s', (_, device, cap, expected) => {
    expect(cappedPixelRatio(device, cap)).toBe(expected);
  });
});

const video = (): VideoValue => ({ element: element() as never, width: 640, height: 480 }) as VideoValue;

describe('mountArFrame', () => {
  test('sizes with the ratio it is given, and resize() sizes again with its current value', () => {
    const setSize = vi.fn();
    let ratio = 2;
    const frame = mountArFrame(element() as never, video(), element() as never, setSize, () => ratio);
    expect(setSize).toHaveBeenLastCalledWith(1280, 960);
    ratio = 1;
    frame.resize();
    expect(setSize).toHaveBeenLastCalledWith(640, 480);
  });

  test("without a ratio, devicePixelRatio, as before #137", () => {
    const setSize = vi.fn();
    mountArFrame(element() as never, video(), element() as never, setSize);
    expect(setSize).toHaveBeenLastCalledWith(1920, 1440);
  });
});

describe('AR View and the renderer cap', () => {
  const ctx = { nodeId: 'view', stage: element(), baseUrl: '', log() {}, report() {}, studio: true } as unknown as RuntimeContext;

  test("sizes at the capped ratio, and a live change of the renderer's cap resizes before the next render", () => {
    const setSize = vi.fn();
    const calls: string[] = [];
    const renderer = { kind: 'Three.js', canvas: element(), maxPixelRatio: 2, setSize: (w: number, h: number) => (setSize(w, h), calls.push('size')) };
    const scene = { renderer, addRoot() {}, render: () => calls.push('render') };
    const node = arView({ stats: false }, ctx);
    node.init!({ video: video(), scene, objects: [] });
    expect(setSize).toHaveBeenLastCalledWith(1280, 960);
    node.update!({}, { time: 16, delta: 16, frame: 1 });
    expect(setSize).toHaveBeenCalledTimes(1); // the cap did not change: no resize
    renderer.maxPixelRatio = 1;
    calls.length = 0;
    node.update!({}, { time: 32, delta: 16, frame: 2 });
    expect(setSize).toHaveBeenLastCalledWith(640, 480);
    expect(calls).toEqual(['size', 'render']);
    renderer.maxPixelRatio = 0;
    node.update!({}, { time: 48, delta: 16, frame: 3 });
    expect(setSize).toHaveBeenLastCalledWith(1920, 1440);
  });
});
