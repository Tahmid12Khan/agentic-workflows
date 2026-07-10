// Lists a user's orders with their line items, for the order-history page.
export async function listOrdersWithItems(db, userId) {
  const orders = await db.orders.findAll({ where: { userId } });
  for (const order of orders) {
    order.items = await db.orderItems.findAll({ where: { orderId: order.id } }); // 1 query per order
  }
  return orders;
}

export async function listOrdersWithItemsBatched(db, userId) {
  const orders = await db.orders.findAll({ where: { userId } });
  const items = await db.orderItems.findAll({ where: { orderId: orders.map((o) => o.id) } });
  return orders.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) }));
}
