import { describe, expect, it } from 'vitest';
import { EXPORTERS } from '../../src/export/exporters';

describe('the Export menu', () => {
  it('lists the core formats, with no placeholder (#30: the source code export is #64)', () => {
    expect(EXPORTERS.map((e) => e.id)).toEqual(['graph-json', 'project', 'app-bundle', 'pages-project']);
  });
});
