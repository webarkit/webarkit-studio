/** Values on the plugin's own sockets (catalog.ts SOCKETS). */
import type { NftSettings } from './nft-session';

/** jsartoolkitNFT.cameraParams */
export interface ArtkCameraParamsValue {
  url: string;
}
/** jsartoolkitNFT.dataset */
export interface ArtkNftDatasetValue {
  url: string;
  /** Marker name used by Select Marker (defaults to the URL's last segment). */
  name: string;
}
/** jsartoolkitNFT.settings: the Controller Settings, applied with the tracker's configure() (live). */
export type ArtkSettingsValue = NftSettings;
