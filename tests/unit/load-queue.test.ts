import { describe, expect, it } from 'vitest';
import { createLoadQueue } from '../../src/app/load-queue';

/** A promise resolved by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('load queue', () => {
  it('applies a load when it is the latest', async () => {
    const queue = createLoadQueue();
    const applied: string[] = [];
    expect(await queue.run(queue.begin(), async () => void applied.push('a'))).toBe(true);
    expect(applied).toEqual(['a']);
  });

  it('drops a load that started earlier and arrives later', async () => {
    const queue = createLoadQueue();
    const applied: string[] = [];
    const [slow, fast] = [queue.begin(), queue.begin()];
    await queue.run(fast, async () => void applied.push('fast'));
    expect(await queue.run(slow, async () => void applied.push('slow'))).toBe(false);
    expect(applied).toEqual(['fast']);
  });

  it('says whether a ticket is still the latest', () => {
    const queue = createLoadQueue();
    const first = queue.begin();
    expect(first.current()).toBe(true);
    queue.begin();
    expect(first.current()).toBe(false);
  });

  it('never applies two at once: a later load waits for the one applying', async () => {
    const queue = createLoadQueue();
    const events: string[] = [];
    const [started, inFirst] = [gate(), gate()];
    const first = queue.run(queue.begin(), async () => {
      events.push('first starts');
      started.open();
      await inFirst.opened;
      events.push('first ends');
    });
    await started.opened;
    const second = queue.run(queue.begin(), async () => void events.push('second'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(events).toEqual(['first starts']);
    inFirst.open();
    await Promise.all([first, second]);
    expect(events).toEqual(['first starts', 'first ends', 'second']);
  });

  it('drops a waiting load that a newer one has overtaken', async () => {
    const queue = createLoadQueue();
    const applied: string[] = [];
    const [started, inFirst] = [gate(), gate()];
    const first = queue.run(queue.begin(), async () => {
      applied.push('first');
      started.open();
      await inFirst.opened;
    });
    await started.opened;
    const second = queue.run(queue.begin(), async () => void applied.push('second'));
    const third = queue.run(queue.begin(), async () => void applied.push('third'));
    inFirst.open();
    expect(await Promise.all([first, second, third])).toEqual([true, false, true]);
    expect(applied).toEqual(['first', 'third']);
  });

  it('drops a load that a newer one overtakes before it has begun', async () => {
    const queue = createLoadQueue();
    const applied: string[] = [];
    const first = queue.run(queue.begin(), async () => void applied.push('first'));
    const second = queue.run(queue.begin(), async () => void applied.push('second'));
    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(applied).toEqual(['second']);
  });

  it('passes on the error of a load, and the next one still runs', async () => {
    const queue = createLoadQueue();
    await expect(
      queue.run(queue.begin(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const applied: string[] = [];
    expect(await queue.run(queue.begin(), async () => void applied.push('next'))).toBe(true);
    expect(applied).toEqual(['next']);
  });
});
