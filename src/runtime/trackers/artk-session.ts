/**
 * ArtkSession: everything the JsartoolkitNFT worker does, without the worker.
 *
 * Wraps one ARControllerNFT with several NFT datasets and turns its events into
 * a per-frame result: one pose slot per marker, found / lost transitions, the
 * time process() took. Pose filters and found/lost state are kept *per marker*
 * (as in the upstream multi-marker example), so markers never share a filter.
 *
 * It only depends on the controller's public API (ArtkControllerLike), so the
 * same code runs in the browser worker and in Node tests with the Node build.
 */
import { createPoseFilter, type PoseFilter, type PoseFilterConfig } from '../filters/pose-filter';

/** The part of ARControllerNFT the session uses (browser, SIMD and Node builds). */
export interface ArtkControllerLike {
  setFiltering(enabled: boolean): void;
  setContinuousDetection(enabled: boolean): void;
  setDetectionInterval(ms: number): void;
  setLogLevel(level: number): void;
  setProjectionNearPlane(value: number): void;
  setProjectionFarPlane(value: number): void;
  getProjectionNearPlane(): number;
  getProjectionFarPlane(): number;
  /** jsartoolkitNFT >= 1.14.0 (#706): rebuilds getCameraMatrix() from the stored planes. */
  recalculateCameraLens(): void;
  addEventListener(name: string, callback: object): void;
  loadNFTMarkers(urls: string[], onSuccess: (ids: number[]) => void, onError: (err: unknown) => void): unknown;
  trackNFTMarkerId(id: number): unknown;
  getNFTData(index: number): unknown;
  getCameraMatrix(): ArrayLike<number>;
  process(image: never): void;
}

/** Creates and initialises a controller for a processing frame of width × height. */
export type ArtkControllerFactory = (width: number, height: number, cameraUrl: string) => Promise<ArtkControllerLike>;

export interface ArtkSettings {
  continuousDetection: boolean;
  detectionInterval: number;
  logLevel: number;
  /** Projection planes, in marker units (mm). Applied with recalculateCameraLens(). */
  near: number;
  far: number;
}

export interface ArtkSessionOptions {
  width: number;
  height: number;
  cameraUrl: string;
  /** Dataset URL prefixes; marker index = position in this array. */
  datasetUrls: string[];
  filter: PoseFilterConfig | null;
  settings: ArtkSettings | null;
}

export interface ArtkMarkerData {
  id: number;
  width: number;
  height: number;
  dpi: number;
}

export interface ArtkFrameResult {
  /** One slot per dataset: column-major 4x4 pose (matrixGL_RH), null when not tracked this frame. */
  poses: Array<number[] | null>;
  /** Transitions in this frame: found = first tracked frame, lost = after the library's grace period. */
  events: Array<{ name: 'found' | 'lost'; index: number }>;
  /** Duration of process(), milliseconds. */
  processMs: number;
}

export class ArtkSession {
  /** getCameraMatrix(), always rebuilt from the current near / far (see refreshLens). */
  cameraMatrix: number[];
  readonly markers: ArtkMarkerData[];

  private readonly filters: Array<PoseFilter | null>;
  private readonly visible: boolean[];
  private poses: Array<number[] | null>;
  private events: ArtkFrameResult['events'] = [];

  private constructor(
    private readonly ar: ArtkControllerLike,
    options: ArtkSessionOptions,
    ids: number[],
    private readonly now: () => number,
  ) {
    const n = options.datasetUrls.length;
    this.filters = Array.from({ length: n }, () => (options.filter ? createPoseFilter(options.filter) : null));
    this.visible = new Array(n).fill(false);
    this.poses = new Array(n).fill(null);
    this.cameraMatrix = ArtkSession.refreshLens(ar);
    this.markers = ids.map((id, index) => {
      const d = ar.getNFTData(index) as { width: number; height: number; dpi: number };
      return { id, width: d.width, height: d.height, dpi: d.dpi };
    });

    // getNFTMarker fires on every frame a marker is tracked: onFound is its rising edge.
    ar.addEventListener('getNFTMarker', (ev: { data: { index: number; matrixGL_RH: ArrayLike<number> } }) => {
      const { index, matrixGL_RH } = ev.data;
      if (index < 0 || index >= n) return;
      const filter = this.filters[index];
      this.poses[index] = filter ? filter.filter(this.now(), matrixGL_RH) : Array.from(matrixGL_RH);
      if (!this.visible[index]) {
        this.visible[index] = true;
        this.events.push({ name: 'found', index });
      }
    });
    // lostNFTMarker fires once, after MarkerLostTracker's grace period.
    ar.addEventListener('lostNFTMarker', (ev: { data: { index: number } }) => {
      const { index } = ev.data;
      if (index < 0 || index >= n) return;
      this.filters[index]?.reset();
      if (this.visible[index]) {
        this.visible[index] = false;
        this.events.push({ name: 'lost', index });
      }
    });
  }

  static async create(
    factory: ArtkControllerFactory,
    options: ArtkSessionOptions,
    now: () => number = () => performance.now(),
  ): Promise<ArtkSession> {
    if (!options.datasetUrls.length) throw new Error('at least one NFT dataset is required');
    if (options.filter?.kind === 'native' && options.filter.library !== 'jsartoolkitNFT') {
      throw new Error(`native filter for "${options.filter.library}" cannot be used with JsartoolkitNFT`);
    }
    const ar = await factory(options.width, options.height, options.cameraUrl);
    if (options.settings) ArtkSession.apply(ar, options.settings);
    ar.setFiltering(options.filter?.kind === 'native');

    const ids = await new Promise<number[]>((resolve, reject) => {
      ar.loadNFTMarkers(
        options.datasetUrls,
        (loaded) => resolve(loaded),
        (err) => reject(new Error(`cannot load NFT datasets ${options.datasetUrls.join(', ')} (code ${String(err)})`)),
      );
    });
    for (const id of ids) ar.trackNFTMarkerId(id);
    return new ArtkSession(ar, options, ids, now);
  }

  private static apply(ar: ArtkControllerLike, s: ArtkSettings) {
    ar.setContinuousDetection(s.continuousDetection);
    ar.setDetectionInterval(s.detectionInterval);
    ar.setLogLevel(s.logLevel);
    ar.setProjectionNearPlane(s.near);
    ar.setProjectionFarPlane(s.far);
  }

  /**
   * ARControllerNFT caches the lens at init, *before* it sets its default planes
   * (so the matrix is built with the core's near 0.0001), and the plane setters
   * only store values. Rebuilding it here keeps getCameraMatrix() consistent
   * with getProjectionNearPlane() / getProjectionFarPlane().
   */
  private static refreshLens(ar: ArtkControllerLike): number[] {
    ar.recalculateCameraLens();
    return Array.from(ar.getCameraMatrix());
  }

  get near(): number {
    return this.ar.getProjectionNearPlane();
  }

  get far(): number {
    return this.ar.getProjectionFarPlane();
  }

  /** Applies new settings; returns the rebuilt camera matrix if near / far changed, else null. */
  configure(settings: ArtkSettings): number[] | null {
    const planesChanged = settings.near !== this.near || settings.far !== this.far;
    ArtkSession.apply(this.ar, settings);
    if (!planesChanged) return null;
    this.cameraMatrix = ArtkSession.refreshLens(this.ar);
    return this.cameraMatrix;
  }

  /** Processes one RGBA frame (ImageData or { data, width, height }). */
  process(image: { data: ArrayLike<number>; width: number; height: number }): ArtkFrameResult {
    this.poses = new Array(this.poses.length).fill(null);
    this.events = [];
    const t0 = performance.now();
    this.ar.process(image as never);
    const processMs = performance.now() - t0;
    return { poses: this.poses, events: this.events, processMs };
  }
}
