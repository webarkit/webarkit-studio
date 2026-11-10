import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NODE_CATALOG } from '../../src/nodes/catalog';
import { CATEGORY_ORDER, searchNodes } from '../../src/editor/node-search';

const defs = Object.values(NODE_CATALOG);
const types = (query: string) => searchNodes(query, defs).map((d) => d.type);

describe('node search', () => {
  it('orders every category of the catalog: the palette only shows those it lists', () => {
    for (const def of defs) expect(CATEGORY_ORDER).toContain(def.category);
  });

  it('has a color group right after math, with every color.* node, and none left in math (#104)', () => {
    expect(CATEGORY_ORDER.indexOf('color')).toBe(CATEGORY_ORDER.indexOf('math') + 1);
    const colour = defs.filter((d) => d.type.startsWith('color.'));
    expect(colour.length).toBeGreaterThanOrEqual(7);
    for (const def of colour) expect(def.category, def.type).toBe('color');
    expect(defs.filter((d) => d.category === 'color').every((d) => d.type.startsWith('color.'))).toBe(true);
    // In the palette's order: the math nodes, then the colour nodes.
    const all = types('  ');
    const lastMath = all.map((t) => NODE_CATALOG[t].category).lastIndexOf('math');
    expect(all.slice(lastMath + 1, lastMath + 1 + colour.length).every((t) => t.startsWith('color.'))).toBe(true);
  });

  it('every category has its colour in the studio: palette, node header and Properties share the cat-<category> class (#104)', () => {
    const css = readFileSync('src/app/studio.css', 'utf8');
    for (const category of CATEGORY_ORDER) {
      expect(css, category).toContain(`--cat-${category}:`);
      expect(css, category).toContain(`.cat-${category} { --c: var(--cat-${category}); }`);
    }
  });

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
    expect(types('three').sort()).toEqual(['three.renderScript', 'three.renderer', 'three.script']);
  });

  it('requires every word to match: category plus label', () => {
    expect(types('scene light')[0]).toBe('scene.light');
    expect(types('debug stats')).toEqual(['debug.stats']);
  });

  it('splits camelCase labels and types into words', () => {
    expect(types('controller')[0]).toBe('jsartoolkitNFT.controller');
    expect(types('params')[0]).toBe('jsartoolkitNFT.cameraParams');
    expect(types('euro')[0]).toBe('filter.oneEuro');
  });

  it('splits the query on punctuation like the catalog words', () => {
    expect(types('one-euro')[0]).toBe('filter.oneEuro');
  });

  it('falls back to the description', () => {
    expect(types('getUserMedia')).toEqual(['source.camera']);
  });

  it('returns nothing when a word matches nothing', () => {
    expect(types('zzz')).toEqual([]);
    expect(types('camera zzz')).toEqual([]);
  });
});
