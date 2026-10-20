import type {
  ConversationItem,
  ConversationTurn,
} from "../../../shared/index.js";

type ItemsById = Readonly<Record<string, ConversationItem>>;

/**
 * Whether a turn's listed items are identical in two item maps. The thread
 * store keeps untouched turns and items identical, so an unchanged turn
 * proves its presentation unchanged without rereading any content.
 */
export function sameTurnItems(
  turn: ConversationTurn,
  previous: ItemsById,
  next: ItemsById,
): boolean {
  return (
    previous === next ||
    turn.orderedItemIds.every((itemId) => previous[itemId] === next[itemId])
  );
}

/**
 * Memoizes a value derived from one turn and its items. It is recomputed only
 * when the turn or one of the items it lists changes, so a streaming flush
 * recomputes only the live turn.
 */
export function derivedPerTurn<T>(
  derive: (turn: ConversationTurn, itemsById: ItemsById) => T,
): (turn: ConversationTurn, itemsById: ItemsById) => T {
  // Retains only the turn's own items, never a whole item map.
  const cache = new WeakMap<
    ConversationTurn,
    { readonly items: readonly (ConversationItem | undefined)[]; readonly value: T }
  >();
  return (turn, itemsById) => {
    const cached = cache.get(turn);
    if (
      cached &&
      turn.orderedItemIds.every(
        (itemId, index) => cached.items[index] === itemsById[itemId],
      )
    ) {
      return cached.value;
    }
    const value = derive(turn, itemsById);
    cache.set(turn, {
      items: turn.orderedItemIds.map((itemId) => itemsById[itemId]),
      value,
    });
    return value;
  };
}
