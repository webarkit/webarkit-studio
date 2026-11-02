import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageSource, videoFileSource } from '../../src/runtime/nodes/sources';
import type { RuntimeContext, VideoValue } from '../../src/runtime/types';

// The unit tests run in Node: a minimal stand-in for the <img> and <video> elements the sources create.
class FakeImage {
  tagName = 'IMG';
  src = '';
  crossOrigin: string | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  removed = false;
  static fail = false;
  static size = [893, 1117];
  async decode() {
    if (FakeImage.fail) throw new Error('EncodingError');
    [this.naturalWidth, this.naturalHeight] = FakeImage.size;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  remove() {
    this.removed = true;
  }
}

class FakeVideo {
  tagName = 'VIDEO';
  src = '';
  crossOrigin: string | null = null;
  muted = false;
  playsInline = false;
  loop = false;
  paused = true;
  ended = false;
  videoWidth = 0;
  videoHeight = 0;
  removed = false;
  static fail = false;
  static size = [640, 480];
  async play() {
    if (FakeVideo.fail) throw new Error('NotSupportedError');
    this.paused = false;
    this.ended = false;
    [this.videoWidth, this.videoHeight] = FakeVideo.size;
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
  remove() {
    this.removed = true;
  }
}

const created: Array<FakeImage | FakeVideo> = [];
const ctx = { nodeId: 'src', baseUrl: 'http://studio.test/app/', log: () => {}, report: () => {} } as unknown as RuntimeContext;

beforeEach(() => {
  FakeImage.fail = false;
  FakeVideo.fail = false;
  FakeImage.size = [893, 1117];
  FakeVideo.size = [640, 480];
  created.length = 0;
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      const el = tag === 'img' ? new FakeImage() : new FakeVideo();
      created.push(el);
      return el;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('source.image', () => {
  it('outputs the decoded image as a video value, at its natural size', async () => {
    const node = imageSource({ url: 'data/pinball-demo.jpg' }, ctx);
    const out = (await node.init!({})) as { video: VideoValue };
    const img = created[0] as FakeImage;
    expect(img.src).toBe('http://studio.test/app/data/pinball-demo.jpg');
    // Without CORS, a cross-origin image taints the controller's canvas and getImageData() throws.
    expect(img.crossOrigin).toBe('anonymous');
    expect(out.video).toEqual({ element: img, width: 893, height: 1117 });
  });

  it('fails the init with the URL when the image cannot be loaded', async () => {
    FakeImage.fail = true;
    const node = imageSource({ url: 'data/missing.jpg' }, ctx);
    await expect(node.init!({})).rejects.toThrow('could not load image http://studio.test/app/data/missing.jpg');
  });

  it('names CORS as a possible cause, since a cross-origin image without it fails to load', async () => {
    FakeImage.fail = true;
    await expect(imageSource({ url: 'https://elsewhere.test/a.jpg' }, ctx).init!({})).rejects.toThrow(/CORS/);
  });

  it('rejects an image without a picture size (the tracker frame would be empty)', async () => {
    FakeImage.size = [0, 0];
    await expect(imageSource({ url: 'data/icon.svg' }, ctx).init!({})).rejects.toThrow(
      'http://studio.test/app/data/icon.svg has no picture size',
    );
  });

  it('removes the element and releases the picture on dispose', async () => {
    const node = imageSource({ url: 'data/pinball-demo.jpg' }, ctx);
    await node.init!({});
    node.dispose!();
    expect(created[0]).toMatchObject({ removed: true, src: '' });
  });
});

describe('source.videoFile', () => {
  it('plays the file muted and inline, and outputs it at its size', async () => {
    const node = videoFileSource({ url: 'data/pinball.webm', loop: true }, ctx);
    const out = (await node.init!({})) as { video: VideoValue };
    const video = created[0] as FakeVideo;
    expect(video.src).toBe('http://studio.test/app/data/pinball.webm');
    expect(video.crossOrigin).toBe('anonymous');
    expect(video).toMatchObject({ muted: true, playsInline: true, loop: true, paused: false });
    expect(out.video).toEqual({ element: video, width: 640, height: 480 });
  });

  it('applies loop live, without a restart', async () => {
    const node = videoFileSource({ url: 'data/pinball.webm', loop: false }, ctx);
    await node.init!({});
    const video = created[0] as FakeVideo;
    expect(video.loop).toBe(false);
    node.onParamChange!('loop', true);
    expect(video.loop).toBe(true);
  });

  it('restarts a video that already ended when loop is turned on', async () => {
    const node = videoFileSource({ url: 'data/pinball.webm', loop: false }, ctx);
    await node.init!({});
    const video = created[0] as FakeVideo;
    Object.assign(video, { ended: true, paused: true });
    node.onParamChange!('loop', true);
    expect(video.paused).toBe(false);
  });

  it('rejects a file without a picture (audio only)', async () => {
    FakeVideo.size = [0, 0];
    await expect(videoFileSource({ url: 'data/sound.webm', loop: true }, ctx).init!({})).rejects.toThrow(
      'http://studio.test/app/data/sound.webm has no picture size',
    );
  });

  it('fails the init with the URL when the file cannot be played', async () => {
    FakeVideo.fail = true;
    const node = videoFileSource({ url: 'data/broken.webm', loop: true }, ctx);
    await expect(node.init!({})).rejects.toThrow('could not play video http://studio.test/app/data/broken.webm');
  });

  it('asks for a URL instead of loading the page itself when none is set', async () => {
    await expect(videoFileSource({ url: '', loop: true }, ctx).init!({})).rejects.toThrow('no video file URL set');
    await expect(imageSource({ url: '  ' }, ctx).init!({})).rejects.toThrow('no image URL set');
    expect(created).toHaveLength(0);
  });

  it('stops and releases the file on dispose', async () => {
    const node = videoFileSource({ url: 'data/pinball.webm', loop: true }, ctx);
    await node.init!({});
    node.dispose!();
    const video = created[0] as FakeVideo;
    expect(video).toMatchObject({ paused: true, src: '', removed: true });
  });
});
