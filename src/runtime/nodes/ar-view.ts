/**
 * output.arView — camera video as background, the scene drawn on top through
 * the AR camera. The renderer (and its canvas) is reached through the scene.
 */
import type { CameraValue, NodeFactory, SceneObjectValue, SceneValue, VideoValue } from '../types';

export const arView: NodeFactory = (params, ctx) => {
  let scene: SceneValue | null = null;
  let wrapper: HTMLDivElement | null = null;
  let fpsLabel: HTMLDivElement | null = null;
  let fpsFrames = 0;
  let fpsTime = 0;

  return {
    init(inputs) {
      const video = inputs.video as VideoValue;
      scene = inputs.scene as SceneValue;
      const renderer = scene.renderer;

      wrapper = document.createElement('div');
      wrapper.className = 'ar-view';
      wrapper.style.cssText = `position:relative;width:100%;aspect-ratio:${video.width}/${video.height};overflow:hidden;background:#000`;
      video.element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill';
      wrapper.appendChild(video.element);

      renderer.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      wrapper.appendChild(renderer.canvas);
      renderer.setSize(video.width * window.devicePixelRatio, video.height * window.devicePixelRatio);

      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:6px;right:8px;font:11px monospace;color:#fff;opacity:.7;text-shadow:0 0 2px #000';
      badge.textContent = renderer.kind;
      wrapper.appendChild(badge);
      fpsLabel = document.createElement('div');
      fpsLabel.style.cssText = 'position:absolute;top:6px;left:8px;font:12px monospace;color:#0f0;text-shadow:0 0 2px #000';
      fpsLabel.hidden = !params.stats;
      wrapper.appendChild(fpsLabel);
      ctx.stage.appendChild(wrapper);

      for (const obj of (inputs.objects as SceneObjectValue[]) ?? []) scene.addRoot(obj);
      return {};
    },

    update(inputs, frame) {
      if (!scene) return;
      scene.render((inputs.camera as CameraValue | undefined)?.projection ?? null);

      if (fpsLabel && params.stats) {
        fpsFrames++;
        fpsTime += frame.delta;
        if (fpsTime >= 500) {
          fpsLabel.textContent = `${Math.round((fpsFrames * 1000) / fpsTime)} fps`;
          fpsFrames = 0;
          fpsTime = 0;
        }
      }
    },

    onParamChange(key, value) {
      if (key === 'stats' && fpsLabel) fpsLabel.hidden = !value;
    },

    dispose() {
      scene?.renderer.canvas.remove();
      wrapper?.remove();
    },
  };
};
