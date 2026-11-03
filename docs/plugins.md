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
  exportFiles: [/* see below */],
};
export default plugin;
```

When the plugin is installed, the studio checks it (`validatePlugin`, `src/core/plugins.ts`)
and refuses it with the list of problems if:

- `id` is not a plain identifier (letters and digits), is one of the built-in namespaces
  (`source`, `tracking`, `filter`, `three`, `babylon`, `scene`, `output`, `math`, `debug`), is
  `webarkit` (reserved for webarkit/webarkit), or is already loaded (jsartoolkitNFT is taken by the
  bundled plugin);
- `version` is not `x.y.z`, or `apiVersion` is not the studio's `PLUGIN_API_VERSION`;
- a node type or socket id does not start with `<id>.`, or is defined twice;
- a node has no factory, or a factory has no node;
- a port uses a socket type that is neither a core socket nor one of the plugin's.

Node definitions and factories follow the same rules as the built-in nodes (`AGENTS.md`,
"Adding a node"): the definitions are metadata only, factories implement `init`, `update`,
`onParamChange` for `live` params and `dispose`.

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

## The sockets contract

The core socket types (`CORE_SOCKET_TYPES` in `src/core/sockets.ts`) and the values they carry
(`src/plugin-api`: `VideoValue`, `TrackingResultValue` / `TrackedMarkerValue`, `ProjectionValue`,
`MarkerInfoValue`, `PoseFilterValue`, `EventValue`, `TrackingStatsValue`, `TrackingTraceValue`, …)
are the contract between plugins. Changing one is a breaking change of the plugin API, which bumps
`PLUGIN_API_VERSION`.

A tracker plugin that outputs `trackingResult`, `projection`, `onFound` / `onLost` and `stats`
works with Select Marker, Marker Anchor, AR Camera, the filters, Inspector and Stats unchanged.
Data only its own nodes exchange (calibration files, marker descriptions, settings) gets a socket
of its own, `<id>.<name>`, so it cannot be wired into another tracker.

Two connections are possible only between equal socket types (or into `any`). Units and spaces
are the studio's: marker space in millimetres, marker on the XY plane with +Z up, column-major
matrices, the camera looking down −Z.

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

## Workers and assets

- **Track in a Web Worker**, started with `new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' })`,
  or use the library's own worker (as the jsartoolkitNFT plugin does, see below). Keep heavy builds
  (WASM) behind a dynamic `import()` inside the worker.
- **Asset params**: a `string` param with `asset: 'file' | 'nftDataset' | 'model'` gets uploads and
  is bundled by the exporter. The runtime resolves uploads before the factory runs: files become
  blob: URLs; NFT dataset prefixes become virtual URLs under `VirtualAssetOrigin`, whose files are in
  `RuntimeContext.virtualFiles` (virtual URL → blob: URL). A worker that loads them must serve them
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
