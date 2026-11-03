import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackerPath } from '../../plugins/jsartoolkit-nft/headless';

// The Node build mounts the working directory and loads "<mount>/" + path: paths must be relative to it.
describe('trackerPath', () => {
  const cwd = join('/', 'work', 'studio');

  it('maps a file URL under the working directory to a relative POSIX path', () => {
    expect(trackerPath(pathToFileURL(join(cwd, 'public', 'data', 'camera_para.dat')).href, cwd)).toBe('public/data/camera_para.dat');
  });

  it('refuses a file outside the working directory', () => {
    expect(() => trackerPath(pathToFileURL(join('/', 'elsewhere', 'camera_para.dat')).href, cwd)).toThrow(/inside the working directory/);
  });

  it('refuses a URL that is not a local file', () => {
    expect(() => trackerPath('https://example.com/data/camera_para.dat', cwd)).toThrow(/local files only/);
  });
});
