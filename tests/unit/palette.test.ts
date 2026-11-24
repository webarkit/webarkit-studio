import { describe, expect, it } from 'vitest';
import { groupOpenByDefault, readGroupState, writeGroupState } from '../../src/app/palette';

describe('palette group state (#180)', () => {
  it('reads nothing usable as an empty state', () => {
    for (const raw of [null, '{', '[]', 'null', '5', '"math"', '[true]']) expect(readGroupState(raw).size).toBe(0);
  });

  it('keeps only own keys with a boolean value, __proto__ included as a plain name', () => {
    const state = readGroupState('{"math":true,"color":"yes","logic":false,"__proto__":false}');
    expect(state.get('math')).toBe(true);
    expect(state.has('color')).toBe(false);
    expect(state.get('logic')).toBe(false);
    expect(state.get('__proto__')).toBe(false);
    expect(state.size).toBe(3);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).math).toBeUndefined();
  });

  it('opens every group but math by default', () => {
    expect(groupOpenByDefault('math')).toBe(false);
    expect(groupOpenByDefault('color')).toBe(true);
    expect(groupOpenByDefault('macros')).toBe(true);
  });

  it('round-trips what it writes', () => {
    const state = readGroupState(writeGroupState(new Map([['math', true], ['scene', false]])));
    expect([...state]).toEqual([['math', true], ['scene', false]]);
  });

  it('writes only the keys it is told to keep', () => {
    const state = new Map([['math', true], ['__proto__', false], ['acme', true]]);
    expect(JSON.parse(writeGroupState(state, new Set(['math', 'color'])))).toEqual({ math: true });
  });

  it('writes a __proto__ key as data', () => {
    const state = readGroupState(writeGroupState(new Map([['__proto__', true]])));
    expect(state.get('__proto__')).toBe(true);
  });
});
