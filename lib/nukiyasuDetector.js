export function diffCatalogs(previous, current) {
  const previousSeries = new Map((previous?.series || []).map(item => [String(item._id), item]));
  const previousBooks = new Map((previous?.books || []).map(item => [String(item._id), item]));

  const newSeries = (current?.series || []).filter(item => !previousSeries.has(String(item._id)));
  const newBooks = (current?.books || []).filter(item => !previousBooks.has(String(item._id)));
  const booksBySeries = new Map();
  for (const book of newBooks) {
    const key = String(book.serie || "");
    if (!booksBySeries.has(key)) booksBySeries.set(key, []);
    booksBySeries.get(key).push(book);
  }

  return { newSeries, newBooks, booksBySeries };
}

export function stabilizationDeadline(firstDetectedAt, now, windowMs, maxMs) {
  const first = new Date(firstDetectedAt).getTime();
  const current = new Date(now).getTime();
  return new Date(Math.min(current + Math.max(0, windowMs), first + Math.max(windowMs, maxMs)));
}

export function mergeUniqueBooks(existing = [], additions = []) {
  const merged = new Map(existing.map(book => [String(book._id), book]));
  for (const book of additions) merged.set(String(book._id), book);
  return [...merged.values()].sort((a, b) => String(a.sortName || a.visibleName || "").localeCompare(String(b.sortName || b.visibleName || "")));
}

