export const minimumSearchQueryCharacters = 3;

/** Whether a query contains enough Unicode non-whitespace characters to search. */
export function isSearchQueryReady(query: string): boolean {
  let count = 0;
  for (const character of query) {
    if (/\S/u.test(character) && ++count >= minimumSearchQueryCharacters) {
      return true;
    }
  }
  return false;
}
