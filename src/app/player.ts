/**
 * Standalone player: runs a graph JSON with no editor code at all
 * (check the build output: this entry does not bundle Rete.js).
 *
 * Graph source, in order of precedence:
 *   player.html?source=studio                    graph handed over by the studio
 *   player.html?graph=graphs/pinball-three.json   any graph URL
 *   <meta name="webarkit-studio-graph" content="graph.json">  set by "Export → Standalone app"
 *   graphs/pinball-three.json                     default demo
 */
import { GraphRuntime } from '../runtime/runtime';
import { GRAPH_META, HANDOFF_KEY } from './handoff';

async function loadGraph(): Promise<unknown> {
  const params = new URLSearchParams(location.search);
  if (params.get('source') === 'studio') {
    try {
      const raw = localStorage.getItem(HANDOFF_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* storage unavailable: fall through to the URL */
    }
  }
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${GRAPH_META}"]`)?.content;
  const url = params.get('graph') ?? meta ?? 'graphs/pinball-three.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cannot load ${url}: HTTP ${res.status}`);
  return res.json();
}

const stage = document.getElementById('stage')!;
const startButton = document.getElementById('start') as HTMLButtonElement;
const errorBox = document.getElementById('error')!;

// Camera access needs a user gesture on most mobile browsers, hence the button.
startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    const graph = await loadGraph();
    const name = (graph as { name?: unknown }).name;
    if (typeof name === 'string' && name) document.title = name;
    const runtime = new GraphRuntime(graph, { stage });
    await runtime.start();
    startButton.remove();
  } catch (err) {
    errorBox.style.display = 'block';
    errorBox.textContent = (err as Error).message;
    startButton.disabled = false;
  }
});
