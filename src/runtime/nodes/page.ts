/**
 * Page nodes (#82): the page that holds the graph talks to it. page.event brings in a named event; the
 * other direction is action.dispatchEvent (actions.ts). The rules live in page-events.ts.
 */
import { fired, NOT_FIRED } from '../events';
import { checkEventName, checkOrigin, detailNumber, plainValue } from '../page-events';
import type { EventValue, NodeFactory } from '../types';

/**
 * page.event — fires onEvent for each event of its name from the page: a CustomEvent that reaches the
 * window (`dom`), or a message from exactly one origin whose `data.type` is the name (`postMessage`).
 * Browser events arrive outside the frame loop: they wait for the next frame, and all of them fire there.
 */
export const pageEvent: NodeFactory = (params, ctx) => {
  let onEvent: EventValue = NOT_FIRED;
  let number = 0;
  const queue: unknown[] = [];
  let stopListening = () => {};

  return {
    init() {
      const name = checkEventName(params.name);
      if (params.channel === 'postMessage') {
        const origin = checkOrigin(params.origin);
        const onMessage = (e: Event) => {
          const { origin: from, data } = e as MessageEvent;
          if (from !== origin || data === null || typeof data !== 'object' || (data as { type?: unknown }).type !== name) return;
          queue.push(plainValue((data as { detail?: unknown }).detail));
        };
        window.addEventListener('message', onMessage);
        stopListening = () => window.removeEventListener('message', onMessage);
      } else {
        const onDom = (e: Event) => queue.push(plainValue((e as CustomEvent).detail));
        window.addEventListener(name, onDom);
        stopListening = () => window.removeEventListener(name, onDom);
      }
      ctx.report(`listening for ${name}`);
      return { onEvent, number };
    },
    update() {
      if (!queue.length) return;
      for (const detail of queue.splice(0)) {
        onEvent = fired(onEvent, detail);
        number = detailNumber(detail) ?? number;
      }
      ctx.report(`${String(params.name).trim()} ×${onEvent.count}`);
      return { onEvent, number };
    },
    dispose() {
      stopListening();
    },
  };
};
