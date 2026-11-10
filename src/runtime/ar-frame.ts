/**
 * The AR frame, shared by AR View and three.renderScript (#37): the camera video as background and a renderer's
 * canvas on top, both filling a box at the video's aspect, so the tracker's projection lines up with the image.
 * The canvas's drawing buffer is the video's size in device pixels.
 */
import type { VideoValue } from './types';

export interface ArFrame {
  /** The box, in the stage: badges and overlays go in it. */
  wrapper: HTMLDivElement;
  remove(): void;
}

/** Mounts the video and `canvas` in a new frame in `stage`, and sizes the canvas's drawing buffer through `setSize`. */
export function mountArFrame(stage: HTMLElement, video: VideoValue, canvas: HTMLCanvasElement, setSize: (width: number, height: number) => void): ArFrame {
  const wrapper = document.createElement('div');
  wrapper.className = 'ar-view';
  wrapper.style.cssText = `position:relative;width:100%;aspect-ratio:${video.width}/${video.height};overflow:hidden;background:#000`;
  video.element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill';
  wrapper.appendChild(video.element);
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  wrapper.appendChild(canvas);
  setSize(video.width * window.devicePixelRatio, video.height * window.devicePixelRatio);
  stage.appendChild(wrapper);
  return {
    wrapper,
    remove() {
      canvas.remove();
      wrapper.remove();
    },
  };
}
