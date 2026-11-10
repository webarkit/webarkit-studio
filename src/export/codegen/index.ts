/**
 * Source code export (#64): a graph as a small Vite project, with one readable `src/main.js`.
 *
 * The walk is the runtime's order (topologicalOrder): each node's emitter writes its setup, top to bottom, and its
 * part of the frame loop, in that order. Emitters are keyed by target (`three` today, codegen/three.ts for the core
 * nodes, a plugin's `codeEmitters` for its own); the walk and the refusal of nodes without one know no target.
 * A node with no emitter is refused by name: dropping it would produce wrong code.
 */
import { resolveParams, topologicalOrder, type GraphDocument, type GraphNode } from '../../core/graph';
import { effectiveDefinition } from '../../core/script';
import { INSTALLED_PLUGINS } from '../../plugins/host';
import { THREE_EMITTERS } from './three';
import type { CodeEmitter, CodeEmitters, CodeTarget, EmittedNode } from './types';

export type { CodeEmitContext, CodeEmitter, CodeEmitters, CodeTarget, EmittedNode } from './types';

/** Why a graph cannot be written as source code; its message lists every node at fault. */
export class CodegenError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `This graph cannot be exported as source code yet:\n${problems.map((p) => `- ${p}`).join('\n')}\n` +
        'The first version writes the nodes of the "pinball · Three.js" demo. Export a Standalone app (.zip) instead: it runs every node.',
    );
    this.name = 'CodegenError';
  }
}

/** The core's emitters by target. */
const CORE_EMITTERS: CodeEmitters = { three: THREE_EMITTERS };

/** The core's emitters for `target`, and those of the installed plugins. */
export function codeEmittersFor(target: CodeTarget): Record<string, CodeEmitter> {
  const all: Record<string, CodeEmitter> = { ...CORE_EMITTERS[target] };
  for (const plugin of INSTALLED_PLUGINS.values()) Object.assign(all, plugin.codeEmitters?.[target]);
  return all;
}

/** Words a node's variable must not be: the language's, and the names the generated file uses itself. */
const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'import in instanceof let new null return super switch this throw true try typeof var void while with yield await async ' +
    'arguments eval implements interface package private protected public static undefined NaN Infinity ' +
    'stage frame last time delta ' +
    'document window navigator performance console Math JSON URL Array Number Object String Error Map Set Promise devicePixelRatio requestAnimationFrame'
  ).split(' '),
);

/** Variable names, unique in the file: one per node (allocated first, in order), then the ones derived from them. */
function namer(order: GraphNode[], reserved: ReadonlySet<string>) {
  const used = new Set<string>();
  const take = (wanted: string) => {
    let name = wanted;
    for (let i = 2; used.has(name) || RESERVED.has(name) || reserved.has(name); i++) name = `${wanted}_${i}`;
    used.add(name);
    return name;
  };
  const safe = (id: string) => {
    const name = id.replace(/[^A-Za-z0-9_$]/g, '_');
    return /^[0-9]/.test(name) ? `_${name}` : name || 'node';
  };
  const bases = new Map(order.map((n) => [n.id, take(safe(n.id))]));
  const derived = new Map<string, string>();
  return Object.assign((nodeId: string, suffix?: string) => {
    const base = bases.get(nodeId)!;
    if (!suffix) return base;
    const key = `${nodeId}\0${suffix}`;
    if (!derived.has(key)) derived.set(key, take(`${base}_${safe(suffix)}`));
    return derived.get(key)!;
  }, { used });
}

/** The names import lines bind (`* as X`, `{ a, b as c }`, a default). */
function importedNames(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const clause = /^import\s+(.+?)\s+from\s/.exec(line)?.[1] ?? '';
    return clause
      .replace(/[{}]/g, ',')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/).pop()!.replace(/^\*\s*/, '').trim())
      .filter(Boolean);
  });
}

/** A JavaScript literal: JSON, which is valid JavaScript for the values params hold. */
const literal = (value: unknown) => JSON.stringify(value) ?? 'undefined';

/** One line of comment text: no line breaks, and no `*\/` (a node id is free text). */
const commentText = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /');

const indent = (code: string, by: string) =>
  code
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');

export interface GeneratedSource {
  /** The project's text files, by path; the assets go in `public/` beside them. */
  files: Record<string, string>;
}

/**
 * Writes `doc` as a project for `target`. Throws a CodegenError listing every node it cannot write. The graph's
 * asset params are written as they are: the exporter rewrites them to the files it collects first.
 */
export function generateSource(
  doc: GraphDocument,
  target: CodeTarget,
  emitters: Record<string, CodeEmitter>,
  reserved: ReadonlySet<string> = new Set(),
): GeneratedSource {
  const order = topologicalOrder(doc);
  const missing = order.filter((n) => !emitters[n.type]).map((n) => `${n.id} (${n.type}): no ${target} source code for this node yet`);
  if (missing.length) throw new CodegenError(missing);

  const name = namer(order, reserved);
  const emitted = new Map<string, EmittedNode>();
  const problems: string[] = [];
  for (const node of order) {
    const def = effectiveDefinition(node)!;
    const linked = (port: string) => doc.edges.filter((e) => e.to.node === node.id && e.to.port === port);
    const value = (e: GraphDocument['edges'][number]) => {
      const out = emitted.get(e.from.node)?.outputs?.[e.from.port];
      if (out === undefined) throw new Error(`no value for ${e.from.node}.${e.from.port}`);
      return out;
    };
    try {
      const inputs: Record<string, string | string[] | undefined> = {};
      for (const [port, spec] of Object.entries(def.inputs)) {
        const edges = linked(port);
        if (edges.length) inputs[port] = spec.multiple ? edges.map(value) : value(edges[0]);
      }
      emitted.set(
        node.id,
        emitters[node.type]({
          node,
          params: resolveParams(def, node.params),
          inputs,
          from: (port) => {
            const edge = linked(port)[0];
            return edge && emitted.get(edge.from.node)?.outputs;
          },
          fromEach: (port) => linked(port).map((e) => ({ node: e.from.node, outputs: emitted.get(e.from.node)?.outputs ?? {} })),
          name: (suffix) => name(node.id, suffix),
          literal,
        }),
      );
    } catch (err) {
      problems.push(`${node.id} (${node.type}): ${(err as Error).message}`);
    }
  }
  if (problems.length) throw new CodegenError(problems);

  const parts = order.map((node) => ({ node, code: emitted.get(node.id)! }));
  const heading = (node: GraphNode) => `// ${commentText(node.id)} (${node.type})`;
  const imports = [...new Set(parts.flatMap((p) => p.code.imports ?? []))];
  // A node named like an import (a node "THREE"): written again with the imports' names kept for them.
  const clashes = importedNames(imports).filter((n) => name.used.has(n) && !reserved.has(n));
  if (clashes.length) return generateSource(doc, target, emitters, new Set([...reserved, ...clashes]));
  const setup = parts.map(({ node, code }) => [heading(node), code.setup?.trimEnd()].filter(Boolean).join('\n')).join('\n\n');
  const frame = parts
    .filter((p) => p.code.frame)
    .map(({ node, code }) => `${heading(node)}\n${code.frame!.trimEnd()}`)
    .join('\n\n');
  const title = doc.name || 'WebAR app';
  const main = [
    `// ${commentText(title)}`,
    '// Generated by WebARKit Studio from its node graph (Export → Source code, Three.js).',
    '// Each part below is one node of the graph, in the order the graph runs them: "// <node id> (<node type>)".',
    '',
    ...imports,
    '',
    "const stage = document.querySelector('#app');",
    '',
    '// ---------------------------------------------------------------- setup, once',
    '',
    setup,
    '',
    '// ---------------------------------------------------------------- every frame',
    '',
    'let last = null;',
    'function frame(time) {',
    '  const delta = last === null ? 0 : time - last; // milliseconds',
    '  last = time;',
    '',
    indent(frame, '  '),
    '',
    '  requestAnimationFrame(frame);',
    '}',
    'requestAnimationFrame(frame);',
    '',
  ].join('\n');

  return { files: projectFiles(doc, title, main, parts.map((p) => p.code)) };
}

/** The core part's dependencies: the versions the studio was built with (vite.config.ts defines them). */
declare const __CODEGEN_VERSIONS__: Record<string, string>;
const CORE_VERSIONS: Record<string, string> = typeof __CODEGEN_VERSIONS__ === 'undefined' ? {} : __CODEGEN_VERSIONS__;

function projectFiles(doc: GraphDocument, title: string, main: string, parts: EmittedNode[]): Record<string, string> {
  const slug = (doc.name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const dependencies: Record<string, string> = Object.assign({}, ...parts.map((p) => p.dependencies ?? {}));
  // The core's own: three.js, when a part imports it.
  if (parts.some((p) => p.imports?.some((line) => /from 'three(\/[^']*)?';$/.test(line)))) dependencies.three = CORE_VERSIONS.three;
  const prepare = [...new Set(parts.flatMap((p) => p.prepare ?? []))];
  const scripts: Record<string, string> = {
    ...(prepare.length && { predev: prepare.join(' && '), prebuild: prepare.join(' && ') }),
    dev: 'vite',
    build: 'vite build',
    preview: 'vite preview',
  };
  const pkg = {
    name: slug || 'webar-app',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts,
    dependencies: sortKeys(dependencies),
    devDependencies: { vite: CORE_VERSIONS.vite },
  };
  const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'vite.config.js': VITE_CONFIG,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; background: #000; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
`,
    'src/main.js': main,
    'README.md': readme(title, prepare),
  };
  for (const part of parts) Object.assign(files, part.files);
  return files;
}

const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs: the built app runs from any folder of a static server.
  base: './',
  // Unknown paths answer 404, not index.html: a tracker may probe for optional files and read any answer as one.
  appType: 'mpa',
  // src/main.js waits for the camera and the tracker at the top level.
  build: { target: 'es2022' },
});
`;

function readme(title: string, prepare: string[]): string {
  return `# ${title}

Generated by [WebARKit Studio](https://github.com/webarkit/webarkit-studio) from its node graph. It does not depend
on the studio: \`src/main.js\` is the whole app, one part per node of the graph, in the order the graph runs them.

\`\`\`bash
npm install
npm run dev
\`\`\`

\`npm run build\` writes the app into \`dist/\`, for any static web server.
${prepare.length ? `\nBefore \`dev\` and \`build\`, \`${prepare.join(' && ')}\` copies files the app needs from \`node_modules\` into \`public/\`.\n` : ''}
The camera needs a secure page: \`localhost\`, or HTTPS on another device (for example \`npm run dev -- --host\`
behind an HTTPS tunnel). The assets (camera parameters, tracking data, models) are in \`public/data/\`.
`;
}
