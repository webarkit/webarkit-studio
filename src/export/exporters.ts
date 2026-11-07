/**
 * Export formats. Each one turns the current graph into a downloadable file.
 * New formats are added here and appear in the studio's Export menu.
 */
import type { GraphDocument } from '../core/graph';
import { parseAssetRef } from '../core/assets';
import type { AssetLookup, StoredAsset } from '../assets/asset';

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
  async run(doc, ctx) {
    const { exportAppBundle } = await import('./app-bundle');
    return exportAppBundle(doc, ctx);
  },
};

const project: Exporter = {
  id: 'project',
  label: 'Project (.zip)',
  description: 'The graph and its uploaded assets, to open in another browser with Import…',
  async run(doc, ctx) {
    const { packProject } = await import('./project');
    const zip = await packProject(doc, ctx.assets?.list() ?? []);
    return { filename: `${slugify(doc.name)}.webarkit.zip`, blob: new Blob([zip as BlobPart], { type: 'application/zip' }) };
  },
};

const pagesProject: Exporter = {
  id: 'pages-project',
  label: 'GitHub Pages project (.zip)',
  description: 'The standalone app and a workflow that deploys it: push it to a repository of your own, with no token. Its README.md has the steps.',
  async run(doc, ctx) {
    const { exportPagesProject } = await import('./pages-project');
    return exportPagesProject(doc, ctx);
  },
};

export const EXPORTERS: Exporter[] = [graphJson, project, appBundle, pagesProject];
