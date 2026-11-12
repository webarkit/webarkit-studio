/**
 * Uploaded assets in the graph document.
 *
 * A param marked `asset` holds a URL, or a reference to a file uploaded into
 * the project: `asset://<id>/<name>`. The name is informative (the editor and
 * the exporter show it); the id finds the asset. The document stays plain JSON
 * and the format does not change: the files themselves live in the project's
 * asset store (src/assets/asset-store.ts), and the runtime and the exporter
 * resolve the references.
 */

export const ASSET_SCHEME = 'asset://';

/**
 * An asset kind a plugin declares (StudioPlugin.assetKinds): one asset is
 * several files sharing a base name. A param of this kind holds a URL prefix,
 * which the exporter and the runtime complete with each extension.
 */
export interface AssetKindDefinition {
  /** Plain identifier. Stored in project files and in the browser: renaming one is a breaking change for them. */
  id: string;
  /** For people, as in `Acme marker "logo" is incomplete`. */
  label: string;
  /** The files of one asset, lower case and without the dot. An upload with one of them is of this kind. */
  extensions: readonly string[];
  /** One file that can stand in for the others behind a URL, when they are not all there. Exporting only: never uploaded. */
  alternative?: string;
}

/** The kinds every studio has, with their labels: a single file. */
const CORE_ASSET_KINDS: Record<string, string> = { file: 'file', model: 'model' };

/** Extensions of the `model` kind. */
export const MODEL_EXTENSIONS: readonly string[] = ['glb', 'gltf'];

/** Kinds of the loaded plugins (registerAssetKinds). */
const PLUGIN_ASSET_KINDS = new Map<string, AssetKindDefinition>();

/** Adds a plugin's asset kinds (already validated, see src/core/plugins.ts). */
export function registerAssetKinds(kinds: readonly AssetKindDefinition[]): void {
  for (const kind of kinds) PLUGIN_ASSET_KINDS.set(kind.id, kind);
}

/** The asset kinds of the loaded plugins. */
export const pluginAssetKinds = (): AssetKindDefinition[] => [...PLUGIN_ASSET_KINDS.values()];

/** The definition of a plugin's kind, whose params hold a URL prefix; undefined for `file` and `model`, a single file. */
export const pluginAssetKind = (id: unknown): AssetKindDefinition | undefined => (typeof id === 'string' ? PLUGIN_ASSET_KINDS.get(id) : undefined);

export const isCoreAssetKind = (id: unknown): boolean => typeof id === 'string' && Object.hasOwn(CORE_ASSET_KINDS, id);

export const isAssetKind = (id: unknown): boolean => typeof id === 'string' && (Object.hasOwn(CORE_ASSET_KINDS, id) || PLUGIN_ASSET_KINDS.has(id));

/** Every kind's id: the built-in ones, then those of the plugins. */
export const assetKindIds = (): string[] => [...Object.keys(CORE_ASSET_KINDS), ...PLUGIN_ASSET_KINDS.keys()];

/** A kind's label; its id if its plugin is not loaded (an asset can outlive it, in the browser's store). */
export const assetKindLabel = (id: string): string => (Object.hasOwn(CORE_ASSET_KINDS, id) ? CORE_ASSET_KINDS[id] : (PLUGIN_ASSET_KINDS.get(id)?.label ?? id));

/** The id of the kind an extension belongs to, if any. */
export function assetKindOfExtension(extension: string): string | undefined {
  if (MODEL_EXTENSIONS.includes(extension)) return 'model';
  return pluginAssetKinds().find((k) => k.extensions.includes(extension))?.id;
}

export function assetRef(id: string, name: string): string {
  return `${ASSET_SCHEME}${id}/${encodeURIComponent(name)}`;
}

/** The id and name of an asset reference, or null for anything else (URLs, empty values). */
export function parseAssetRef(value: string): { id: string; name: string } | null {
  if (!value.startsWith(ASSET_SCHEME)) return null;
  const rest = value.slice(ASSET_SCHEME.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  if (!id) return null;
  let name = slash < 0 ? '' : rest.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw name */
  }
  return { id, name };
}
