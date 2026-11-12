/**
 * Save as (#118). Where the browser has the system save dialog (`showSaveFilePicker`, Chromium browsers), the user
 * picks the file's name and folder, and the export is written there; elsewhere the file downloads under its default
 * name, through an `<a download>` link.
 *
 * The dialog needs the user's gesture, so it opens before the export runs (an app bundle takes seconds to build).
 */
import type { ExportResult } from '../export/exporters';

/** What the dialog offers: the default file name, and the export's type as the only one. */
export interface SaveAccept {
  suggestedName: string;
  /** The type's label in the dialog. */
  description: string;
  mime: string;
  extensions: string[];
}

/** Picked: written where the user chose. Downloaded: saved by the browser under the default name. False: cancelled. */
export type SaveOutcome = { saved: 'picked'; name: string } | { saved: 'downloaded'; name: string } | { saved: false };

/**
 * The export failed. `picked` is the file the user chose in the dialog, if one opened. Nothing was written to it,
 * but Chromium creates the file when it is picked, or empties it if it existed: it is left empty.
 */
export class SaveFailed extends Error {
  constructor(
    message: string,
    readonly picked?: string,
  ) {
    super(message);
    this.name = 'SaveFailed';
  }
}

interface WritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface PickedFile {
  name: string;
  createWritable(): Promise<WritableFile>;
}
type SavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
  excludeAcceptAllOption: boolean;
}) => Promise<PickedFile>;

/**
 * Runs `result` (the export) and saves what it gives. A cancel in the dialog runs nothing. Throws SaveFailed when
 * the export or the write fails.
 */
export async function saveFile(result: () => Promise<ExportResult>, accept: SaveAccept): Promise<SaveOutcome> {
  const picker = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let file: PickedFile | undefined;
  if (typeof picker === 'function') {
    try {
      file = await picker.call(window, {
        suggestedName: accept.suggestedName,
        types: [{ description: accept.description, accept: { [accept.mime]: accept.extensions } }],
        excludeAcceptAllOption: true,
      });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return { saved: false };
      // Anything else (a policy, an iframe, a type the dialog refuses): the download, as without the dialog.
      file = undefined;
    }
  }

  let exported: ExportResult;
  try {
    exported = await result();
  } catch (err) {
    throw new SaveFailed((err as Error).message, file?.name);
  }

  if (file) {
    let writable: WritableFile | undefined;
    try {
      writable = await file.createWritable();
      await writable.write(exported.blob);
      await writable.close();
    } catch (err) {
      // Lets the browser drop what it was writing (a swap file in Chromium) and release the file.
      await writable?.abort?.().catch(() => {});
      throw new SaveFailed(`could not write ${file.name}: ${(err as Error).message}`, file.name);
    }
    return { saved: 'picked', name: file.name };
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(exported.blob);
  a.download = exported.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return { saved: 'downloaded', name: exported.filename };
}
