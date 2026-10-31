/**
 * Maps every catalog `type` to its runtime implementation.
 * Adding a node = one entry in src/nodes/catalog.ts + one factory here.
 */
import type { NodeFactory } from './types';
import { cameraSource } from './nodes/sources';
import { artkCameraParams, artkController, artkNftDataset, artkSettings } from './nodes/jsartoolkit-nft';
import { jsartoolkitNativeFilter, oneEuroFilter } from './nodes/filters';
import { babylonRenderer, threeRenderer } from './nodes/renderers';
import { anchor, arCamera, light, primitive, sceneNode } from './nodes/scene';
import { arView } from './nodes/ar-view';
import { inspector, statsNode, traceNode } from './nodes/debug';
import { selectMarkerNode } from './nodes/tracking';

export const NODE_REGISTRY: Record<string, NodeFactory> = {
  'source.camera': cameraSource,
  'jsartoolkitNFT.cameraParams': artkCameraParams,
  'jsartoolkitNFT.dataset': artkNftDataset,
  'jsartoolkitNFT.settings': artkSettings,
  'jsartoolkitNFT.controller': artkController,
  'tracking.selectMarker': selectMarkerNode,
  'jsartoolkitNFT.nativeFilter': jsartoolkitNativeFilter,
  'filter.oneEuro': oneEuroFilter,
  'three.renderer': threeRenderer,
  'babylon.renderer': babylonRenderer,
  'scene.scene': sceneNode,
  'scene.arCamera': arCamera,
  'scene.light': light,
  'scene.primitive': primitive,
  'scene.anchor': anchor,
  'output.arView': arView,
  'debug.inspector': inspector,
  'debug.stats': statsNode,
  'debug.trace': traceNode,
};
