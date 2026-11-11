/** Items on page `page` (1-based), `size` per page. Pages past the end are empty. */
export function paginate(items, page, size) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be an integer >= 1');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be an integer >= 1');
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

/** How many pages `items` fill at `size` per page. */
export function pageCount(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be an integer >= 1');
  return Math.ceil(items.length / size);
}
