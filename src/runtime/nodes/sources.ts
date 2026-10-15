import type { NodeFactory, VideoValue } from '../types';

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
