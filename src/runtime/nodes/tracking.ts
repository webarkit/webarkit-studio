/**
 * Tracker-agnostic nodes: they read a `trackingResult`, whatever tracker
 * produced it (JsartoolkitNFT today, @webarkit/nft-tracker tomorrow).
 */
import type { NodeFactory, TrackedMarkerValue, TrackingResultValue } from '../types';

/** Finds a marker by name, or by index when the selector is an integer. */
export function selectMarker(markers: TrackingResultValue | undefined, selector: string): TrackedMarkerValue | undefined {
  if (!markers?.length) return undefined;
  const key = selector.trim();
  const byName = markers.find((m) => m.name === key);
  if (byName) return byName;
  return /^\d+$/.test(key) ? markers[Number(key)] : undefined;
}

/** tracking.selectMarker */
export const selectMarkerNode: NodeFactory = (params, ctx) => {
  /** Last resolution shown in the node, so it is reported only when it changes. */
  let shown = '';
  const outputs = (markers: TrackingResultValue | undefined) => {
    const m = selectMarker(markers, String(params.marker));
    if (markers?.length) {
      const names = markers.map((x) => `${x.index}:${x.name}`).join(', ');
      const text = m ? `→ ${m.index}: ${m.name}` : `no marker "${String(params.marker)}"\navailable: ${names}`;
      if (text !== shown) {
        shown = text;
        ctx.report(text);
        if (!m) ctx.log(`✗ ${ctx.nodeId}: no marker "${String(params.marker)}" (available: ${names})`);
      }
    }
    return m
      ? { pose: m.pose, found: m.found, onFound: m.onFound, onLost: m.onLost, markerInfo: m.info }
      : { pose: null, found: false, onFound: undefined, onLost: undefined, markerInfo: undefined };
  };
  return {
    init: (inputs) => outputs(inputs.markers as TrackingResultValue),
    update: (inputs) => outputs(inputs.markers as TrackingResultValue),
  };
};
