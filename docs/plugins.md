# Writing a plugin

A plugin adds nodes to WebARKit Studio without changes to the studio itself: node
definitions, their runtime factories, socket types of its own, and the files an exported
app needs. The jsartoolkitNFT nodes are a plugin
([`plugins/jsartoolkit-nft/`](../plugins/jsartoolkit-nft/)): read it next to this page.

Plugins are loaded at build time today. Loading one from a URL at runtime is planned (#12, Phase D).

## The manifest

A plugin module's default export is a `StudioPlugin`
([`src/plugin-api/index.ts`](../src/plugin-api/index.ts)):

```ts
import type { StudioPlugin } from '@webarkit/studio-plugin-api';

const plugin: StudioPlugin = {
  id: 'acme',              // namespace of every node and socket type
  version: '0.1.0',        // the plugin's own semver
  apiVersion: 1,           // the plugin API version it was built for
  nodes: [/* NodeDefinition, type 'acme.*' */],
  factories: { 'acme.tracker': acmeTracker /* one per node */ },
  sockets: [{ id: 'acme.marker', label: 'Acme marker', color: '#ffb74d' }],
  assetKinds: [/* see "Asset kinds" */],
  exportFiles: [/* see below */],
  crossOriginIsolation: (nodes) => false, // optional, see "Cross-origin isolation"
};
export default plugin;
```

When the plugin is installed, the studio checks it (`validatePlugin`, `src/core/plugins.ts`)
and refuses it with the list of problems if:

- `id` is not a plain identifier (letters and digits), is one of the built-in namespaces
  (`source`, `tracking`, `filter`, `three`, `babylon`, `scene`, `output`, `math`, `color`, `logic`,
  `action`, `page`, `ui`, `debug`, `script`), is `webarkit` (reserved for webarkit/webarkit), or is already loaded (jsartoolkitNFT
  is taken by the bundled plugin);
- `version` is not `x.y.z`, or `apiVersion` is not the studio's `PLUGIN_API_VERSION`;
- a node type or socket id does not start with `<id>.`, or is defined twice;
- a node has no factory, or a factory has no node;
- a port uses a socket type that is neither a core socket nor one of the plugin's;
- an asset kind is invalid, or a param's `asset` is neither built in nor declared by the plugin (see
  "Asset kinds").

Node definitions and factories follow the same rules as the built-in nodes (`AGENTS.md`,
"Adding a node"): the definitions are metadata only, factories implement `init`, `update`,
`onParamChange` for `live` params and `dispose`.

A plugin node's ports are the ones its definition lists. A script node (`script.lite`, #35) is
different: its ports and some of its params come from its script's header, per node. The studio reads
every node's ports through `effectiveDefinition()` (`src/core/script.ts`), so a plugin's node never needs
to know about scripts, and a script can feed it like any node of the same socket types. Scripts run in
the page: the studio asks before running scripts from someone else, and the MCP server never runs them.

A node that runs code its graph holds sets `runsCode: true` in its definition (types package 1.3.0, #36), as
`script.lite`, `three.script` and `three.renderScript` do. Its `script` param is then that code, with a header, and the studio's
trust prompt, the player's `?graph=` refusal and the MCP server's refusal cover it, by that flag and never by
its name. A plugin node that runs code it was given must set it.

## Registering it

List the plugin in [`webarkit-studio.config.ts`](../webarkit-studio.config.ts), under its id,
as a lazy import. A plugin with a build-time part (a Vite plugin that serves files outside the
module graph, see "Workers and assets") is also added to `plugins` in
[`vite.config.ts`](../vite.config.ts): the `StudioPlugin` manifest is browser code and cannot
carry it.

```ts
export default {
  plugins: {
    jsartoolkitNFT: () => import('./plugins/jsartoolkit-nft'),
    acme: () => import('acme-studio-plugin'),
  },
} satisfies StudioConfig;
```

Each plugin becomes its own chunk. The studio loads every plugin at startup (the palette lists
their nodes); the standalone player loads only the plugins its graph lists.

## Graphs that use a plugin

A graph lists the plugins its nodes come from, with the minimum version (graph format v5):

```json
{ "format": "webarkit-studio/graph", "version": 5, "plugins": [{ "id": "acme", "version": "0.1.0" }], "nodes": [] }
```

The editor writes `plugins` when it saves. Opening a graph whose plugin is missing reports it by
name ("requires plugin acme ≥ 0.1.0, which is not loaded"), and a graph that uses a plugin's
nodes without listing it is invalid.

Older documents upgrade when they are loaded (`src/core/migrations.ts`), but those are steps of the
studio's format. **A plugin cannot declare a migration yet:** a plugin that renames its own node,
port or param has no path for the graphs that use the old name, and they fail validation.

A string param may set `syntax: 'expression'` only for a `math.expression`-style formula: the
editor checks it against that node's variables (a–d, t).

## The sockets contract

The core socket types (`CORE_SOCKET_TYPES` in `src/core/sockets.ts`) and the values they carry
(`src/plugin-api`: `VideoValue`, `TrackingResultValue` / `TrackedMarkerValue`, `ProjectionValue`,
`MarkerInfoValue`, `PoseFilterValue`, `EventValue`, `TrackingStatsValue`, `TrackingTraceValue`,
`ColorValue`, …) are the contract between plugins. Changing one is a breaking change of the plugin
API, which bumps `PLUGIN_API_VERSION`. Adding a socket type (as `number`, `vector3`, `color`,
`vector2` and `quaternion` were) is not: plugins built for the same API version keep working.

Vectors and rotations are plain arrays of numbers: `vector2` is `[x, y]`, `vector3` is `[x, y, z]`,
`quaternion` is `[x, y, z, w]` (a unit quaternion), and `matrix4` holds 16 numbers, column-major. The
Inspector shows each as a list (a `matrix4` as four rows).

A pure node (its outputs depend only on its inputs and params) is computed only when an input or a live
param changes: inputs are compared by `Object.is`, so a node that outputs an array must return a new
array when its values change, and keep the old one when they do not. The core's math, colour and logic
nodes do so; a plugin's node that feeds them should too. The helper that does this (`src/runtime/computed.ts`)
is the studio's own, not part of the plugin API.

The values of the `renderer`, `scene` and `sceneObject` sockets are studio internals, not part of
plugin API v1: a plugin may pass them through (wire them from one port to another) but must not
call methods on them. The plugin API exports no type for them.

A tracker plugin that outputs `trackingResult`, `projection`, `onFound` / `onLost` and `stats`
works with Select Marker, Marker Anchor, AR Camera, the filters, Inspector and Stats unchanged.
Data only its own nodes exchange (calibration files, marker descriptions, settings) gets a socket
of its own, `<id>.<name>`, so it cannot be wired into another tracker.

Two connections are possible only between equal socket types (or into `any`). Units and spaces
are the studio's: marker space in millimetres, marker on the XY plane with +Z up, column-major
matrices, the camera looking down −Z.

## Events

An `event` socket carries an `EventValue`: `{ count, time, data? }`.

- **`count`** is how many times this event has fired since the graph started.
- **`time`** is `Date.now()` when it fired, in epoch milliseconds. `FrameInfo.time` is
  `performance.now()`, a different clock: never compare the two.
- **`data`** is whatever the producer attaches, or nothing. For a tracker's `onFound` and `onLost`, it is
  `{ index, name }`, the marker that changed. With several firings in one frame, it is the last one's.

**Before the first firing,** an event is a real object, `{ count: 0, time: 0 }`, not `undefined`. An input
can still be `undefined`: it is unwired, or Select Marker has no such marker.

**A new object is not always a firing.** Each firing is a new object, but changing Select Marker's `marker`
while the graph runs hands over the other marker's event, a different object with its own `count` and
`time`. The other marker may have fired later than this one, or exactly once more, so comparing `count` or
`time` with the last event seen fires falsely. What tells them apart is that a real firing happened after
your node last looked.

**Several firings can arrive in one frame.** A tracker that finds two markers fires its `onFound` twice in one
result, and `count` jumps by 2. If your node counts firings, use the difference in `count`. The logic nodes
react once per frame, however many there were: a Toggle flips once.

### Consuming an event

Look once at init, whose value is the baseline, and once every frame, even in a frame where you do not
need the answer. A plugin cannot import the studio's code, so it keeps its own copy of this:

```ts
import type { EventValue, NodeFactory } from '@webarkit/studio-plugin-api';

/** Did this input fire since the last call? The first call is the baseline. */
function eventWatcher() {
  let seen: unknown;
  let lastLook: number | null = null;
  return (value: unknown): boolean => {
    const since = lastLook;
    const previous = seen;
    lastLook = Date.now();
    seen = value;
    const event = value as EventValue | null | undefined;
    return since !== null && value !== previous && typeof event?.count === 'number' && event.count > 0 && event.time >= since;
  };
}

const myNode: NodeFactory = () => {
  const trigger = eventWatcher();
  return {
    init: (inputs) => void trigger(inputs.trigger),
    update(inputs) {
      if (trigger(inputs.trigger)) {
        const { data } = inputs.trigger as EventValue;
        // ... react to it, once
      }
    },
  };
};
```

So the value seen at init does not fire, whatever its `count`, and neither do `count: 0` or `undefined`.
Nodes run in topological order, so a chain of nodes reacts within one frame.

The marker switch does not fire either, with one limit: if the other marker fired since your node last
looked, or in that same millisecond, about one frame's time, the switch counts as that firing. A clock
stepped backwards can likewise lose a firing, for about one frame.

This is about events. A boolean such as Select Marker's `found` does change with the switch, when the two
markers differ, so an Edge on it fires.

### Producing an event

Start from `{ count: 0, time: 0 }`, and output a new object for each firing:

```ts
const fire = (previous: EventValue, data?: unknown): EventValue => ({ count: previous.count + 1, time: Date.now(), data });
```

**Stamp `time` with `Date.now()` on the main thread, when the object becomes visible to the graph,** not when
something happened in a worker. Consumers rely on this: an event stamped before their last look does not
fire. Between firings, keep outputting the same object.

## Imports

Plugin code imports only:

- the plugin API, **as types** (`import type … from '@webarkit/studio-plugin-api'`): it has no
  runtime code, so nothing of the studio ends up in the plugin's bundle;
- its own files;
- npm packages.

It never imports from the studio's `src/`. Where the API needs a constant, it exports it as a
literal type, and the plugin writes the value: the compiler checks they match (the trace format's
`format` and `version`, `VirtualAssetOrigin`). `tests/unit/jsartoolkit-nft-plugin.test.ts` checks
these rules for the jsartoolkitNFT plugin.

## The types package

The plugin API's types are the package
[`@webarkit/studio-plugin-api`](../packages/studio-plugin-api/) (`packages/studio-plugin-api/`). It
holds one `index.d.ts`, generated from `src/plugin-api/index.ts` when the package is packed, and needs
nothing else: no dependency, and none of the studio.

It is **not published yet**, because the API is still gaining optional fields. A plugin outside this
repository installs a tarball:

```bash
# In this repository, after npm install: writes webarkit-studio-plugin-api-1.3.0.tgz into the plugin's folder.
npm pack -w @webarkit/studio-plugin-api --pack-destination ../my-plugin
# In the plugin:
npm install -D ./webarkit-studio-plugin-api-1.3.0.tgz
```

`npm pack` generates the types first, so it needs scripts enabled: with `--ignore-scripts` it packs
without them, or with old ones.

Its imports are the same as inside this repository. A plugin's `tsconfig.json` needs `DOM` in `lib`,
since some values are DOM types (`VideoValue`, `RuntimeContext`). Without it, `skipLibCheck: true`
hides the errors and those types silently become `any`.

Plugins inside this repository keep the `tsconfig.json` `paths` alias, which reads
`src/plugin-api/index.ts` directly, so typechecking needs no build first.

**Versions.** The package's major version is `PLUGIN_API_VERSION`, the `apiVersion` a plugin's manifest
states: a breaking change, such as a change to a shared socket type, bumps both. An addition (a new
optional field, a new core socket type) bumps the minor version.

The package is `private`, so `npm publish` refuses it until that is decided.

## Workers and assets

- **Track in a Web Worker**, started with `new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' })`,
  or use the library's own worker (as the jsartoolkitNFT plugin does, see below). Keep heavy builds
  (WASM) behind a dynamic `import()` inside the worker.
- **Asset params**: a `string` param with `asset: 'file' | 'model'`, or a kind a plugin declares (see
  "Asset kinds"), gets uploads and is bundled by the exporter. The runtime resolves uploads before the
  factory runs: files become blob: URLs; the prefixes of declared kinds become virtual URLs under
  `VirtualAssetOrigin`, whose files are in `RuntimeContext.virtualFiles` (virtual URL → blob: URL). A worker that loads them must serve them
  to its library's `fetch()`, and answer 404 for other virtual URLs. A library that runs its own
  worker cannot be handed that map: `plugins/jsartoolkit-nft/virtual-fetch.ts` puts the files in the
  dataset URL's query string and installs a `fetch()` in the library's worker that reads them back.
- **A library's own worker files** that it starts by name from a folder (as `createNFTTrackerWorker`
  does) cannot go through the bundler: serve them from a fixed folder next to the page with a Vite
  plugin listed in `vite.config.ts` (`plugins/jsartoolkit-nft/vite.ts`), and copy them into exported
  apps with `kind: 'file'` export files.
- **Resolve relative URLs** against `RuntimeContext.baseUrl`: workers resolve them against their own location.
- **Traces**: a tracker that outputs `trackingTrace` writes the studio's trace format
  (`TraceHeader`, `TraceRecord`, see `src/runtime/trackers/trace.ts`), so the Trace Recorder and
  `npm run trace:diff` work with it.

## Asset kinds

A library's data that is several files sharing a base name gets an asset kind of its own, declared
in `assetKinds` and named by its params' `asset`:

```ts
assetKinds: [
  { id: 'acmeMarker', label: 'Acme marker', extensions: ['mk1', 'mk2'], alternative: 'pack' },
],
```

A param of this kind holds a URL prefix. From the declaration, the studio:

- classifies uploads by `extensions`, groups the files with the same base name into one asset, and
  refuses an incomplete one (`Acme marker "logo" is incomplete: add logo.mk2`);
- offers the extensions in the upload picker, and uploads of this kind on the param;
- checks that a project file holds each file of such an asset;
- gives the runtime a virtual prefix for an upload (see "Workers and assets");
- bundles each file into an exported app. When a URL's files are not all there, the exporter looks
  for `<url>.<alternative>`, if the kind has one, and fails with the kind's label if not.

`id` is a plain identifier, and it has no `<plugin id>.` prefix: it is stored in project files and in
the browser, so renaming it breaks them. A kind whose id or extensions are already taken is refused
(`model` owns `glb` and `gltf`), so claim only extensions that are your library's own: `file` has no
list, and a kind that claimed `jpg` would take over every image upload.

A plugin declares every kind it uses. The player loads only the plugins a graph lists, so it cannot
rely on another plugin's. Two plugins that read the same files declare the same kind, identically:
that is allowed, in either load order, and any other difference is refused.

A kind's value is always a URL prefix, even with one extension. For one plain file, use `file`.

## Export files

The standalone app export follows the player build's chunk graph. It cannot follow workers (they
are referenced by URL), and it leaves out on-demand chunks a graph does not need, so a plugin
declares them in `exportFiles`:

```ts
exportFiles: [
  // The plugin's own chunk: left out of apps whose graph does not use the plugin.
  { kind: 'module', module: 'plugins/acme/index.ts' },
  // A worker entry.
  { kind: 'worker', module: 'plugins/acme/acme.worker.ts' },
  // An on-demand build, only for the graphs that use it.
  { kind: 'module', module: 'acme-lib/dist/acme_simd.js', needed: (nodes) => nodes.some((n) => n.params.build === 'simd') },
  // A static file, copied into the bundle.
  { kind: 'file', from: 'data/acme/model.bin', to: 'data/acme/model.bin' },
],
```

`module` is a source path as the player build records it, matched by its end. `needed` receives
the graph's nodes of this plugin; without it, a file is needed whenever the graph uses the plugin.
The player build's manifest keeps every module under `src/` and `plugins/`, and the entry module of
every chunk (what a dynamic `import()` or a worker loads), so a package's on-demand build or a
plugin installed from npm is found by its entry. The export fails, naming the plugin and the
module, when a needed `module` or `worker` is not in the build.

### Cross-origin isolation

SharedArrayBuffer, and so WASM threads, needs a cross-origin isolated page: one served with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. An export
file cannot change the page, so a plugin that needs isolation says so instead:

```ts
crossOriginIsolation: (nodes) => nodes.some((n) => n.type === 'acme.tracker' && n.params.threads === true),
```

It receives the graph's nodes of this plugin, and is asked only when the graph uses the plugin. When
one plugin says yes, the export adds to the app (`src/export/cross-origin-isolation.ts`):

- `coi-sw.js`, a service worker that adds the two headers to what the app loads, its workers
  included, and its registration as the first script of `index.html`. On a page that is not
  isolated, the page registers it and reloads once. It does nothing on a page that is isolated
  already, or where a service worker cannot run (no HTTPS);
- `_headers`, which sets the headers on Netlify and Cloudflare Pages;
- a section of `README.txt` on both.

The studio's own page is never isolated: `require-corp` would block a model or an image loaded from
another origin without CORP. So in the studio's preview, a node that needs isolation must say so
itself (read `globalThis.crossOriginIsolated` in `init`), rather than wait for a worker that cannot
start. The jsartoolkitNFT plugin does this for its Threaded build.

## Testing with the Node build

Keep the tracking logic in a class that depends only on the tracking library and plain values (for
jsartoolkitNFT, `NftSession`), so the browser and the Node tests share it:

- unit tests (`tests/unit/`) for the factories' logic and the mapping onto the library;
- integration tests (`tests/integration/`) with the library's Node build, on the fixture photo
  (`npm run assets`), as `tests/integration/nft-session.test.ts` does;
- traces: record before and after a change with `npm run trace:record` and compare them with
  `npm run trace:diff` (see `AGENTS.md`, "Tracking traces").

The test setup (`tests/setup/plugins.ts`) installs every plugin of `webarkit-studio.config.ts`, so
tests see the same catalog as the studio.

## Running a tracker in Node

The MCP server's `tracking_run` (#8) runs a graph's tracker node in Node, on still images. A tracker
node's factory needs a browser (a canvas, a worker), so the plugin provides a `HeadlessTracker`
(`src/plugin-api`) for it: the input ports the frames replace, the processing frame for a video
size, and `run()`, which gets the node's other input values (evaluated from the graph by the
registry's factories), its params and the frames already placed in the processing frame, and returns
trace records. It runs the same session class as the worker (jsartoolkitNFT:
[`plugins/jsartoolkit-nft/headless.ts`](../plugins/jsartoolkit-nft/headless.ts)).

List it in [`webarkit-studio.node.config.ts`](../webarkit-studio.node.config.ts), under the plugin's id,
never in the manifest: it imports the library's Node build, which the studio's bundles must not
contain.

## Rating a dataset in Node

The MCP server's `trackability_check` (#44) rates a dataset from its files. A plugin provides this
with a `DatasetCheck` (`src/plugin-api`), which is optional: `check()` takes a path and the root
that a relative path resolves against, and returns the dataset's name, a verdict and the plugin's
own measures, all JSON-safe. List it under `datasetChecks` in
[`webarkit-studio.node.config.ts`](../webarkit-studio.node.config.ts), under the plugin's id, never in
the manifest (jsartoolkitNFT:
[`plugins/jsartoolkit-nft/trackability-files.ts`](../plugins/jsartoolkit-nft/trackability-files.ts)).
The tool expects one such plugin for now, and fails with a clear message if several provide a check.
