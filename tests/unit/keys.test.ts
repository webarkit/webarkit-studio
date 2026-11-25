/** `rovingIndex` (#190): which item of a menu or a tab bar an arrow, Home or End moves the focus to. */
import { describe, expect, it } from 'vitest';
import { rovingIndex } from '../../src/app/keys';

describe('rovingIndex (#190)', () => {
  it('Down goes to the next item, wrapping from the last to the first', () => {
    expect(rovingIndex(0, 'ArrowDown', 3, 'vertical')).toBe(1);
    expect(rovingIndex(2, 'ArrowDown', 3, 'vertical')).toBe(0);
  });

  it('Up goes to the previous item, wrapping from the first to the last', () => {
    expect(rovingIndex(0, 'ArrowUp', 3, 'vertical')).toBe(2);
  });

  it('with nothing focused, next is the first item and previous the last', () => {
    expect(rovingIndex(-1, 'ArrowDown', 3, 'vertical')).toBe(0);
    expect(rovingIndex(-1, 'ArrowUp', 3, 'vertical')).toBe(2);
  });

  it('Home goes to the first item and End to the last', () => {
    expect(rovingIndex(1, 'Home', 3, 'vertical')).toBe(0);
    expect(rovingIndex(1, 'End', 3, 'vertical')).toBe(2);
    expect(rovingIndex(1, 'Home', 3, 'horizontal')).toBe(0);
    expect(rovingIndex(1, 'End', 3, 'horizontal')).toBe(2);
  });

  it('an arrow of the other orientation is not handled', () => {
    expect(rovingIndex(1, 'ArrowRight', 3, 'vertical')).toBeNull();
    expect(rovingIndex(1, 'ArrowDown', 3, 'horizontal')).toBeNull();
  });

  it('horizontal: Right and Left wrap', () => {
    expect(rovingIndex(0, 'ArrowRight', 3, 'horizontal')).toBe(1);
    expect(rovingIndex(2, 'ArrowRight', 3, 'horizontal')).toBe(0);
    expect(rovingIndex(0, 'ArrowLeft', 3, 'horizontal')).toBe(2);
    expect(rovingIndex(2, 'ArrowLeft', 3, 'horizontal')).toBe(1);
  });

  it('with no items, nothing is handled', () => {
    expect(rovingIndex(0, 'ArrowDown', 0, 'vertical')).toBeNull();
  });

  it('a key it does not handle gives null', () => {
    expect(rovingIndex(0, 'a', 3, 'vertical')).toBeNull();
  });
});
