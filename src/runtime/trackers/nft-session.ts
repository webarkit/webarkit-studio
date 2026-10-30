/**
 * NftSession: the jsartoolkitNFT tracker facade (createNFTTracker, #5) as the
 * controller node uses it.
 *
 * The facade does the tracking: per-target poses, found / lost transitions
 * after `lostTimeout`, pose filters, the lens and its projection. This file
 * only maps the graph's values onto it (Controller Settings → configure(),
 * filter slot → `filter`) and its target ids onto dataset indices, so the
 * same code runs in the browser worker and in Node tests with the Node build.
 */
import type {
  FilterConfig,
  FrameGeometry,
  NFTAR2Settings,
  NFTTracker,
  NFTTrackerConfig,
  NFTTrackerPatch,
  TargetLoad,
} from '@webarkit/jsartoolkit-nft';
import type { PoseFilterConfig } from '../filters/pose-filter';

/** createNFTTracker of one build (browser, SIMD or Node). */
export type NftTrackerFactory = (config: NFTTrackerConfig) => Promise<NFTTracker>;

/** The jsartoolkitNFT.settings value (see the catalog for the defaults). */
export interface NftSettings {
  continuousDetection: boolean;
  detectionInterval: number;
  logLevel: number;
  /** Projection planes, in marker units (mm). */
  near: number;
  far: number;
  /** Grace period before `lost`, ms. Absent: the facade's default (200 ms). */
  lostTimeout?: number;
  /** AR2 tracking parameters; absent fields keep the core's defaults. */
  ar2?: Partial<NFTAR2Settings>;
}

export interface NftSessionOptions {
  cameraUrl: string;
  /** Dataset URL prefixes; marker index = position in this array. */
  datasetUrls: string[];
  filter: PoseFilterConfig | null;
  settings: NftSettings | null;
  /**
   * Where the video sits in the processing frame. frameWidth × frameHeight is the
   * tracker's frame size (integers): every frame passed to process() has it.
   */
  geometry: FrameGeometry;
}

export interface NftMarkerData {
  id: number;
  width: number;
  height: number;
  dpi: number;
  widthMM: number;
  heightMM: number;
}

export interface NftFrameResult {
  /** One slot per dataset: column-major 4x4 pose (mm), null when not tracked this frame. */
  poses: Array<number[] | null>;
  /** Transitions in this frame: found = first tracked frame, lost = after `lostTimeout`. */
  events: Array<{ name: 'found' | 'lost'; index: number }>;
  /** Duration of process(), milliseconds. */
  processMs: number;
}

/** The filter slot as the facade's `filter`: no filter node means no filtering. */
export function filterConfig(filter: PoseFilterConfig | null): FilterConfig {
  if (!filter) return 'none';
  if (filter.kind === 'native') return 'native';
  return { type: 'oneEuro', minCutOff: filter.minCutOff, beta: filter.beta, warmUp: filter.warmUp };
}

/** Controller Settings as a configure() patch. */
export function settingsPatch(s: NftSettings): NFTTrackerPatch {
  const patch: NFTTrackerPatch = {
    continuousDetection: s.continuousDetection,
    detectionInterval: s.detectionInterval,
    logLevel: s.logLevel,
    near: s.near,
    far: s.far,
  };
  if (s.lostTimeout !== undefined) patch.lostTimeout = s.lostTimeout;
  if (s.ar2 && Object.keys(s.ar2).length) patch.ar2 = s.ar2;
  return patch;
}

/** A failed load, one line per dataset. */
export const describeLoadError = (load: Extract<TargetLoad, { status: 'error' }>) =>
  `cannot load NFT dataset ${load.url} (${load.reason}): ${load.message}`;

export class NftSession {
  private constructor(
    private readonly tracker: NFTTracker,
    private readonly geometry: FrameGeometry,
    /** Facade target id → dataset index. */
    private readonly indexOf: Map<number, number>,
    readonly markers: NftMarkerData[],
  ) {}

  /** Rejects if any dataset fails to load, with one line per failed dataset. */
  static async create(create: NftTrackerFactory, options: NftSessionOptions): Promise<NftSession> {
    if (!options.datasetUrls.length) throw new Error('at least one NFT dataset is required');
    if (options.filter?.kind === 'native' && options.filter.library !== 'jsartoolkitNFT') {
      throw new Error(`native filter for "${options.filter.library}" cannot be used with JsartoolkitNFT`);
    }
    const tracker = await create({
      width: options.geometry.frameWidth,
      height: options.geometry.frameHeight,
      cameraParam: options.cameraUrl,
      filter: filterConfig(options.filter),
      ...(options.settings ? settingsPatch(options.settings) : {}),
    });
    try {
      const loads = await tracker.addNFTTargets(options.datasetUrls);
      const failed = loads.filter((l) => l.status === 'error');
      if (failed.length) throw new Error(failed.map(describeLoadError).join('\n'));
      const indexOf = new Map<number, number>();
      const markers = loads.map((load, index) => {
        if (load.status !== 'loaded') throw new Error('unreachable');
        const { id, widthPx, heightPx, dpi, widthMm, heightMm } = load.info;
        indexOf.set(id, index);
        return { id, width: widthPx, height: heightPx, dpi, widthMM: widthMm, heightMM: heightMm };
      });
      return new NftSession(tracker, options.geometry, indexOf, markers);
    } catch (err) {
      tracker.dispose();
      throw err;
    }
  }

  /** The lens for the processing frame (getCameraMatrix()). */
  get cameraMatrix(): number[] {
    return Array.from(this.tracker.cameraMatrix);
  }

  /** The lens mapped back onto the video: the letterbox undone, for a view with the video's aspect. */
  get projection(): number[] {
    const { videoWidth: width, videoHeight: height } = this.geometry;
    return Array.from(this.tracker.projectionFor({ width, height }, this.geometry));
  }

  /** Applies new settings; resolves to true if the lens changed (near / far). */
  async configure(settings: NftSettings): Promise<boolean> {
    const before = this.tracker.cameraMatrix;
    await this.tracker.configure(settingsPatch(settings));
    const after = this.tracker.cameraMatrix;
    return after.some((v, i) => v !== before[i]);
  }

  /** Processes one RGBA frame of the processing size; `time` is an increasing clock, ms. */
  process(image: { data: Uint8ClampedArray; width: number; height: number }, time: number): NftFrameResult {
    const result = this.tracker.process(image, time);
    const poses: NftFrameResult['poses'] = new Array(this.markers.length).fill(null);
    for (const t of result.targets) {
      const index = this.indexOf.get(t.id);
      if (index !== undefined && t.pose) poses[index] = Array.from(t.pose);
    }
    const events: NftFrameResult['events'] = [];
    for (const { type, id } of result.transitions) {
      const index = this.indexOf.get(id);
      if (index !== undefined) events.push({ name: type, index });
    }
    return { poses, events, processMs: result.processMs };
  }

  dispose() {
    this.tracker.dispose();
  }
}
