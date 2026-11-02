/**
 * Export formats. Each one turns the current graph into a downloadable file.
 * New formats (e.g. readable jsartoolkitNFT source code) are added here and
 * appear in the studio's Export menu.
 */
import type { GraphDocument } from '../core/graph';
import { parseAssetRef, type AssetLookup, type StoredAsset } from '../core/assets';

/** The project's uploaded assets, as exporters read them. */
export interface ProjectAssets {
  get: AssetLookup;
  list(): StoredAsset[];
}

export interface ExportContext {
  /** Base URL the graph's relative asset URLs resolve against (the studio page). */
  baseUrl: string;
  log: (message: string) => void;
  /** Uploaded assets (asset:// params). */
  assets?: ProjectAssets;
}

/** True if any param of the graph references an uploaded asset. */
export const usesUploadedAssets = (doc: GraphDocument) =>
  doc.nodes.some((n) => Object.values(n.params).some((v) => typeof v === 'string' && parseAssetRef(v)));

export interface ExportResult {
  filename: string;
  blob: Blob;
}

export interface Exporter {
  id: string;
  label: string;
  description: string;
  /** false = shown in the menu as planned, not selectable. */
  available: boolean;
  run(doc: GraphDocument, ctx: ExportContext): Promise<ExportResult>;
}

export function slugify(name: string | undefined): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'webar-app';
}

const graphJson: Exporter = {
  id: 'graph-json',
  label: 'Graph (.json)',
  description: 'The node graph only. Re-import it in the studio or run it with any player.',
  available: true,
  async run(doc, ctx) {
    if (usesUploadedAssets(doc)) ctx.log('⚠ the graph uses uploaded assets, which a .json does not carry: export a Project (.zip) to keep them');
    return {
      filename: `${slugify(doc.name)}.json`,
      blob: new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
    };
  },
};

const appBundle: Exporter = {
  id: 'app-bundle',
  label: 'Standalone app (.zip)',
  description: 'Player + graph + assets, ready for any static web server (GitHub Pages, Netlify…).',
  available: true,
  async run(doc, ctx) {
    const { exportAppBundle } = await import('./app-bundle');
    return exportAppBundle(doc, ctx);
  },
};

const project: Exporter = {
  id: 'project',
  label: 'Project (.zip)',
  description: 'The graph and its uploaded assets, to open in another browser with Import…',
  available: true,
  async run(doc, ctx) {
    const { packProject } = await import('./project');
    const zip = await packProject(doc, ctx.assets?.list() ?? []);
    return { filename: `${slugify(doc.name)}.webarkit.zip`, blob: new Blob([zip as BlobPart], { type: 'application/zip' }) };
  },
};

const jsartoolkitSource: Exporter = {
  id: 'jsartoolkitnft-source',
  label: 'jsartoolkitNFT source code (.zip)',
  description: 'Planned: readable, editable code (worker + Three.js) generated from the graph.',
  available: false,
  run() {
    return Promise.reject(new Error('Not implemented yet'));
  },
};

export const EXPORTERS: Exporter[] = [graphJson, project, appBundle, jsartoolkitSource];
