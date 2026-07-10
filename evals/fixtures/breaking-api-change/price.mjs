// Exported from @shop/pricing and consumed by 3 other services (checkout, invoices, admin-ui).
// Previous contract (still in the published .d.ts and README): returns a formatted string
// like "$12.34". Changed here to return a raw number — every caller doing
// formatPrice(cents).startsWith('$') or string-concatenating the result now breaks silently.
export function formatPrice(cents) {
  return cents / 100;
}

export function formatPriceWithCurrency(cents, currency) {
  return `${currency}${(cents / 100).toFixed(2)}`;
}
