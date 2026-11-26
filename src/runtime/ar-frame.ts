/**
 * The AR frame, shared by AR View and three.renderScript (#37): the camera video as background and a renderer's
 * canvas on top, both filling a box at the video's aspect, so the tracker's projection lines up with the image.
 * The canvas's drawing buffer is the video's size in device pixels, at a pixel ratio the caller gives: AR View caps
 * devicePixelRatio by its renderer's maxPixelRatio (#137), the same for both engines.
 */
import type { VideoValue } from './types';

export interface ArFrame {
  /** The box, in the stage: badges and overlays go in it. */
  wrapper: HTMLDivElement;
  /** Sizes the drawing buffer again, at the pixel ratio's current value (a live change of the cap, #137). */
  resize(): void;
  remove(): void;
}

// devicePixelRatio capped by a renderer's maxPixelRatio (#137): in the core, the source export reads it too.
export { cappedPixelRatio } from '../core/renderer';

/**
 * Mounts the video and `canvas` in a new frame in `stage`, and sizes the canvas's drawing buffer through `setSize`, at
 * `pixelRatio()` (devicePixelRatio when left out).
 */
export function mountArFrame(
  stage: HTMLElement,
  video: VideoValue,
  canvas: HTMLCanvasElement,
  setSize: (width: number, height: number) => void,
  pixelRatio: () => number = () => window.devicePixelRatio,
): ArFrame {
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const resize = () => {
    const ratio = pixelRatio();
    setSize(video.width * ratio, video.height * ratio);
  };
  resize();
  // Frames fed by one video share it: appending the video to a new frame would take it out of the earlier one, so a
  // later frame stacks its canvas over the frame that already holds the video.
  const host = video.element.parentElement;
  if (host?.classList.contains('ar-view')) {
    host.appendChild(canvas);
    return { wrapper: host as HTMLDivElement, resize, remove: () => canvas.remove() };
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'ar-view';
  // The aspect as a number too, for a layout that bounds the frame's height through its width (the studio's narrow
  // layout, #182): CSS cannot read it from `aspect-ratio`.
  wrapper.style.cssText = `position:relative;width:100%;aspect-ratio:${video.width}/${video.height};--ar-frame-aspect:${video.width / video.height};overflow:hidden;background:#000`;
  video.element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill';
  wrapper.appendChild(video.element);
  wrapper.appendChild(canvas);
  stage.appendChild(wrapper);
  return {
    wrapper,
    resize,
    remove() {
      canvas.remove();
      wrapper.remove();
    },
  };
}
