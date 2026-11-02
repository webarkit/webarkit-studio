import { describe, expect, it } from 'vitest';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { searchNodes } from '../../src/editor/node-search';

const defs = Object.values(NODE_CATALOG);
const types = (query: string) => searchNodes(query, defs).map((d) => d.type);

describe('node search', () => {
  it('lists every node, grouped by category, for an empty query', () => {
    const all = types('  ');
    expect(all).toHaveLength(defs.length);
    expect(all[0]).toBe('source.camera');
    expect(all.at(-1)!.startsWith('debug.')).toBe(true);
  });

  it('ranks label prefixes first', () => {
    const result = types('cam');
    expect(result[0]).toBe('source.camera');
    expect(result).toContain('jsartoolkitNFT.cameraParams');
    expect(result).toContain('scene.arCamera');
  });

  it('matches the provider, case-insensitively', () => {
    const result = searchNodes('jsartoolkitnft', defs);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((d) => d.provider === 'JsartoolkitNFT')).toBe(true);
  });

  it('matches the type namespace', () => {
    expect(types('three')).toEqual(['three.renderer']);
  });

  it('requires every word to match: category plus label', () => {
    expect(types('scene light')[0]).toBe('scene.light');
    expect(types('debug stats')).toEqual(['debug.stats']);
  });

  it('falls back to the description', () => {
    expect(types('getUserMedia')).toEqual(['source.camera']);
  });

  it('returns nothing when a word matches nothing', () => {
    expect(types('zzz')).toEqual([]);
    expect(types('camera zzz')).toEqual([]);
  });
});
