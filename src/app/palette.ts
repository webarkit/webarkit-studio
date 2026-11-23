/**
 * The palette (#180): one `<details>` per category, in `CATEGORY_ORDER`, after the Macros group the macro library
 * fills. Which groups are open is remembered in this browser; only a user's click changes it. A search opens the
 * groups with a match and hides the others for the view only, and clearing it gives the remembered state back.
 * The category bar above the list jumps to a group.
 */
import type { NodeDefinition } from '../nodes/catalog';
import { addable, CATEGORY_ORDER, searchNodes } from '../editor/node-search';

export const PALETTE_GROUPS_KEY = 'webarkit-studio:palette-groups';

/** The stored open / closed state: own keys with a boolean value only; anything else is an empty state (the default). */
export function readGroupState(raw: string | null): Map<string, boolean> {
  const state = new Map<string, boolean>();
  if (raw === null) return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return state;
  // JSON.parse makes a "__proto__" key an own property, and Object.entries reads it as data.
  for (const [key, value] of Object.entries(parsed)) if (typeof value === 'boolean') state.set(key, value);
  return state;
}

/**
 * Object.fromEntries defines its keys, so "__proto__" is written as data too. With `keep`, only those keys are
 * written: a stored key no group has (a removed plugin's category) is not carried on.
 */
export function writeGroupState(state: Map<string, boolean>, keep?: ReadonlySet<string>): string {
  return JSON.stringify(Object.fromEntries([...state].filter(([key]) => !keep || keep.has(key))));
}

/** Math is the longest group: it starts closed. */
export function groupOpenByDefault(key: string): boolean {
  return key !== 'math';
}

export interface PaletteElements {
  search: HTMLInputElement;
  bar: HTMLElement;
  list: HTMLElement;
}

export interface PaletteUi {
  /** The Macros group, with its summary and an empty body, for the macro library to fill. */
  macroGroup: HTMLDetailsElement;
  /** The macro library's filter, run on each search before the groups' open state is applied. */
  attachMacros(filter: (query: string) => void): void;
  /** Disables the bar buttons of hidden groups: the macro library hides its group on its own, after an import too. */
  refresh(): void;
}

export function mountPalette(els: PaletteElements, defs: NodeDefinition[], addNode: (type: string) => void): PaletteUi {
  const { search, bar, list } = els;
  let state = new Map<string, boolean>();
  try {
    state = readGroupState(localStorage.getItem(PALETTE_GROUPS_KEY));
  } catch {
    // Storage blocked: the default state.
  }
  const save = () => {
    try {
      localStorage.setItem(PALETTE_GROUPS_KEY, writeGroupState(state, new Set(groups.keys())));
    } catch {
      // A view preference: the state in memory still applies until reload.
    }
  };
  const remembered = (key: string) => state.get(key) ?? groupOpenByDefault(key);
  const searching = () => search.value.trim() !== '';

  const groups = new Map<string, HTMLDetailsElement>();
  const barButtons = new Map<string, HTMLButtonElement>();
  const makeGroup = (key: string, title: string, count?: number) => {
    const details = document.createElement('details');
    details.className = 'palette-group';
    details.dataset.group = key;
    const summary = document.createElement('summary');
    const heading = document.createElement('h3');
    heading.textContent = title;
    summary.append(heading);
    if (count !== undefined) {
      const small = document.createElement('span');
      small.className = 'palette-count';
      small.textContent = `(${count})`;
      summary.append(small);
    }
    details.append(summary);
    details.open = remembered(key);
    // Only a click saves (mouse, or Enter / Space): a search's own toggle events arrive later, maybe after it is cleared.
    summary.addEventListener('click', () => {
      if (searching()) return;
      state.set(key, !details.open);
      save();
    });
    groups.set(key, details);
    list.append(details);
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = title;
    jump.dataset.group = key;
    jump.onclick = () => {
      details.open = true;
      if (!searching()) {
        state.set(key, true);
        save();
      }
      // Not scrollIntoView: the sticky summary of a group above the view sits at the bottom of its <details>.
      list.scrollTop += details.getBoundingClientRect().top - list.getBoundingClientRect().top;
    };
    barButtons.set(key, jump);
    bar.append(jump);
    return details;
  };

  const macroGroup = makeGroup('macros', 'Macros');
  const buttons = new Map<string, HTMLButtonElement>();
  for (const category of CATEGORY_ORDER) {
    const inGroup = defs.filter((d) => d.category === category && addable(d));
    if (!inGroup.length) continue;
    const details = makeGroup(category, category, inGroup.length);
    for (const def of inGroup) {
      const btn = document.createElement('button');
      btn.innerHTML = `${def.label}${def.provider !== 'core' ? `<small>${def.provider}</small>` : ''}`;
      btn.title = def.description;
      btn.className = `cat-${category}`;
      btn.onclick = () => addNode(def.type);
      details.appendChild(btn);
      buttons.set(def.type, btn);
    }
  }

  // Room after the last group, so that its heading too can be scrolled to the top (layoutTail()).
  const tail = document.createElement('div');
  tail.className = 'palette-tail';
  list.append(tail);

  const refresh = () => {
    for (const [key, jump] of barButtons) jump.disabled = Boolean(groups.get(key)!.hidden);
  };

  let macroFilter: ((query: string) => void) | undefined;
  // Filter: same ranking as the context menu search; groups with no match are hidden.
  search.oninput = () => {
    const shown = new Set(searchNodes(search.value, defs).map((d) => d.type));
    for (const [type, btn] of buttons) btn.hidden = !shown.has(type);
    for (const [key, details] of groups) {
      if (key !== 'macros') details.hidden = !details.querySelector(':scope > button:not([hidden])');
    }
    macroFilter?.(search.value);
    const query = searching();
    // The Macros group stays open during a search: the library hides or shows it on its own, after an import too.
    for (const [key, details] of groups) details.open = query ? key === 'macros' || !details.hidden : remembered(key);
    refresh();
  };

  // Wrapped up to three lines; beyond that, one row that scrolls. Measured, since plugins and the column's width change it.
  const layoutBar = () => {
    bar.classList.remove('scroll');
    const lines = new Set([...barButtons.values()].map((b) => b.offsetTop)).size;
    bar.classList.toggle('scroll', lines > 3);
  };
  // The palette's height minus one heading: enough for any heading to reach the top, sized from the palette itself.
  const layoutTail = () => {
    const heading = Math.max(0, ...[...groups.values()].map((d) => d.querySelector<HTMLElement>(':scope > summary')!.offsetHeight));
    tail.style.height = `${Math.max(0, list.clientHeight - heading)}px`;
  };
  const layout = () => {
    layoutBar();
    layoutTail();
  };
  layout();
  // The column (a narrower layout) and the list itself (the assets panel below it grows) change the sizes.
  const resized = new ResizeObserver(layout);
  resized.observe(list.parentElement ?? list);
  resized.observe(list);

  return {
    macroGroup,
    attachMacros(filter) {
      macroFilter = filter;
    },
    refresh,
  };
}
