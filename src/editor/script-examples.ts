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
