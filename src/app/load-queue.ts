/**
 * The order of the studio's graph loads (#77): the latest to start wins, whichever
 * finishes fetching last. A load takes a ticket when it starts, before anything
 * asynchronous. Applying one rebuilds the editor over many awaits, so only one
 * applies at a time, or two graphs would mix.
 */
export interface LoadTicket {
  /** False once a newer load has started: this one will be dropped. */
  current(): boolean;
}

export interface LoadQueue {
  begin(): LoadTicket;
  /** Applies the load, after the one applying now, unless a newer one started. Returns whether it applied. */
  run(ticket: LoadTicket, apply: () => Promise<void>): Promise<boolean>;
}

export function createLoadQueue(): LoadQueue {
  let latest = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    begin() {
      const id = ++latest;
      return { current: () => id === latest };
    },
    run(ticket, apply) {
      const result = tail.then(async () => {
        if (!ticket.current()) return false;
        await apply();
        return true;
      });
      tail = result.catch(() => {}); // the caller gets the error; the next load still runs
      return result;
    },
  };
}
