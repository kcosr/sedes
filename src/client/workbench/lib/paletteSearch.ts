type SearchableItem = {
  label: string;
  keywords?: readonly string[] | undefined;
};

const normalize = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, " ");

/** Every word must match a label or explicit keyword; metadata is never searched implicitly. */
export function paletteMatchScore(item: SearchableItem, query: string): number {
  const q = normalize(query);
  if (!q) return 1;
  const label = normalize(item.label);
  const fields = [label, ...(item.keywords ?? []).map(normalize)];
  const terms = q.split(" ");
  if (!terms.every((term) => fields.some((field) => field.includes(term))))
    return 0;
  if (label === q) return 5;
  if (label.startsWith(q)) return 4;
  if (label.includes(q)) return 3;
  if (terms.every((term) => label.includes(term))) return 2;
  return 1;
}

/** Stable ties retain source order; callers' arrays are never changed. */
export function filterPaletteItems<T extends SearchableItem>(
  items: readonly T[],
  query: string,
): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      score: paletteMatchScore(item, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

/** Highlight query words literally, preserving original spelling and punctuation. */
export function paletteHighlight(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let offset = 0;
  for (const found of text.matchAll(new RegExp(terms.join("|"), "giu"))) {
    if (found.index > offset)
      parts.push({ text: text.slice(offset, found.index), match: false });
    parts.push({ text: found[0], match: true });
    offset = found.index + found[0].length;
  }
  if (offset < text.length)
    parts.push({ text: text.slice(offset), match: false });
  return parts;
}
