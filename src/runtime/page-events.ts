/**
 * Page events (#82): the rules for what crosses between a graph and the page that holds it, in both
 * directions (action.dispatchEvent, page.event). Pure functions, with no DOM.
 */

/**
 * An event name, trimmed, with a colon and text on both sides (`shop:coupon`): no built-in event of the
 * browser has one, so a graph can neither listen for `click` or `keydown` nor fake them.
 */
export function checkEventName(name: unknown): string {
  const value = String(name ?? '').trim();
  if (!/^[^\s:]+:\S*[^\s:]$/.test(value)) {
    throw new Error(`event name "${value}" must contain a colon, such as "shop:coupon": a graph cannot use the browser's own events`);
  }
  return value;
}

/** An origin for postMessage, exactly as `new URL(…).origin` writes it. `*` would let any page that frames the app take part. */
export function checkOrigin(origin: unknown): string {
  const value = String(origin ?? '').trim();
  if (value === '*') throw new Error('origin "*" is refused: name the page\'s origin, such as https://shop.example.com');
  if (!value) throw new Error('postMessage needs an origin, such as https://shop.example.com');
  let parsed: string | undefined;
  try {
    parsed = new URL(value).origin;
  } catch {
    parsed = undefined;
  }
  if (parsed !== value || parsed === 'null') {
    const hint = parsed && parsed !== 'null' ? `: write it as ${parsed}` : ': write it as https://shop.example.com';
    throw new Error(`"${value}" is not an origin${hint} (no path, lowercase, no default port)`);
  }
  return value;
}

/** How many arrays and objects may nest in a reduced value, the outer one included: deeper ones are dropped. */
export const MAX_DEPTH = 4;

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * The value reduced to plain data: strings, finite numbers, booleans, `null`, and arrays and plain
 * objects of those, to MAX_DEPTH levels. Anything else is dropped (undefined): no DOM node, function or
 * class instance crosses between the graph and the page. A dropped item is `null` in an array, so the
 * others keep their places, and absent in an object. A cycle is dropped where it closes. An own
 * `__proto__` key stays a key: the result is always a plain object of Object.prototype.
 */
export function plainValue(value: unknown, depth = 0, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth >= MAX_DEPTH || ancestors.has(value)) return undefined;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return undefined;
  ancestors.add(value);
  try {
    if (isArray) return value.map((item) => plainValue(item, depth + 1, ancestors) ?? null);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        continue; // a getter that throws
      }
      const reduced = plainValue(item, depth + 1, ancestors);
      // Defined, not assigned: an own "__proto__" key (JSON.parse makes one) would otherwise set the prototype.
      if (reduced !== undefined) Object.defineProperty(out, key, { value: reduced, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** The number a detail carries: itself when it is a finite number, or its finite `value`. */
export function detailNumber(detail: unknown): number | undefined {
  if (typeof detail === 'number') return Number.isFinite(detail) ? detail : undefined;
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    const { value } = detail as { value?: unknown };
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
