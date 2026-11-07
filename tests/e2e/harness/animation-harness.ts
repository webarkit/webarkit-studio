/**
 * The real renderer adapters in a page, for tests/e2e/animations.spec.ts: pause and stop have no node
 * to reach them until action.playAnimation exists, and the studio has no hook for tests. Bundled and
 * injected by that spec, never part of the studio's build.
 */
import { createBabylonAdapter } from '../../../src/runtime/renderers/babylon-adapter';
import { createThreeAdapter } from '../../../src/runtime/renderers/three-adapter';
import type { AnimationOptions, RendererAdapter, SceneHandle, SceneObject } from '../../../src/runtime/renderers/adapter';

/** Looking down -Z at the origin, with a plain perspective: only so that render() has a projection. */
const PROJECTION = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];

/** The degrees the cube has turned about glTF +Y, from its node, as each engine holds it. */
function turn(kind: string, model: SceneObject): number {
  let quaternion: { x: number; y: number; z: number; w: number } | null = null;
  if (kind === 'Three.js') {
    (model.native as { traverse(f: (o: { name: string; quaternion: never }) => void): void }).traverse((o) => {
      if (o.name === 'cube') quaternion = o.quaternion;
    });
  } else {
    const nodes = (model.native as { getDescendants(): Array<{ name: string; rotationQuaternion: never }> }).getDescendants();
    quaternion = nodes.find((n) => n.name === 'cube')?.rotationQuaternion ?? null;
  }
  if (!quaternion) throw new Error('no cube node in the model');
  const { y, w } = quaternion as { y: number; w: number };
  return (2 * Math.atan2(y, w) * 180) / Math.PI;
}

export interface Harness {
  animations(): string[];
  primitiveAnimations(): string[];
  play(clip: string, options?: AnimationOptions): void;
  pause(): void;
  stop(): void;
  state(): ReturnType<SceneHandle['animationState']>;
  turn(): number;
  hide(): void;
  /** Lets the render loop run for this long. */
  wait(ms: number): Promise<void>;
  /** True if the adapter threw, with the message. */
  playThrows(clip: string): string | null;
  dispose(): void;
}

async function open(engine: 'three' | 'babylon', glbBase64: string): Promise<Harness> {
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

  let running = true;
  const loop = () => {
    if (!running) return;
    scene.render(PROJECTION);
    requestAnimationFrame(loop);
  };
  loop();

  return {
    animations: () => scene.animations(model),
    primitiveAnimations: () => scene.animations(primitive),
    play: (clip, options) => scene.playAnimation(model, clip, options),
    pause: () => scene.pauseAnimation(model),
    stop: () => scene.stopAnimation(model),
    state: () => scene.animationState(model),
    turn: () => turn(renderer.kind, model),
    hide: () => scene.setVisible(anchor, false),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    playThrows(clip) {
      try {
        scene.playAnimation(model, clip);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    dispose() {
      running = false;
      renderer.dispose();
      renderer.canvas.remove();
    },
  };
}

(window as unknown as { openHarness: typeof open }).openHarness = open;
