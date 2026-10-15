/**
 * Studio shell: palette + Rete editor + live preview (GraphRuntime).
 */
import { createStudioEditor } from '../editor/editor';
import { NODE_CATALOG, type NodeCategory } from '../nodes/catalog';
import { GraphRuntime, NodeRuntimeError } from '../runtime/runtime';
import { emptyGraph, validateGraph, type GraphDocument } from '../core/graph';
import { HANDOFF_KEY } from './handoff';
import { EXPORTERS } from '../export/exporters';

const AUTOSAVE_KEY = 'webarkit-studio:autosave';
/** Autosave key used while the project was called WebAR-Studio, read once as a fallback. */
const LEGACY_AUTOSAVE_KEY = 'webar-studio:autosave';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const logEl = $<HTMLPreElement>('log');
const log = (msg: string) => {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

const studio = await createStudioEditor($('editor'), {
  onChange() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(studio.toDocument()));
    } catch {
      /* autosave is best effort */
    }
  },
  // While the preview runs, live params reach the running node immediately.
  onParamChange(nodeId, key, value) {
    if (runtime?.setParam(nodeId, key, value) === 'restart') log(`⟳ ${nodeId}.${key} changed: press Reload to apply it`);
  },
});

// ---------------------------------------------------------------- palette
const CATEGORY_ORDER: NodeCategory[] = ['source', 'tracking', 'filter', 'renderer', 'scene', 'output', 'debug'];
const palette = $('palette');
for (const category of CATEGORY_ORDER) {
  const defs = Object.values(NODE_CATALOG).filter((d) => d.category === category);
  if (!defs.length) continue;
  const group = document.createElement('div');
  group.className = 'palette-group';
  group.innerHTML = `<h3>${category}</h3>`;
  for (const def of defs) {
    const btn = document.createElement('button');
    btn.innerHTML = `${def.label}${def.provider !== 'core' ? `<small>${def.provider}</small>` : ''}`;
    btn.title = def.description;
    btn.className = `cat-${category}`;
    btn.onclick = () => void studio.addNode(def.type);
    group.appendChild(btn);
  }
  palette.appendChild(group);
}

// ----------------------------------------------------------- graph I/O
async function load(doc: unknown): Promise<boolean> {
  try {
    await studio.load(validateGraph(doc));
    await studio.zoomToFit();
    return true;
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    return false;
  }
}

async function loadDemo(name = demoSelect.value) {
  const res = await fetch(`graphs/${name}.json`);
  await load(await res.json());
}

const demoSelect = $<HTMLSelectElement>('demo-select');
$('btn-demo').onclick = () => void loadDemo();
$('btn-new').onclick = () => {
  // An empty graph is not runnable, so it is loaded without validation.
  void studio.load(emptyGraph());
};
// ---------------------------------------------------------------- export
const exportMenu = $<HTMLDetailsElement>('export-menu');
const exportItems = $('export-items');
for (const exporter of EXPORTERS) {
  const item = document.createElement('button');
  item.innerHTML = `<strong>${exporter.label}</strong><small>${exporter.description}</small>`;
  item.disabled = !exporter.available;
  item.dataset.exporter = exporter.id;
  item.onclick = async () => {
    exportMenu.open = false;
    log(`⇩ export: ${exporter.label}`);
    try {
      const { filename, blob } = await exporter.run(studio.toDocument(), { baseUrl: document.baseURI, log });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      log(`✗ export failed: ${(err as Error).message}`);
    }
  };
  exportItems.appendChild(item);
}
document.addEventListener('click', (e) => {
  if (!exportMenu.contains(e.target as Node)) exportMenu.open = false;
});
const fileInput = $<HTMLInputElement>('file-import');
$('btn-import').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (file) await load(JSON.parse(await file.text()));
  fileInput.value = '';
};
$('btn-player').onclick = () => {
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(studio.toDocument()));
    window.open('player.html?source=studio', '_blank');
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
  }
};

// ------------------------------------------------------------- preview
let runtime: GraphRuntime | null = null;
const stage = $('stage');
const runBtn = $<HTMLButtonElement>('btn-run');
const stopBtn = $<HTMLButtonElement>('btn-stop');
const reloadBtn = $<HTMLButtonElement>('btn-reload');

function stop(keepStatuses = false) {
  runtime?.stop();
  runtime = null;
  if (!keepStatuses) studio.clearStatuses();
  stage.innerHTML = '<p class="hint">Press ▶ Run to preview the graph.</p>';
  runBtn.disabled = false;
  stopBtn.disabled = true;
  reloadBtn.disabled = true;
}

/** Incremented by every run: a start still in progress when Reload / Stop is pressed is discarded. */
let runId = 0;

async function run(reason = 'run') {
  const id = ++runId;
  stop();
  studio.clearStatuses();
  stage.innerHTML = '';
  logEl.textContent = reason === 'reload' ? '⟳ reload\n' : '';
  runBtn.disabled = true;
  stopBtn.disabled = false;
  reloadBtn.disabled = false;
  try {
    runtime = new GraphRuntime(studio.toDocument(), {
      stage,
      log,
      onReport: (nodeId, text) => studio.setNodeStatus(nodeId, { text }),
    });
    await runtime.start();
    if (id !== runId) return; // superseded while starting
    log('✓ running');
  } catch (err) {
    if (id !== runId) return;
    log(`✗ ${(err as Error).message}`);
    // Point at the node that failed.
    if (err instanceof NodeRuntimeError) studio.setNodeStatus(err.nodeId, { text: (err as Error).message, error: true });
    stop(true);
  }
}
runBtn.onclick = () => void run();
// Reload = Stop + Run: restarts camera, tracker and renderer with the current graph.
reloadBtn.onclick = () => void run('reload');
stopBtn.onclick = () => {
  runId++;
  stop();
};

// ------------------------------------------------------------- startup
let restored: GraphDocument | null = null;
try {
  const raw = localStorage.getItem(AUTOSAVE_KEY) ?? localStorage.getItem(LEGACY_AUTOSAVE_KEY);
  restored = raw ? (JSON.parse(raw) as GraphDocument) : null;
} catch {
  restored = null;
}
// An autosave from an older graph version fails validation: fall back to the demo.
if (!(restored?.nodes.length && (await load(restored)))) await loadDemo();
