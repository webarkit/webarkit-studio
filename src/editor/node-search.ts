/**
 * Catalog search for the palette and the context menu: every word of the
 * query must match a node (label, type, category, provider or description);
 * matches in the label rank above matches in the type, the category or
 * provider, then the description. Among label matches, the word covering
 * more of a shorter label wins ("cam" → Camera before Camera Params).
 */
import type { NodeCategory, NodeDefinition } from '../nodes/catalog';

export const CATEGORY_ORDER: NodeCategory[] = ['source', 'tracking', 'filter', 'renderer', 'scene', 'output', 'math', 'color', 'logic', 'action', 'debug'];

/** Lower-case words, split on punctuation and camelCase ("ARControllerNFT" → ar, controller, nft). */
const words = (text: string) =>
  text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s.\-_/()]+/)
    .filter(Boolean);

/** Score of one query word against a node; 0 = no match. */
function scoreWord(word: string, def: NodeDefinition): number {
  const label = def.label.toLowerCase();
  const type = def.type.toLowerCase();
  if (words(def.label).some((w) => w.startsWith(word))) return 100 + (10 * word.length) / label.length;
  if (words(def.type).some((w) => w.startsWith(word))) return 60;
  if (label.includes(word)) return 50;
  if (def.category.startsWith(word) || def.provider.toLowerCase().startsWith(word)) return 40;
  if (type.includes(word)) return 30;
  if (def.description.toLowerCase().includes(word)) return 10;
  return 0;
}

const byCategory = (a: NodeDefinition, b: NodeDefinition) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);

/** Nodes matching `query`, best first; ties (and an empty query) keep the category, then the catalog order. */
export function searchNodes(query: string, defs: NodeDefinition[]): NodeDefinition[] {
  const terms = words(query);
  const ordered = [...defs].sort(byCategory);
  if (!terms.length) return ordered;
  const scored: Array<{ def: NodeDefinition; score: number }> = [];
  for (const def of ordered) {
    let score = 0;
    for (const term of terms) {
      const s = scoreWord(term, def);
      if (!s) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score) scored.push({ def, score });
  }
  // Array.prototype.sort is stable: equal scores keep the category order.
  return scored.sort((a, b) => b.score - a.score).map((s) => s.def);
}
