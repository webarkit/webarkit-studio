/**
 * The names an export gives a graph: its files' (slugify) and its page's title (graphTitle). No imports: the
 * player sets its page's title with graphTitle (#120), and must not pull in the exporters.
 */

/** The graph's name as a file name: ASCII, lower case, words joined by dashes; `webar-app` when nothing is left. */
export function slugify(name: string | undefined): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'webar-app';
}

/**
 * The exported page's title and its README's heading (#120): the graph's name on one line, without `<>&"`, its
 * runs of spaces as one, trimmed; `WebAR app` when nothing is left (no name, an empty or a blank one).
 */
export function graphTitle(name: string | undefined): string {
  return (name ?? '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim() || 'WebAR app';
}
