/**
 * The one list of demo graphs (#179). Each `id` is a file in `public/graphs/`
 * (`<id>.json`), and a unit test keeps the two in step. The first demo opens
 * with no autosave.
 */

export interface Demo {
  id: string;
  title: string;
  description: string;
}

export const DEMOS: readonly Demo[] = [
  { id: 'pinball-three', title: 'Pinball · Three.js', description: 'The pinball marker, drawn with Three.js' },
  { id: 'pinball-babylon', title: 'Pinball · Babylon.js', description: 'The pinball marker, drawn with Babylon.js' },
  { id: 'multi-three', title: 'Multi NFT', description: 'pinball + kuva' },
  { id: 'pinball-image', title: 'Image, no camera', description: 'pinball tracked in a still image' },
  { id: 'pinball-shadow', title: 'Shadow', description: 'a model standing on the poster, with its shadow' },
  { id: 'pinball-material', title: 'Materials', description: 'a textured poster and a chrome knot' },
  { id: 'pinball-math', title: 'Math and colour', description: 'math and colour nodes: a bobbing, fading cube' },
  { id: 'pinball-expression', title: 'Expression', description: 'one formula (Expression node)' },
  { id: 'pinball-animated', title: 'Animated model', description: 'plays on found, pauses on lost' },
  { id: 'pinball-math-model', title: 'Math on a model', description: 'a bobbing, turning cube' },
  { id: 'pinball-group', title: 'Group', description: 'a group of shapes turning on the marker' },
  { id: 'pinball-script', title: 'Script', description: 'the math demo in a Script node' },
  { id: 'pinball-three-script', title: 'three.js script', description: 'a three.js script builds the scene' },
  { id: 'pinball-render-script', title: 'Render script', description: 'one three.js script renders it all' },
];
