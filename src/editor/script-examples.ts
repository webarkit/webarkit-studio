/** Example scripts for script.lite (#35), offered by the node's Import control. */
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
// A ring of spheres on the marker, turning; its colour from the hue of each sphere.
const spheres = [];
function onInit({ THREE, group, inputs }) {
  for (let i = 0; i < inputs.count; i++) {
    const colour = new THREE.Color().setHSL(i / inputs.count, 0.8, 0.5);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshStandardMaterial({ color: colour }));
    spheres.push(sphere);
    group.add(sphere);
  }
}
function onFrame({ time, inputs }) {
  spheres.forEach((sphere, i) => {
    const angle = time + (i / spheres.length) * Math.PI * 2;
    sphere.position.set(inputs.radius * Math.cos(angle), inputs.radius * Math.sin(angle), 20 + 10 * Math.sin(time * 3 + i));
  });
}
`,
  },
];

/** The examples offered for a script node type. */
export const examplesFor = (type: string): ScriptExample[] => (type === 'three.script' ? THREE_SCRIPT_EXAMPLES : SCRIPT_EXAMPLES);

/** Every example: all ship with the studio, so they are trusted. */
export const ALL_SCRIPT_EXAMPLES: ScriptExample[] = [...SCRIPT_EXAMPLES, ...THREE_SCRIPT_EXAMPLES];
