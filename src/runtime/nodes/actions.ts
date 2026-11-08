/**
 * Action nodes: what a graph does when an event fires (docs/plugins.md, "Events"). Inputs are named after
 * what they do. Within a frame they apply in a fixed order, so the last one wins, as each description says.
 */
import { eventWatcher } from '../events';
import { checkEventName, checkOrigin, plainValue } from '../page-events';
import type { EventValue, NodeFactory, SceneObjectValue } from '../types';

/** A clip's state as text: playing, held, or stopped. */
const mark = (stopped: boolean, playing: boolean | undefined) => (stopped ? '■' : playing ? '▶' : '‖');

/**
 * action.playAnimation — plays a clip of its target, through the scene that made it. Anything it cannot
 * play is reported on the node, and the graph goes on. Each change is logged with the time, which is
 * what an exported app shows of it: the player has no status.
 */
export const playAnimation: NodeFactory = (params, ctx) => {
  const play = eventWatcher();
  const pause = eventWatcher();
  const stop = eventWatcher();
  let target!: SceneObjectValue;
  let clip: string | null = null;
  let stopped = false;
  let problem = '';
  let status = '';
  let logged = '';

  const report = (text: string) => {
    if (text !== status) ctx.report((status = text));
  };
  const fail = (message: string) => {
    if (message === problem) return;
    problem = message;
    ctx.log(`✗ ${ctx.nodeId}: ${message}`);
    report(`✗ ${message}`);
  };
  /** What the scene holds, which autoplay on the same model can change: the status and the log follow it. */
  const showState = () => {
    const state = target.scene.animationState(target);
    if (!state) return;
    const now = mark(stopped && !state.playing, state.playing);
    if (now !== logged) ctx.log(`${ctx.nodeId}: ${(logged = now)} ${state.clip} ${state.time.toFixed(2)} s`);
    if (!problem) report(`${now} ${state.clip} ${state.time.toFixed(1)} s`);
  };
  const start = () => {
    try {
      target.scene.playAnimation(target, clip!, { loop: Boolean(params.loop), speed: Number(params.speed) });
      stopped = false;
      problem = '';
    } catch (err) {
      fail((err as Error).message);
    }
  };

  return {
    init(inputs) {
      target = inputs.target as SceneObjectValue;
      play(inputs.play);
      pause(inputs.pause);
      stop(inputs.stop);
      const names = target.scene.animations(target);
      const wanted = String(params.clip);
      if (!names.length) fail('the target has no clips');
      else if (wanted && !names.includes(wanted)) fail(`no clip "${wanted}" (clips: ${names.join(', ')})`);
      else report((clip = wanted || names[0]));
    },
    update(inputs) {
      const [playing, pausing, stopping] = [play(inputs.play), pause(inputs.pause), stop(inputs.stop)];
      if (!clip) return;
      if (playing) start();
      if (pausing) target.scene.pauseAnimation(target);
      if (stopping) {
        target.scene.stopAnimation(target);
        stopped = true;
      }
      showState();
    },
    onParamChange() {
      // Only on its clip while it plays: on a paused one, playAnimation would resume it, and the next play takes them.
      const state = target.scene.animationState(target);
      if (clip && state?.playing && state.clip === clip) start();
    },
  };
};

/** action.setVisible — shows or hides its target. Within a frame: toggle, then show, then hide. */
export const setVisible: NodeFactory = (params, ctx) => {
  const show = eventWatcher();
  const hide = eventWatcher();
  const toggle = eventWatcher();
  let target!: SceneObjectValue;
  let visible = true;
  const apply = () => {
    target.scene.setVisible(target, visible);
    ctx.report(visible ? 'visible' : 'hidden');
  };
  return {
    init(inputs) {
      target = inputs.target as SceneObjectValue;
      show(inputs.show);
      hide(inputs.hide);
      toggle(inputs.toggle);
      visible = Boolean(params.visible);
      apply();
    },
    update(inputs) {
      let next = visible;
      if (toggle(inputs.toggle)) next = !next;
      if (show(inputs.show)) next = true;
      if (hide(inputs.hide)) next = false;
      if (next === visible) return;
      visible = next;
      apply();
    },
  };
};

/** How long a suspended context has to start running after a play: later, the sound would no longer belong to its event. */
const RESUME_WAIT_MS = 1000;

/**
 * action.playSound — plays a file with Web Audio, one voice at a time: a play restarts it. Within a frame:
 * play, then stop. A context needs a user gesture on the page to run: the player's Start button or the
 * studio's Run. If it does not run in time, the sound is dropped, and the node logs that once.
 */
export const playSound: NodeFactory = (params, ctx) => {
  const play = eventWatcher();
  const stop = eventWatcher();
  let audio: AudioContext | null = null;
  let gain: GainNode | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let check: ReturnType<typeof setTimeout> | undefined;
  /** The play waiting for a suspended context, if any: a later play, a stop or the end of the wait replaces it. */
  let waiting = 0;
  let warned = false;
  let disposed = false;

  const silence = () => {
    waiting++;
    source?.stop();
    source?.disconnect();
    source = null;
  };
  const start = () => {
    if (!audio || !gain || !buffer) return;
    silence();
    if (audio.state === 'running') {
      startVoice();
      return;
    }
    // On iOS, also 'interrupted'.
    const asked = waiting;
    audio.resume().then(
      () => {
        if (asked === waiting && !disposed && audio?.state === 'running') startVoice();
      },
      () => {},
    );
    check ??= setTimeout(() => {
      check = undefined;
      waiting++;
      if (audio?.state === 'running' || warned) return;
      warned = true;
      ctx.log(`${ctx.nodeId}: the audio context stays suspended, so the sound was dropped: the browser has not allowed sound on this page`);
    }, RESUME_WAIT_MS);
  };
  const startVoice = () => {
    const voice = audio!.createBufferSource();
    voice.buffer = buffer;
    voice.loop = Boolean(params.loop);
    voice.connect(gain!);
    voice.onended = () => {
      if (source !== voice) return;
      source = null;
      ctx.report('■ stopped');
    };
    source = voice;
    voice.start();
    ctx.report('▶ playing');
  };

  return {
    async init(inputs) {
      play(inputs.play);
      stop(inputs.stop);
      const url = new URL(String(params.url), ctx.baseUrl).href;
      audio = new AudioContext();
      gain = audio.createGain();
      gain.gain.value = Number(params.volume);
      gain.connect(audio.destination);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`cannot load sound ${url}: HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        if (disposed) return {};
        try {
          buffer = await audio.decodeAudioData(data);
        } catch (err) {
          throw new Error(`cannot decode sound ${url}: ${(err as Error).message}`);
        }
      } catch (err) {
        if (disposed) return {};
        const { message } = err as Error;
        throw new Error(message.startsWith('cannot ') ? message : `cannot load sound ${url}: ${message}`);
      }
      ctx.log(`sound loaded (${buffer.duration.toFixed(1)} s)`);
      return {};
    },
    update(inputs) {
      if (play(inputs.play)) start();
      if (stop(inputs.stop)) {
        const sounding = source;
        silence();
        if (sounding) ctx.report('■ stopped');
      }
    },
    onParamChange(key) {
      if (key === 'volume' && gain) gain.gain.value = Number(params.volume);
      if (key === 'loop' && source) source.loop = Boolean(params.loop);
    },
    dispose() {
      disposed = true;
      clearTimeout(check);
      silence();
      void audio?.close();
    },
  };
};

/**
 * action.dispatchEvent — tells the page that holds the graph: a bubbling CustomEvent on the stage (`dom`),
 * which the page hears on the stage, the document or the window, or a message to the parent page of an
 * iframe (`postMessage`), to one origin only. The detail is `{ data, time }`: the trigger's data reduced to
 * plain values (page-events.ts), and when it fired.
 */
export const dispatchEvent: NodeFactory = (params, ctx) => {
  const trigger = eventWatcher();
  let name = '';
  let targetOrigin = '';
  let sent = 0;
  return {
    init(inputs) {
      trigger(inputs.trigger);
      name = checkEventName(params.name);
      if (params.channel === 'postMessage') targetOrigin = checkOrigin(params.targetOrigin);
      ctx.report(targetOrigin ? `${name} → ${targetOrigin}` : name);
    },
    update(inputs) {
      if (!trigger(inputs.trigger)) return;
      const event = inputs.trigger as EventValue;
      const detail = { data: plainValue(event.data) ?? null, time: event.time };
      if (targetOrigin) window.parent.postMessage({ type: name, detail }, targetOrigin);
      else ctx.stage.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
      ctx.report(`${name} ×${++sent}`);
    },
  };
};

/** Only these open as links: a graph from someone else must not run a `javascript:` URL. */
const LINK_PROTOCOLS = ['http:', 'https:'];

/**
 * action.openUrl — shows a link on the AR view, which the user's tap opens. Opening it from the event
 * would be blocked: a tracking event is not a user gesture. Within a frame: show, then hide.
 */
export const openUrl: NodeFactory = (params, ctx) => {
  const show = eventWatcher();
  const hide = eventWatcher();
  let href = '';
  let link: HTMLAnchorElement | null = null;
  return {
    init(inputs) {
      show(inputs.show);
      hide(inputs.hide);
      const value = String(params.url).trim();
      if (!value) throw new Error('openUrl needs a URL');
      const url = new URL(value, ctx.baseUrl);
      if (!LINK_PROTOCOLS.includes(url.protocol)) throw new Error(`openUrl: only http and https links are allowed, not ${url.protocol}`);
      href = url.href;
    },
    update(inputs) {
      if (show(inputs.show) && !link) {
        link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'open-url-link'; // kept clear of by ui.* panels
        link.textContent = String(params.label);
        link.style.cssText =
          // At the top: on a phone held sideways, the AR view is taller than the screen.
          'position:absolute;left:50%;top:32px;transform:translateX(-50%);z-index:1;padding:10px 16px;border-radius:6px;background:rgb(0 0 0 / .7);color:#fff;font:14px system-ui,sans-serif';
        (ctx.stage.querySelector<HTMLElement>('.ar-view') ?? ctx.stage).appendChild(link);
        ctx.report('link shown');
      }
      if (hide(inputs.hide) && link) {
        link.remove();
        link = null;
        ctx.report('link hidden');
      }
    },
    onParamChange(key) {
      if (key === 'label' && link) link.textContent = String(params.label);
    },
    dispose() {
      link?.remove();
    },
  };
};
