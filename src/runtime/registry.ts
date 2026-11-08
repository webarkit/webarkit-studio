/**
 * Maps every catalog `type` to its runtime implementation: the core nodes
 * here, plugin nodes added when a plugin is installed (src/plugins/host.ts).
 * Adding a core node = one entry in src/nodes/catalog.ts + one factory here.
 */
import type { NodeFactory } from './types';
import { cameraSource, imageSource, videoFileSource } from './nodes/sources';
import { oneEuroFilter } from './nodes/filters';
import { babylonRenderer, threeRenderer } from './nodes/renderers';
import { anchor, arCamera, gltf, light, primitive, sceneNode } from './nodes/scene';
import { arView } from './nodes/ar-view';
import { add, addVector3, multiply, number, scaleVector3, sin, splitVector3, time, vector3 } from './nodes/math';
import { rgba, split } from './nodes/color';
import { expression } from './nodes/expression';
import { and, branch, compare, edge, not, or, switchNode, timer, toggle } from './nodes/logic';
import { dispatchEvent, openUrl, playAnimation, playSound, setVisible } from './nodes/actions';
import { pageEvent } from './nodes/page';
import { inspector, statsNode, traceNode } from './nodes/debug';
import { selectMarkerNode } from './nodes/tracking';

export const NODE_REGISTRY: Record<string, NodeFactory> = {
  'source.camera': cameraSource,
  'source.image': imageSource,
  'source.videoFile': videoFileSource,
  'tracking.selectMarker': selectMarkerNode,
  'filter.oneEuro': oneEuroFilter,
  'three.renderer': threeRenderer,
  'babylon.renderer': babylonRenderer,
  'scene.scene': sceneNode,
  'scene.arCamera': arCamera,
  'scene.light': light,
  'scene.primitive': primitive,
  'scene.gltf': gltf,
  'scene.anchor': anchor,
  'output.arView': arView,
  'math.number': number,
  'math.vector3': vector3,
  'math.splitVector3': splitVector3,
  'math.addVector3': addVector3,
  'math.scaleVector3': scaleVector3,
  'math.add': add,
  'math.multiply': multiply,
  'math.sin': sin,
  'math.time': time,
  'color.rgba': rgba,
  'color.split': split,
  'math.expression': expression,
  'logic.and': and,
  'logic.or': or,
  'logic.not': not,
  'logic.toggle': toggle,
  'logic.timer': timer,
  'logic.compare': compare,
  'logic.edge': edge,
  'logic.branch': branch,
  'logic.switch': switchNode,
  'action.playAnimation': playAnimation,
  'action.setVisible': setVisible,
  'action.playSound': playSound,
  'action.openUrl': openUrl,
  'action.dispatchEvent': dispatchEvent,
  'page.event': pageEvent,
  'debug.inspector': inspector,
  'debug.stats': statsNode,
  'debug.trace': traceNode,
};
