/**
 * fetch() for the tracker worker that also serves the files of uploaded NFT
 * datasets (src/runtime/assets.ts). The tracker facade loads a dataset from a
 * URL prefix it completes with each extension; for an uploaded dataset that
 * prefix is virtual, and this maps its files onto their blob: URLs. Any other
 * virtual URL (the facade's `.zft` probe) is a 404, as on a plain web server.
 */
import { VIRTUAL_ASSET_ORIGIN } from '../assets';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function virtualFetch(files: Record<string, string>, base: Fetch): Fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${VIRTUAL_ASSET_ORIGIN}/`)) return base(input, init);
    const blobUrl = files[url];
    return blobUrl ? base(blobUrl, init) : Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
  };
}
