import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMOS } from '../../src/app/demos';

describe('the demo list (#179)', () => {
  it('every entry has its graph in public/graphs/', () => {
    for (const demo of DEMOS) {
      expect(existsSync(`public/graphs/${demo.id}.json`), demo.id).toBe(true);
    }
  });

  it('every graph in public/graphs/ has an entry', () => {
    const graphs = readdirSync('public/graphs')
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
    expect(graphs).toEqual(DEMOS.map((demo) => demo.id).sort());
  });

  it('ids are unique, titles and descriptions are not empty', () => {
    const ids = DEMOS.map((demo) => demo.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const demo of DEMOS) {
      expect(demo.title.trim(), demo.id).not.toBe('');
      expect(demo.description.trim(), demo.id).not.toBe('');
    }
  });

  it('the first entry is the one the studio opens with no autosave', () => {
    expect(DEMOS[0].id).toBe('pinball-three');
  });
});
