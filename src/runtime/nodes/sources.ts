import type { ParamValue } from '../../core/graph';
import type { NodeFactory, VideoValue } from '../types';

/** Resolves a source's URL param; an empty one would resolve to the page itself. */
function sourceUrl(value: ParamValue, baseUrl: string, what: string): string {
  const url = String(value ?? '').trim();
  if (!url) throw new Error(`no ${what} URL set`);
  return new URL(url, baseUrl).href;
}

/** A source with no picture size (an SVG without one, an audio-only file) would give the tracker an empty frame. */
function videoValue(element: HTMLImageElement | HTMLVideoElement, width: number, height: number, url: string): VideoValue {
  if (!width || !height) throw new Error(`${url} has no picture size`);
  return { element, width, height };
}

const LOAD_HINT = 'missing file, unsupported format, or a cross-origin server without CORS headers';

/** source.camera — opens the device camera. */
export const cameraSource: NodeFactory = (params) => {
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;

  return {
    async init() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: String(params.facingMode),
          width: { ideal: Number(params.width) },
          height: { ideal: Number(params.height) },
        },
      });
      video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const value: VideoValue = { element: video, width: video.videoWidth, height: video.videoHeight };
      return { video: value };
    },
    dispose() {
      stream?.getTracks().forEach((t) => t.stop());
      video?.remove();
    },
  };
};

/**
 * source.image — a still image as the video source, for testing without a
 * camera. Every frame processes the same picture.
 */
export const imageSource: NodeFactory = (params, ctx) => {
  let image: HTMLImageElement | null = null;

  return {
    async init() {
      const url = sourceUrl(params.url, ctx.baseUrl, 'image');
      image = document.createElement('img');
      // Without CORS, a cross-origin image taints the controller's canvas and getImageData() throws.
      image.crossOrigin = 'anonymous';
      image.src = url;
      try {
        await image.decode();
      } catch (err) {
        throw new Error(`could not load image ${url} (${LOAD_HINT}): ${(err as Error).message}`);
      }
      return { video: videoValue(image, image.naturalWidth, image.naturalHeight, url) };
    },
    dispose() {
      image?.remove();
      image?.removeAttribute('src');
    },
  };
};

/** source.videoFile — a recorded video as the video source, for testing without a camera. */
export const videoFileSource: NodeFactory = (params, ctx) => {
  let video: HTMLVideoElement | null = null;

  return {
    async init() {
      const url = sourceUrl(params.url, ctx.baseUrl, 'video file');
      video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.playsInline = true;
      // Muted, so autoplay is allowed without a user gesture.
      video.muted = true;
      video.loop = Boolean(params.loop);
      video.src = url;
      try {
        await video.play();
      } catch (err) {
        throw new Error(`could not play video ${url} (${LOAD_HINT}): ${(err as Error).message}`);
      }
      return { video: videoValue(video, video.videoWidth, video.videoHeight, url) };
    },
    onParamChange(key, value) {
      if (key !== 'loop' || !video) return;
      video.loop = Boolean(value);
      // An ended video stays on its last frame: looping it means playing it again.
      if (video.loop && video.ended) void video.play();
    },
    dispose() {
      if (!video) return;
      video.pause();
      // Releases the file's decoder and buffers.
      video.removeAttribute('src');
      video.load();
      video.remove();
    },
  };
};
