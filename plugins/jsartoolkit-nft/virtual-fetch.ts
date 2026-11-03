/**
 * fetch() for the tracker worker that also serves the files of uploaded NFT
 * datasets (RuntimeContext.virtualFiles). The tracker facade loads a dataset from a
 * URL prefix it completes with each extension; for an uploaded dataset that
 * prefix is virtual, and this maps its files onto their blob: URLs. Any other
 * virtual URL (the facade's `.zft` probe) is a 404, as on a plain web server.
 */
import type { VirtualAssetOrigin } from '@webarkit/studio-plugin-api';

/** The studio's origin of virtual asset URLs; the type checks it against the studio's. */
export const VIRTUAL_ASSET_ORIGIN: VirtualAssetOrigin = 'https://assets.webarkit.invalid';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function virtualFetch(files: Record<string, string>, base: Fetch): Fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${VIRTUAL_ASSET_ORIGIN}/`)) return base(input, init);
    const blobUrl = files[url];
    return blobUrl ? base(blobUrl, init) : Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
  };
}
