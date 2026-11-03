/**
 * Uploaded NFT datasets in the facade's worker (createNFTTrackerWorker).
 *
 * The studio gives an uploaded dataset a virtual URL prefix (RuntimeContext.virtualFiles
 * maps each of its files to a blob: URL), and the tracker completes a prefix with each
 * extension, which a blob: URL cannot take. The facade's worker cannot be handed that
 * map, so the page puts it in the prefix itself (virtualSource): the facade keeps a
 * prefix's query string after the extension (jsartoolkit-nft 1.16.0), and in the worker
 * a fetch() installed before the facade's worker module (vite.ts) reads each file's blob:
 * URL back from it (virtualFetch). Any other virtual URL (the `.zft` probe) is a 404, as
 * on a plain web server.
 *
 * This file is served to the worker as it is, with its types stripped and no bundling
 * (vite.ts): it must import types only (tests/unit/jsartoolkit-nft-plugin.test.ts checks it).
 */
import type { VirtualAssetOrigin } from '@webarkit/studio-plugin-api';

/** The studio's origin of virtual asset URLs; the type checks it against the studio's. */
export const VIRTUAL_ASSET_ORIGIN: VirtualAssetOrigin = 'https://assets.webarkit.invalid';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A dataset source for the tracker: a virtual prefix gets its files' blob: URLs as `?<extension>=<blob: URL>`. */
export function virtualSource(url: string, files: Record<string, string>): string {
  if (!url.startsWith(`${VIRTUAL_ASSET_ORIGIN}/`)) return url;
  const query = new URLSearchParams();
  for (const [file, blobUrl] of Object.entries(files)) {
    if (file.startsWith(`${url}.`)) query.set(file.slice(url.length + 1), blobUrl);
  }
  return `${url}?${query}`;
}

/** fetch() that serves the files of a virtualSource() from their blob: URLs. */
export function virtualFetch(base: Fetch): Fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${VIRTUAL_ASSET_ORIGIN}/`)) return base(input, init);
    const { pathname, searchParams } = new URL(url);
    const blobUrl = searchParams.get(pathname.slice(pathname.lastIndexOf('.') + 1));
    return blobUrl ? base(blobUrl, init) : Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
  };
}

// In the tracker's worker, before the facade's module runs (see vite.ts).
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.fetch = virtualFetch(self.fetch.bind(self));
}
