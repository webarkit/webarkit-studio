// Save as (#118): the system save dialog where the browser has one, before the export runs; the download otherwise.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveFailed, saveFile } from '../../src/app/save-file';

const ACCEPT = { suggestedName: 'my-graph.json', description: 'Graph (.json)', mime: 'application/json', extensions: ['.json'] };

/** The page as saveFile sees it: a picker (or none), and the links it clicks to download. */
function page(picker?: (options: unknown) => Promise<unknown>) {
  const events: string[] = [];
  const clicked: Array<{ download: string; href: string }> = [];
  vi.stubGlobal('window', picker ? { showSaveFilePicker: picker } : {});
  vi.stubGlobal('document', {
    createElement: () => {
      const a = { download: '', href: '', click: () => (clicked.push({ download: a.download, href: a.href }), events.push(`download ${a.download}`)) };
      return a;
    },
  });
  return { events, clicked };
}

/** A file handle whose writable records what reaches it. */
function handle(name: string, events: string[]) {
  const written: Blob[] = [];
  return {
    written,
    name,
    async createWritable() {
      events.push('createWritable');
      return {
        write: async (blob: Blob) => void written.push(blob),
        close: async () => void events.push('close'),
      };
    },
  };
}

const exported = (events: string[], text = '{"nodes":[]}') => async () => {
  events.push('export');
  return { filename: 'my-graph.json', blob: new Blob([text], { type: 'application/json' }) };
};

afterEach(() => vi.unstubAllGlobals());

describe('saveFile', () => {
  it('opens the save dialog before the export runs, then writes the exported bytes where the user chose', async () => {
    const events: string[] = [];
    const file = handle('chosen.json', events);
    const picker = vi.fn(async () => (events.push('picker'), file));
    const p = page(picker);
    const outcome = await saveFile(exported(events, '{"name":"x"}'), ACCEPT);
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'my-graph.json',
      types: [{ description: 'Graph (.json)', accept: { 'application/json': ['.json'] } }],
      excludeAcceptAllOption: true,
    });
    expect(events).toEqual(['picker', 'export', 'createWritable', 'close']);
    expect(await file.written[0].text()).toBe('{"name":"x"}');
    expect(outcome).toEqual({ saved: 'picked', name: 'chosen.json' });
    expect(p.clicked).toEqual([]);
  });

  it('a cancel (AbortError) exports nothing and downloads nothing', async () => {
    const events: string[] = [];
    const p = page(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    expect(await saveFile(exported(events), ACCEPT)).toEqual({ saved: false });
    expect(events).toEqual([]);
    expect(p.clicked).toEqual([]);
  });

  it('downloads under the default name where there is no save dialog', async () => {
    const events: string[] = [];
    const p = page();
    expect(await saveFile(exported(events), ACCEPT)).toEqual({ saved: 'downloaded', name: 'my-graph.json' });
    expect(events).toEqual(['export']);
    expect(p.clicked).toHaveLength(1);
    expect(p.clicked[0].download).toBe('my-graph.json');
    expect(p.clicked[0].href).toMatch(/^blob:/);
  });

  it('downloads as well when the dialog fails for any other reason than a cancel', async () => {
    const events: string[] = [];
    const p = page(async () => {
      throw new DOMException('Not allowed in a cross-origin frame.', 'SecurityError');
    });
    expect(await saveFile(exported(events), ACCEPT)).toEqual({ saved: 'downloaded', name: 'my-graph.json' });
    expect(p.clicked.map((c) => c.download)).toEqual(['my-graph.json']);
  });

  it('writes nothing when the export fails after the dialog, and names the file that was chosen', async () => {
    const events: string[] = [];
    const file = handle('chosen.json', events);
    const p = page(async () => file);
    const failing = async () => {
      throw new Error('the player could not be fetched');
    };
    const err = await saveFile(failing, ACCEPT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveFailed);
    expect((err as SaveFailed).message).toBe('the player could not be fetched');
    expect((err as SaveFailed).picked).toBe('chosen.json');
    expect(events).toEqual([]); // never opened for writing
    expect(p.clicked).toEqual([]);
  });

  it('a write that fails aborts the file, and names it', async () => {
    const events: string[] = [];
    page(async () => ({
      name: 'chosen.json',
      async createWritable() {
        return {
          write: async () => {
            throw new DOMException('The disk is full.', 'QuotaExceededError');
          },
          close: async () => void events.push('close'),
          abort: async () => void events.push('abort'),
        };
      },
    }));
    const err = await saveFile(exported([]), ACCEPT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveFailed);
    expect((err as SaveFailed).message).toBe('could not write chosen.json: The disk is full.');
    expect((err as SaveFailed).picked).toBe('chosen.json');
    expect(events).toEqual(['abort']);
  });

  it('an export that fails with no dialog names no file', async () => {
    page();
    const err = await saveFile(async () => {
      throw new Error('boom');
    }, ACCEPT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveFailed);
    expect((err as SaveFailed).picked).toBeUndefined();
  });
});
