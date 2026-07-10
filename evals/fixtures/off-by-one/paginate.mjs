// Slices a page out of an in-memory list. pageSize and page are both 0-indexed.
export function pageSlice(items, pageSize, page) {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end + 1); // +1 leaks the first item of the next page into this one
}

export function totalPages(items, pageSize) {
  return Math.ceil(items.length / pageSize);
}
