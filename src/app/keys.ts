/** Keyboard moves shared by the toolbar's menus and the tab bar (#190). */

export type Orientation = 'horizontal' | 'vertical';

/**
 * The index an arrow, Home or End moves the focus to among `count` items, from `current` (-1 when none of them has
 * the focus). The arrows of `orientation` move to the next or the previous item, wrapping; Home and End go to the ends.
 * Null for any other key, or with no items. The caller ignores keys pressed with Alt, Ctrl or Meta.
 */
export function rovingIndex(current: number, key: string, count: number, orientation: Orientation): number | null {
  if (count <= 0) return null;
  const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const previous = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  switch (key) {
    case next:
      return current < 0 ? 0 : (current + 1) % count;
    case previous:
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
