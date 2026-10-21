import { diffCatalogs } from "./nukiyasuDetector.js";
import * as store from "./nukiyasuStore.js";

const STABILIZATION_MS = () => Math.max(0, Number(process.env.NUKIYASU_STABILIZATION_MS) || 10 * 60 * 1000);
const MAX_STABILIZATION_MS = () => Math.max(STABILIZATION_MS(), Number(process.env.NUKIYASU_MAX_STABILIZATION_MS) || 60 * 60 * 1000);

let reconciliationRunning = false;

export async function reconcileCatalog(client, db, { trigger = "poll" } = {}) {
  if (reconciliationRunning) return { skipped: true, reason: "already-running" };
  reconciliationRunning = true;

  try {
    const current = await client.fetchCatalog();
    const previous = await store.readActiveSnapshot(db);
    const version = store.newSnapshotVersion();

    if (!previous.state.baselineReady) {
      await store.writeSnapshotVersion(db, { ...current, version });
      console.log(`[nukiyasu] Línea base creada (${current.series.length} series, ${current.books.length} volúmenes).`);
      return { baseline: true, trigger, series: current.series.length, books: current.books.length };
    }

    const diff = diffCatalogs(previous, current);
    const now = new Date();
    const newSeriesIds = new Set(diff.newSeries.map(item => String(item._id)));
    const seriesById = new Map(current.series.map(item => [String(item._id), item]));
    const booksBySeries = new Map();
    for (const book of diff.newBooks) {
      const seriesId = String(book.serie || "");
      if (!booksBySeries.has(seriesId)) booksBySeries.set(seriesId, []);
      booksBySeries.get(seriesId).push(book);
    }

    for (const series of diff.newSeries) {
      await store.recordPending(db, {
        series,
        books: booksBySeries.get(String(series._id)) || [],
        type: "series",
        now,
        windowMs: STABILIZATION_MS(),
        maxMs: MAX_STABILIZATION_MS()
      });
    }

    for (const [seriesId, books] of booksBySeries) {
      if (newSeriesIds.has(seriesId)) continue;
      const series = seriesById.get(seriesId);
      if (!series) continue;
      await store.recordPending(db, {
        series,
        books,
        type: "volumes",
        now,
        windowMs: STABILIZATION_MS(),
        maxMs: MAX_STABILIZATION_MS()
      });
    }

    await store.writeSnapshotVersion(db, { ...current, version });
    await store.promoteReadyPending(db, now);
    return {
      baseline: false,
      trigger,
      newSeries: diff.newSeries.length,
      newBooks: diff.newBooks.length,
      series: current.series.length,
      books: current.books.length
    };
  } catch (error) {
    await store.setSyncState(db, { lastError: { code: error.code || "unknown", message: String(error.message || error).slice(0, 500), at: new Date() } }).catch(() => {});
    throw error;
  } finally {
    reconciliationRunning = false;
  }
}

export async function rebuildNukiyasuBaseline(client, db, { trigger = "manual-rebuild" } = {}) {
  if (reconciliationRunning) return { skipped: true, reason: "already-running" };
  reconciliationRunning = true;

  try {
    const current = await client.fetchCatalog();
    await store.writeSnapshotVersion(db, { ...current, version: store.newSnapshotVersion() });
    console.log(`[nukiyasu] Línea base reconstruida (${current.series.length} series, ${current.books.length} volúmenes); no se emitirán avisos históricos.`);
    return { baseline: true, rebuilt: true, trigger, series: current.series.length, books: current.books.length };
  } catch (error) {
    await store.setSyncState(db, { lastError: { code: error.code || "unknown", message: String(error.message || error).slice(0, 500), at: new Date() } }).catch(() => {});
    throw error;
  } finally {
    reconciliationRunning = false;
  }
}

export function reconciliationIsRunning() {
  return reconciliationRunning;
}
