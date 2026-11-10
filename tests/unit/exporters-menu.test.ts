import { describe, expect, it } from 'vitest';
import { EXPORTERS } from '../../src/export/exporters';

describe('the Export menu', () => {
  it('lists the core formats, the source code export last, where its placeholder was before #30 (#64)', () => {
    expect(EXPORTERS.map((e) => e.id)).toEqual(['graph-json', 'project', 'app-bundle', 'pages-project', 'source-code']);
  });
});
