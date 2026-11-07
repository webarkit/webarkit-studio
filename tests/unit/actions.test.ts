/**
 * The action nodes, on their factories, with a fake scene, AudioContext and DOM. The clock must advance
 * between frames: eventWatcher compares an event's time with its last look (see tests/unit/events.test.ts).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fired, NOT_FIRED } from '../../src/runtime/events';
import { openUrl, playAnimation, playSound, setVisible } from '../../src/runtime/nodes/actions';
import { checkAnimationSpeed, type AnimationState, type SceneHandle, type SceneObject } from '../../src/runtime/renderers/adapter';
import { NODE_REGISTRY } from '../../src/runtime/registry';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import type { NodeFactory, PortValues, RuntimeContext } from '../../src/runtime/types';
import { beepWav } from '../helpers/beep-wav';

const FRAME_MS = 16;
const base = 'http://localhost/studio/';

function context(stage: unknown = {}) {
  const logs: string[] = [];
  const reports: string[] = [];
  const ctx = { nodeId: 'n', baseUrl: base, stage, log: (m: string) => logs.push(m), report: (m: string) => reports.push(m) } as unknown as RuntimeContext;
  return { ctx, logs, reports };
}

/** A node on its factory, one frame per step(), the clock moved first. */
async function harness(factory: NodeFactory, params: Record<string, unknown>, initial: PortValues, ctx = context()) {
  const node = factory(params as never, ctx.ctx);
  await node.init?.(initial);
  let frame = 0;
  return {
    ...ctx,
    node,
    step(inputs: PortValues = {}) {
      vi.advanceTimersByTime(FRAME_MS);
      frame++;
      node.update?.({ ...initial, ...inputs }, { time: frame * FRAME_MS, delta: FRAME_MS, frame });
    },
    set(key: string, value: unknown) {
      params[key] = value;
      node.onParamChange?.(key, value as never);
    },
  };
}

/** A scene with a model, and the semantics of SceneHandle that the action relies on. */
function fakeModel(names = ['spin', 'wobble']) {
  let state: AnimationState | null = null;
  const calls: unknown[][] = [];
  const scene = {
    animations: () => names,
    playAnimation(_o: SceneObject, clip: string, options: { speed: number }) {
      checkAnimationSpeed(options.speed);
      if (!names.includes(clip)) throw new Error(`this model has no clip "${clip}"`);
      calls.push(['play', clip, options]);
      state = { clip, time: state?.clip === clip ? state.time : 0, playing: true };
    },
    pauseAnimation() {
      calls.push(['pause']);
      if (state) state.playing = false;
    },
    stopAnimation() {
      calls.push(['stop']);
      if (state) state = { ...state, time: 0, playing: false };
    },
    animationState: () => state,
    setVisible(_o: SceneObject, visible: boolean) {
      calls.push(['visible', visible]);
    },
  } as unknown as SceneHandle;
  return {
    target: { scene, native: {} } as SceneObject,
    calls,
    advance: (seconds: number) => {
      if (state) state.time += seconds;
    },
    state: () => state,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('action.playAnimation', () => {
  const params = (over = {}) => ({ clip: '', loop: true, speed: 1, ...over });
  const start = async (over = {}, model = fakeModel()) => ({
    model,
    n: await harness(playAnimation, params(over), { target: model.target, play: NOT_FIRED, pause: NOT_FIRED, stop: NOT_FIRED }),
  });

  it('does nothing on the events seen at init', async () => {
    const model = fakeModel();
    const seen = { count: 3, time: 9_000 };
    const n = await harness(playAnimation, params(), { target: model.target, play: seen, pause: seen, stop: seen });
    n.step();
    expect(model.calls).toEqual([]);
  });

  it('plays the first clip when clip is empty, with its options', async () => {
    const { model, n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    expect(model.calls).toEqual([['play', 'spin', { loop: true, speed: 1 }]]);
  });

  it('plays the named clip, with its options', async () => {
    const { model, n } = await start({ clip: 'wobble', loop: false, speed: 2 });
    n.step({ play: fired(NOT_FIRED) });
    expect(model.calls).toEqual([['play', 'wobble', { loop: false, speed: 2 }]]);
  });

  it('pauses, and stops', async () => {
    const { model, n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    n.step({ pause: fired(NOT_FIRED) });
    n.step({ pause: NOT_FIRED, stop: fired(NOT_FIRED) });
    expect(model.calls.slice(1)).toEqual([['pause'], ['stop']]);
  });

  it('in the same frame, stop wins over pause, and pause over play', async () => {
    const { model, n } = await start();
    n.step({ play: fired(NOT_FIRED), pause: fired(NOT_FIRED), stop: fired(NOT_FIRED) });
    expect(model.calls.map((c) => c[0])).toEqual(['play', 'pause', 'stop']);
    expect(model.state()?.playing).toBe(false);
  });

  it('the status shows the clip and its time, playing or held, and only rewrites on a change', async () => {
    const { model, n } = await start();
    expect(n.reports.at(-1)).toBe('spin');
    const play = fired(NOT_FIRED);
    n.step({ play });
    expect(n.reports.at(-1)).toBe('▶ spin 0.0 s');
    model.advance(1.26);
    n.step({ play });
    expect(n.reports.at(-1)).toBe('▶ spin 1.3 s');
    const count = n.reports.length;
    n.step({ play });
    expect(n.reports).toHaveLength(count);
    n.step({ play, pause: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('‖ spin 1.3 s');
    n.step({ play, pause: NOT_FIRED, stop: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('■ spin 0.0 s');
  });

  it('logs each change once, with the time: what an exported app, with no status, shows of it', async () => {
    const { model, n } = await start();
    const logs = () => n.logs.filter((l) => /[▶‖■]/.test(l));
    const play = fired(NOT_FIRED);
    n.step({ play });
    model.advance(1.2);
    n.step({ play: fired(play) }); // already playing: nothing to say
    n.step({ pause: fired(NOT_FIRED) });
    n.step({ pause: fired(fired(NOT_FIRED)) }); // already held
    expect(logs()).toEqual(['n: ▶ spin 0.00 s', 'n: ‖ spin 1.20 s']);
    n.step({ stop: fired(NOT_FIRED) });
    expect(logs().at(-1)).toBe('n: ■ spin 0.00 s');
  });

  it('logs nothing and does not fail on a pause or a stop before any play', async () => {
    const { n } = await start();
    n.step({ pause: fired(NOT_FIRED), stop: fired(NOT_FIRED) });
    expect(n.logs).toEqual([]);
  });

  it('logs and shows a clip that ended on its own, and logs when it plays again', async () => {
    const { model, n } = await start({ loop: false });
    const play = fired(NOT_FIRED);
    n.step({ play });
    model.advance(2);
    model.state()!.playing = false; // the adapter: a one-shot holds its last frame, not playing
    n.step({ play });
    expect(n.reports.at(-1)).toBe('‖ spin 2.0 s');
    expect(n.logs.at(-1)).toBe('n: ‖ spin 2.00 s');
    n.step({ play: fired(play) });
    expect(n.logs.at(-1)).toBe('n: ▶ spin 2.00 s');
  });

  it('follows what the scene holds, when something else plays the model: autoplay on it', async () => {
    const { model, n } = await start();
    const play = fired(NOT_FIRED);
    n.step({ play });
    n.step({ play, stop: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('■ spin 0.0 s');
    model.target.scene.playAnimation(model.target, 'wobble', { speed: 1 });
    n.step({ play });
    expect(n.reports.at(-1)).toBe('▶ wobble 0.0 s');
  });

  it('a live change does not switch to its clip while another plays', async () => {
    const { model, n } = await start();
    model.target.scene.playAnimation(model.target, 'wobble', { speed: 1 });
    n.set('speed', 3);
    expect(model.state()?.clip).toBe('wobble');
    expect(model.calls).toHaveLength(1);
  });

  it('a pause after a stop keeps showing it stopped', async () => {
    const { n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    n.step({ stop: fired(NOT_FIRED) });
    n.step({ pause: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('■ spin 0.0 s');
  });

  describe('a target or clip it cannot play: reported, and the graph goes on', () => {
    it('a target with no clips', async () => {
      const { model, n } = await start({}, fakeModel([]));
      expect(n.reports.at(-1)).toBe('✗ the target has no clips');
      expect(n.logs).toEqual(['✗ n: the target has no clips']);
      n.step({ play: fired(NOT_FIRED), pause: fired(NOT_FIRED), stop: fired(NOT_FIRED) });
      expect(model.calls).toEqual([]);
    });

    it('an unknown clip names the clips', async () => {
      const { model, n } = await start({ clip: 'nope' });
      expect(n.reports.at(-1)).toBe('✗ no clip "nope" (clips: spin, wobble)');
      n.step({ play: fired(NOT_FIRED) });
      expect(model.calls).toEqual([]);
    });

    it('a speed not above 0, from an imported graph, and playing again works once it is fixed', async () => {
      const { model, n } = await start({ speed: -1 });
      const play = fired(NOT_FIRED);
      expect(() => n.step({ play })).not.toThrow();
      expect(n.reports.at(-1)).toBe('✗ animation speed must be above 0, not -1');
      n.set('speed', 2);
      n.step({ play: fired(play) });
      expect(model.calls).toEqual([['play', 'spin', { loop: true, speed: 2 }]]);
      expect(n.reports.at(-1)).toBe('▶ spin 0.0 s');
    });
  });

  describe('live params', () => {
    it('loop and speed reach a playing clip', async () => {
      const { model, n } = await start();
      n.step({ play: fired(NOT_FIRED) });
      n.set('speed', 3);
      n.set('loop', false);
      expect(model.calls.slice(1)).toEqual([
        ['play', 'spin', { loop: true, speed: 3 }],
        ['play', 'spin', { loop: false, speed: 3 }],
      ]);
    });

    it('do not resume a paused clip: they apply at the next play', async () => {
      const { model, n } = await start();
      const play = fired(NOT_FIRED);
      n.step({ play });
      n.step({ play, pause: fired(NOT_FIRED) });
      n.set('speed', 3);
      expect(model.state()?.playing).toBe(false);
      n.step({ play: fired(play) });
      expect(model.calls.at(-1)).toEqual(['play', 'spin', { loop: true, speed: 3 }]);
    });

    it('do not start a clip that was never played', async () => {
      const { model, n } = await start();
      n.set('speed', 3);
      expect(model.calls).toEqual([]);
    });
  });
});

describe('action.setVisible', () => {
  const start = async (visible = true) => {
    const model = fakeModel();
    const n = await harness(setVisible, { visible }, { target: model.target, show: NOT_FIRED, hide: NOT_FIRED, toggle: NOT_FIRED });
    return { model, n, values: () => model.calls.map((c) => c[1]) };
  };

  it.each([true, false])('applies its initial state, %s, at init', async (visible) => {
    const { values, n } = await start(visible);
    expect(values()).toEqual([visible]);
    expect(n.reports.at(-1)).toBe(visible ? 'visible' : 'hidden');
  });

  it('does nothing on the events seen at init', async () => {
    const model = fakeModel();
    const seen = { count: 3, time: 9_000 };
    const n = await harness(setVisible, { visible: true }, { target: model.target, show: seen, hide: seen, toggle: seen });
    n.step();
    expect(model.calls).toEqual([['visible', true]]);
  });

  it('show, hide and toggle set it, and the status follows', async () => {
    const { values, n } = await start();
    n.step({ hide: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('hidden');
    n.step({ hide: NOT_FIRED, show: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('visible');
    n.step({ show: NOT_FIRED, toggle: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('hidden');
    expect(values()).toEqual([true, false, true, false]);
  });

  it('calls the scene only on a change', async () => {
    const { values, n } = await start();
    n.step({ show: fired(NOT_FIRED) });
    expect(values()).toEqual([true]);
  });

  it('in the same frame, hide wins over show, and show over toggle', async () => {
    const { n } = await start(false);
    n.step({ toggle: fired(NOT_FIRED), show: fired(NOT_FIRED), hide: fired(NOT_FIRED) });
    expect(n.reports.at(-1)).toBe('hidden');
    n.step({ toggle: fired(fired(NOT_FIRED)), show: fired(fired(NOT_FIRED)), hide: NOT_FIRED });
    expect(n.reports.at(-1)).toBe('visible');
  });

  it('its description names what it does not apply to', () => {
    expect(NODE_CATALOG['action.setVisible'].description).toMatch(/Marker Anchor/);
    expect(NODE_CATALOG['action.setVisible'].description).toMatch(/light/);
  });
});

/** A fake AudioContext: what the node asks of Web Audio, recorded. */
function fakeAudio(initial = 'running') {
  const sources: Array<Record<string, unknown> & { onended?: () => void }> = [];
  const contexts: Array<Record<string, unknown>> = [];
  class FakeAudioContext {
    state = initial;
    destination = {};
    resumed = 0;
    closed = 0;
    /** What a resume() turns the state into. */
    resumesTo = 'running';
    gain = { gain: { value: 1 }, connect: vi.fn() };
    constructor() {
      contexts.push(this as unknown as Record<string, unknown>);
    }
    createGain = () => this.gain;
    createBufferSource = () => {
      const source: (typeof sources)[number] = { connect: vi.fn(), disconnect: vi.fn(), started: 0, stopped: 0, loop: false };
      source.start = () => void ((source.started as number)++);
      source.stop = () => void ((source.stopped as number)++);
      sources.push(source);
      return source;
    };
    decodeAudioData = async (data: ArrayBuffer) => {
      if (data.byteLength === 0) throw new Error('bad audio');
      return { duration: 0.2 };
    };
    resume = async () => {
      this.resumed++;
      this.state = this.resumesTo;
    };
    close = async () => {
      this.closed++;
      this.state = 'closed';
    };
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return { sources, contexts: contexts as unknown as FakeAudioContext[] };
}

describe('action.playSound', () => {
  const params = (over = {}) => ({ url: 'sounds/beep.wav', volume: 0.5, loop: false, ...over });
  const stubFetch = (response = () => new Response(beepWav() as BodyInit)) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const start = async (over = {}, state = 'running') => {
    const audio = fakeAudio(state);
    const fetchMock = stubFetch();
    const n = await harness(playSound, params(over), { play: NOT_FIRED, stop: NOT_FIRED });
    return { audio, fetchMock, n };
  };

  it('the default url is a real file of ours, and the one the exporter will fetch', () => {
    const url = NODE_CATALOG['action.playSound'].params.url as { default: string; asset?: string };
    expect(url.asset).toBe('file');
    expect(url.default).toBe('sounds/beep.wav');
    expect(new Uint8Array(readFileSync(`public/${url.default}`))).toEqual(beepWav());
  });

  it('loads the file against the base URL, once, in one context, and plays nothing yet', async () => {
    const { audio, fetchMock } = await start();
    expect(fetchMock.mock.calls).toEqual([[`${base}sounds/beep.wav`]]);
    expect(audio.contexts).toHaveLength(1);
    expect(audio.contexts[0].gain.gain.value).toBe(0.5);
    expect(audio.contexts[0].gain.connect).toHaveBeenCalledWith(audio.contexts[0].destination);
    expect(audio.sources).toEqual([]);
  });

  it('fails at init on a file it cannot load or decode', async () => {
    fakeAudio();
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(harness(playSound, params(), {})).rejects.toThrow(`cannot load sound ${base}sounds/beep.wav: HTTP 404`);
    stubFetch(() => new Response(new ArrayBuffer(0)));
    await expect(harness(playSound, params(), {})).rejects.toThrow(`cannot decode sound ${base}sounds/beep.wav: bad audio`);
  });

  it('closes its context when a file fails, so that a failed start leaks none', async () => {
    const audio = fakeAudio();
    stubFetch(() => new Response(null, { status: 404 }));
    const node = playSound(params() as never, context().ctx);
    await expect(node.init?.({})).rejects.toThrow();
    node.dispose?.();
    expect(audio.contexts[0].closed).toBe(1);
  });

  it('does nothing on the events seen at init', async () => {
    const audio = fakeAudio();
    stubFetch();
    const seen = { count: 3, time: 9_000 };
    const n = await harness(playSound, params(), { play: seen, stop: seen });
    n.step();
    expect(audio.sources).toEqual([]);
  });

  it('plays through its volume, with its loop', async () => {
    const { audio, n } = await start({ loop: true });
    n.step({ play: fired(NOT_FIRED) });
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0]).toMatchObject({ started: 1, loop: true });
    expect(audio.sources[0].connect).toHaveBeenCalledWith(audio.contexts[0].gain);
  });

  it('a play while it plays restarts it, with one voice', async () => {
    const { audio, n } = await start();
    const play = fired(NOT_FIRED);
    n.step({ play });
    n.step({ play: fired(play) });
    expect(audio.sources.map((s) => [s.started, s.stopped])).toEqual([
      [1, 1],
      [1, 0],
    ]);
  });

  it('stop stops it, wins in the same frame, and does nothing with no sound playing', async () => {
    const { audio, n } = await start();
    n.step({ stop: fired(NOT_FIRED) });
    expect(audio.sources).toEqual([]);
    n.step({ play: fired(NOT_FIRED), stop: fired(fired(NOT_FIRED)) });
    expect(audio.sources[0].stopped).toBe(1);
  });

  it('a stop after the sound ended does not stop it again', async () => {
    const { audio, n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    audio.sources[0].onended?.();
    n.step({ stop: fired(NOT_FIRED) });
    expect(audio.sources[0].stopped).toBe(0);
  });

  it('volume and loop apply live, to the sound playing', async () => {
    const { audio, n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    n.set('volume', 0.2);
    n.set('loop', true);
    expect(audio.contexts[0].gain.gain.value).toBe(0.2);
    expect(audio.sources[0].loop).toBe(true);
  });

  it('on a suspended context, resumes on play, starts once it runs, and says nothing', async () => {
    const { audio, n } = await start({}, 'suspended');
    n.step({ play: fired(NOT_FIRED) });
    expect(audio.contexts[0].resumed).toBe(1);
    expect(audio.sources).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(audio.sources.map((s) => s.started)).toEqual([1]);
    expect(n.logs.filter((l) => l.includes('suspended'))).toEqual([]);
  });

  it('drops the sound and logs once if the context stays suspended, also with plays less than the wait apart', async () => {
    const { audio, n } = await start({}, 'suspended');
    audio.contexts[0].resumesTo = 'suspended';
    let play = fired(NOT_FIRED);
    n.step({ play });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(300);
      play = fired(play);
      n.step({ play });
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(n.logs.filter((l) => l.includes('suspended'))).toHaveLength(1);
    expect(audio.sources).toEqual([]);
  });

  it('a sound does not play long after its event: a resume that comes late starts nothing', async () => {
    const { audio, n } = await start({}, 'suspended');
    let resumed!: () => void;
    audio.contexts[0].resume = () =>
      new Promise<void>((resolve) => {
        resumed = () => {
          audio.contexts[0].state = 'running';
          resolve();
        };
      });
    n.step({ play: fired(NOT_FIRED) });
    await vi.advanceTimersByTimeAsync(4000);
    resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.sources).toEqual([]);
  });

  it('a stop before the context runs cancels the play', async () => {
    const { audio, n } = await start({}, 'suspended');
    n.step({ play: fired(NOT_FIRED), stop: fired(NOT_FIRED) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(audio.sources).toEqual([]);
  });

  it('dispose stops the sound and closes the context', async () => {
    const { audio, n } = await start();
    n.step({ play: fired(NOT_FIRED) });
    n.node.dispose?.();
    expect(audio.sources[0].stopped).toBe(1);
    expect(audio.contexts[0].closed).toBe(1);
  });

  it('dispose with a play waiting for the context starts nothing, and a pending check stays quiet', async () => {
    const { audio, n } = await start({}, 'suspended');
    audio.contexts[0].resumesTo = 'suspended';
    n.step({ play: fired(NOT_FIRED) });
    n.node.dispose?.();
    expect(audio.contexts[0].closed).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(audio.sources).toEqual([]);
    expect(n.logs.filter((l) => l.includes('suspended'))).toEqual([]);
  });

  it('a graph stopped while the file loads ends quietly', async () => {
    const audio = fakeAudio();
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (finish = resolve)));
    const node = playSound(params() as never, context().ctx);
    const init = node.init?.({});
    node.dispose?.();
    finish(new Response(null, { status: 500 }));
    await expect(init).resolves.toBeDefined();
    expect(audio.contexts[0].closed).toBe(1);
  });
});

describe('action.openUrl', () => {
  /** The DOM the node touches: a stage, which may hold the AR view, and links it adds. */
  function fakeDom(withView = true) {
    const makeHost = () => ({ children: [] as Array<Record<string, unknown>>, appendChild(el: Record<string, unknown>) { this.children.push(el); el.parent = this; } });
    const view = makeHost();
    const stage = { ...makeHost(), querySelector: (selector: string) => (selector === '.ar-view' && withView ? view : null) };
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el: Record<string, unknown> = { tag, style: {} };
        el.remove = () => {
          const parent = el.parent as ReturnType<typeof makeHost>;
          parent.children.splice(parent.children.indexOf(el), 1);
        };
        return el;
      },
    });
    return { view, stage };
  }
  const start = async (over = {}, dom = fakeDom()) => {
    const ctx = context(dom.stage);
    const n = await harness(openUrl, { url: 'https://example.com/a?b=1', label: 'Open', ...over }, { show: NOT_FIRED, hide: NOT_FIRED }, ctx);
    return { n, dom };
  };

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'blob:http://x/y'])(
    'refuses %j at init',
    async (url) => {
      fakeDom();
      await expect(harness(openUrl, { url, label: 'x' }, {})).rejects.toThrow(/only http and https links/);
    },
  );

  it('refuses an empty url at init: it would be the page itself', async () => {
    fakeDom();
    await expect(harness(openUrl, { url: '  ', label: 'x' }, {})).rejects.toThrow(/needs a URL/);
  });

  it('accepts http, https and a relative URL, resolved against the base', async () => {
    for (const [url, href] of [
      ['http://example.com/', 'http://example.com/'],
      ['https://example.com/', 'https://example.com/'],
      ['more.html', `${base}more.html`],
    ]) {
      const { n, dom } = await start({ url });
      n.step({ show: fired(NOT_FIRED) });
      expect(dom.view.children[0].href).toBe(href);
    }
  });

  it('the default url passes its own check', async () => {
    fakeDom();
    const { default: url } = NODE_CATALOG['action.openUrl'].params.url as { default: string };
    await expect(harness(openUrl, { url, label: 'x' }, {})).resolves.toBeDefined();
  });

  it('shows no link until it fires, and not on the event seen at init', async () => {
    const dom = fakeDom();
    const seen = { count: 3, time: 9_000 };
    const n = await harness(openUrl, { url: 'https://example.com/', label: 'Open' }, { show: seen, hide: seen }, context(dom.stage));
    n.step();
    expect(dom.view.children).toEqual([]);
  });

  it('show adds a safe link on the AR view, as text, that the user can tap', async () => {
    const { n, dom } = await start({ label: '<b>Open</b>' });
    n.step({ show: fired(NOT_FIRED) });
    expect(dom.view.children).toHaveLength(1);
    const [link] = dom.view.children;
    expect(link).toMatchObject({ tag: 'a', href: 'https://example.com/a?b=1', target: '_blank', rel: 'noopener', textContent: '<b>Open</b>' });
    expect(link.innerHTML).toBeUndefined();
    const { cssText } = link.style as { cssText: string };
    expect(cssText).not.toMatch(/pointer-events:\s*none/);
    expect(cssText).toMatch(/z-index/);
  });

  it('with no AR view, the link goes on the stage', async () => {
    const dom = fakeDom(false);
    const { n } = await start({}, dom);
    n.step({ show: fired(NOT_FIRED) });
    expect(dom.stage.children).toHaveLength(1);
  });

  it('a second show adds no second link', async () => {
    const { n, dom } = await start();
    const show = fired(NOT_FIRED);
    n.step({ show });
    n.step({ show: fired(show) });
    expect(dom.view.children).toHaveLength(1);
  });

  it('hide removes it, wins in the same frame, and show brings it back', async () => {
    const { n, dom } = await start();
    const show = fired(NOT_FIRED);
    n.step({ show });
    const hide = fired(NOT_FIRED);
    n.step({ show, hide });
    expect(dom.view.children).toEqual([]);
    const again = fired(show);
    n.step({ show: again, hide });
    expect(dom.view.children).toHaveLength(1);
    n.step({ show: fired(again), hide: fired(hide) });
    expect(dom.view.children).toEqual([]);
  });

  it('the label applies live, to a link showing and to the next one', async () => {
    const { n, dom } = await start();
    n.set('label', 'Before');
    n.step({ show: fired(NOT_FIRED) });
    expect(dom.view.children[0].textContent).toBe('Before');
    n.set('label', 'After');
    expect(dom.view.children[0].textContent).toBe('After');
  });

  it('dispose removes the link', async () => {
    const { n, dom } = await start();
    n.step({ show: fired(NOT_FIRED) });
    n.node.dispose?.();
    expect(dom.view.children).toEqual([]);
  });
});

describe('the catalog and the registry', () => {
  const TYPES = ['action.playAnimation', 'action.setVisible', 'action.playSound', 'action.openUrl'];

  it('has the four nodes, in the action category, provider core, each with a factory', () => {
    for (const type of TYPES) {
      expect(NODE_CATALOG[type]).toMatchObject({ category: 'action', provider: 'core' });
      expect(NODE_REGISTRY[type]).toBeTypeOf('function');
    }
    expect(Object.keys(NODE_CATALOG).filter((t) => t.startsWith('action.'))).toEqual(TYPES);
  });

  it('marks live what applies live, as the issue lists', () => {
    const live = (type: string) =>
      Object.entries(NODE_CATALOG[type].params)
        .filter(([, spec]) => spec.live)
        .map(([key]) => key);
    expect(live('action.playAnimation')).toEqual(['loop', 'speed']);
    expect(live('action.setVisible')).toEqual([]);
    expect(live('action.playSound')).toEqual(['volume', 'loop']);
    expect(live('action.openUrl')).toEqual(['label']);
  });

  it('loops by default, like autoplay, and its speed has a minimum above 0', () => {
    const { loop, speed } = NODE_CATALOG['action.playAnimation'].params as unknown as { loop: { default: boolean }; speed: { min: number } };
    expect(loop.default).toBe(true);
    expect(speed.min).toBeGreaterThan(0);
  });

  it('every event input is optional, and every target is required', () => {
    for (const type of TYPES) {
      for (const [key, port] of Object.entries(NODE_CATALOG[type].inputs)) {
        if (port.type === 'event') expect(port.optional, `${type}.${key}`).toBe(true);
        if (key === 'target') {
          expect(port.type).toBe('sceneObject');
          expect(port.optional).toBeFalsy();
        }
      }
    }
  });
});
