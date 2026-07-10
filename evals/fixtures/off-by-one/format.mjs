// Display helper for pagination controls — no slicing here, just labels.
export function pageLabel(page, totalPages) {
  return `Page ${page + 1} of ${totalPages}`;
}
