// Response shaping only — takes already-fetched data, issues no queries of its own.
export function serializeOrder(order) {
  return { id: order.id, itemCount: order.items?.length ?? 0 };
}
