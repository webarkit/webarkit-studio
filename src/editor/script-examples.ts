/** Example scripts for script.lite (#35), offered by the node's Import control. */
import { scriptHeaderOf } from '../core/script';
export interface ScriptExample {
  label: string;
  file: string;
  text: string;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    label: 'Bob: a height that goes up and down',
    file: 'bob.js',
    text: `/*
in  t       number  d=0
in  height  number  d=30 min=0 max=200
out position vector3
*/
// The math demo's animation in one node: wire Time's Seconds into t, and position into a Primitive's Position.
position = [0, 0, 40 + height * Math.sin(t * Math.PI)];
`,
  },
  {
    label: 'Rainbow: a colour that goes round the wheel',
    file: 'rainbow.js',
    text: `/*
in  speed  number  d=60 step=10
out color  color
*/
// Hue in degrees, from the script's own clock: wire color into a Primitive's or a Light's Color.
const h = ((time * speed) % 360) / 60;
const x = 1 - Math.abs((h % 2) - 1);
const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
color = [r, g, b, 1];
`,
  },
  {
    label: 'Counter: counts an event, and fires every tenth',
    file: 'counter.js',
    text: `/*
in  tap    event
in  every  number  d=10 min=1
out count  number
out tenth  event
run on-change
*/
// Wire an event (a button, a marker's onFound) into tap. state keeps the count between runs.
state.count ??= 0;
if (tap) {
  state.count += 1;
  if (state.count % every === 0) tenth = state.count;
}
count = state.count;
`,
  },
];

/** Example scripts for three.script (#36). */
export const THREE_SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    label: 'Ring: spheres that go round, and bob',
    file: 'ring.js',
    text: `/*
in  count   number  d=8 min=1 max=32 step=1
in  radius  number  d=50 min=0 max=200
*/
// A ring of spheres on the marker, turning, each its own hue. count applies live: onFrame adds or removes spheres.
const spheres = [];
const target = (count) => Math.max(1, Math.round(count));
function setCount(THREE, group, count) {
  const n = target(count);
  while (spheres.length > n) {
    const sphere = spheres.pop();
    group.remove(sphere);
    sphere.geometry.dispose();
    sphere.material.dispose();
  }
  while (spheres.length < n) {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshStandardMaterial());
    spheres.push(sphere);
    group.add(sphere);
  }
  spheres.forEach((sphere, i) => sphere.material.color.setHSL(i / n, 0.8, 0.5));
}
function onInit({ THREE, group, inputs }) {
  setCount(THREE, group, inputs.count);
}
function onFrame({ THREE, group, time, inputs }) {
  if (target(inputs.count) !== spheres.length) setCount(THREE, group, inputs.count);
  spheres.forEach((sphere, i) => {
    const angle = time + (i / spheres.length) * Math.PI * 2;
    sphere.position.set(inputs.radius * Math.cos(angle), inputs.radius * Math.sin(angle), 20 + 10 * Math.sin(time * 3 + i));
  });
}
`,
  },
];

/** Example scripts for three.renderScript (#37): the script owns the scene, and places its content on the marker. */
export const RENDER_SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    label: 'Cube: a cube that bobs and turns on the marker',
    file: 'cube.js',
    text: `/*
in  size    number  d=40 min=5 max=200
in  height  number  d=30 min=0 max=200
*/
// A cube on the marker, bobbing and turning. placeOnMarker places the group as a Marker Anchor does.
let marker, cube;
function onInit({ THREE, scene }) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(0, 0, 1);
  scene.add(light);
  marker = new THREE.Group();
  scene.add(marker);
  cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x00a0ff }));
  marker.add(cube);
}
function onFrame({ pose, found, markerInfo, helpers, time, inputs }) {
  helpers.placeOnMarker(marker, pose, found, markerInfo);
  cube.scale.setScalar(inputs.size);
  cube.position.z = inputs.size / 2 + inputs.height * (1 + Math.sin(time * Math.PI)) / 2;
  cube.rotation.z = time;
}
`,
  },
  {
    label: 'Rainbow: a knot whose colour goes round the wheel',
    file: 'rainbow.js',
    text: `/*
in  speed  number  d=0.2 min=0 max=2
*/
// A torus knot on the marker; its hue turns \`speed\` times a second.
let marker, knot;
function onInit({ THREE, scene }) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(0, 0, 1);
  scene.add(light);
  marker = new THREE.Group();
  scene.add(marker);
  knot = new THREE.Mesh(new THREE.TorusKnotGeometry(25, 8, 100, 16), new THREE.MeshStandardMaterial());
  knot.position.z = 40;
  marker.add(knot);
}
function onFrame({ pose, found, markerInfo, helpers, time, inputs }) {
  helpers.placeOnMarker(marker, pose, found, markerInfo);
  knot.material.color.setHSL((time * inputs.speed) % 1, 0.8, 0.5);
}
`,
  },
];

const BY_TYPE: Record<string, ScriptExample[]> = {
  'three.script': THREE_SCRIPT_EXAMPLES,
  'three.renderScript': RENDER_SCRIPT_EXAMPLES,
};

/** The examples offered for a script node type: only those whose header the type accepts. */
export const examplesFor = (type: string): ScriptExample[] =>
  (BY_TYPE[type] ?? SCRIPT_EXAMPLES).filter((ex) => scriptHeaderOf(ex.text, type).errors.length === 0);

/** Every example: all ship with the studio, so they are trusted. */
export const ALL_SCRIPT_EXAMPLES: ScriptExample[] = [...SCRIPT_EXAMPLES, ...THREE_SCRIPT_EXAMPLES, ...RENDER_SCRIPT_EXAMPLES];
