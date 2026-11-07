/**
 * The real renderer adapters in a page, for tests/e2e/animations.spec.ts: the same table on both engines,
 * on exact times, and the studio has no hook for tests. Bundled and injected by that spec, never part of
 * the studio's build.
 *
 * Time is a manual clock, read by both engines through performance.now: step() moves it and renders,
 * so a test states exact times, and a slow machine cannot change them.
 */
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import type { AnimationOptions, RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';

/** Looking down -Z at the origin, with a plain perspective: only so that render() has a projection. */
const PROJECTION = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
const FRAME_MS = 1000 / 60;

/** The degrees a node of the model has turned about glTF +Y, as each engine holds it. */
function turn(kind: string, model: SceneObject, name: string): number {
  let quaternion: { y: number; w: number } | null = null;
  if (kind === 'Three.js') {
    (model.native as { traverse(f: (o: { name: string; quaternion: { y: number; w: number } }) => void): void }).traverse((o) => {
      if (o.name === name) quaternion = o.quaternion;
    });
  } else {
    const nodes = (model.native as { getDescendants(): Array<{ name: string; rotationQuaternion: { y: number; w: number } | null }> }).getDescendants();
    const node = nodes.find((n) => n.name === name);
    if (!node) throw new Error(`no node ${name} in the model`);
    quaternion = node.rotationQuaternion ?? { y: 0, w: 1 };
  }
  if (!quaternion) throw new Error(`no node ${name} in the model`);
  const { y, w } = quaternion;
  return (2 * Math.atan2(y, w) * 180) / Math.PI;
}

export interface Harness {
  animations(): string[];
  primitiveAnimations(): string[];
  play(clip: string, options?: AnimationOptions): void;
  pause(): void;
  stop(): void;
  state(): ReturnType<SceneHandle['animationState']>;
  turn(node?: string): number;
  hide(): void;
  /** Whether objects made invisible stay so when added: to a parent, and to the scene's root. */
  hiddenAfterAdding(): { child: boolean; root: boolean };
  /** Moves the clock by `ms` over frames of 1/60 s, rendering each. */
  step(ms: number): void;
  /** One render after a long gap, as after a hidden tab. */
  jump(ms: number): void;
  /** The clock moves, with no render. */
  advance(ms: number): void;
  /** The error's message, or null. */
  playThrows(clip: string, options?: AnimationOptions): string | null;
  dispose(): void;
}

async function open(engine: 'three' | 'babylon', glbBase64: string): Promise<Harness> {
  let now = performance.now();
  performance.now = () => now;

  const renderer: RendererAdapter = engine === 'three' ? createThreeAdapter({ antialias: false }) : createBabylonAdapter({ antialias: false });
  document.body.appendChild(renderer.canvas);
  renderer.setSize(64, 64);
  const scene = renderer.createScene({ defaultLights: true });
  const data = Uint8Array.from(atob(glbBase64), (c) => c.charCodeAt(0)).buffer;
  const model = await scene.loadModel({ data, url: 'http://localhost/cube.glb', binary: true });
  const anchor = scene.createGroup();
  scene.addRoot(anchor);
  scene.addChild(anchor, model);
  const primitive = scene.createPrimitive({ shape: 'box', size: 1, color: '#ffffff' });

  // Babylon's animation clock starts once the scene has nothing left to wait for.
  const native = model.native as { getScene?(): { getWaitingItemsCount(): number } };
  while (native.getScene && native.getScene().getWaitingItemsCount() > 0) {
    scene.render(PROJECTION);
    await new Promise((resolve) => setTimeout(resolve));
  }
  scene.render(PROJECTION);

  const frame = (ms: number) => {
    now += ms;
    scene.render(PROJECTION);
  };
  return {
    animations: () => scene.animations(model),
    primitiveAnimations: () => scene.animations(primitive),
    play: (clip, options) => scene.playAnimation(model, clip, options),
    pause: () => scene.pauseAnimation(model),
    stop: () => scene.stopAnimation(model),
    state: () => scene.animationState(model),
    turn: (node = 'cube') => turn(renderer.kind, model, node),
    hide: () => scene.setVisible(anchor, false),
    hiddenAfterAdding() {
      // Its own flag, whatever its ancestors: each engine holds it its own way.
      const hidden = (o: SceneObject) => {
        const n = o.native as { visible?: boolean; isEnabled?(checkAncestors: boolean): boolean };
        return renderer.kind === 'Three.js' ? n.visible === false : n.isEnabled!(false) === false;
      };
      const [child, root] = [scene.createGroup(), scene.createGroup()];
      scene.setVisible(child, false);
      scene.setVisible(root, false);
      scene.addChild(anchor, child);
      scene.addRoot(root);
      return { child: hidden(child), root: hidden(root) };
    },
    step(ms) {
      const frames = Math.max(1, Math.round(ms / FRAME_MS));
      for (let i = 0; i < frames; i++) frame(ms / frames);
    },
    jump: (ms) => frame(ms),
    advance(ms) {
      now += ms;
    },
    playThrows(clip, options) {
      try {
        scene.playAnimation(model, clip, options);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    dispose() {
      renderer.dispose();
      renderer.canvas.remove();
    },
  };
}

(window as unknown as { openHarness: typeof open }).openHarness = open;
