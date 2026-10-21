import { randomUUID } from "node:crypto";
import { mergeUniqueBooks, stabilizationDeadline } from "./nukiyasuDetector.js";

const STATE_ID = "nukiyasu:state";
const GUILD_ID = guildId => `nukiyasu:guild:${guildId}`;

export const DEFAULT_GUILD_CONFIG = {
  channelId: null,
  enabled: false,
  updatedAt: null
};

export async function getGuildConfig(db, guildId) {
  const doc = await db.findOne({ _id: GUILD_ID(guildId) });
  return { ...DEFAULT_GUILD_CONFIG, ...(doc || {}), guildId };
}

export async function setGuildConfig(db, guildId, patch) {
  await db.updateOne(
    { _id: GUILD_ID(guildId) },
    { $set: { kind: "nukiyasuGuild", guildId, ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
  return getGuildConfig(db, guildId);
}

export async function getConfiguredGuilds(db) {
  const docs = await db.find({ kind: "nukiyasuGuild", enabled: true, channelId: { $ne: null } }).toArray();
  return docs.map(doc => ({ ...DEFAULT_GUILD_CONFIG, ...doc }));
}

export async function getSyncState(db) {
  return (await db.findOne({ _id: STATE_ID })) || { kind: "nukiyasuState", baselineReady: false };
}

export async function setSyncState(db, patch) {
  await db.updateOne({ _id: STATE_ID }, { $set: { kind: "nukiyasuState", ...patch } }, { upsert: true });
}

export async function readActiveSnapshot(db) {
  const state = await getSyncState(db);
  if (!state.activeSnapshotVersion) return { state, series: [], books: [] };
  const [series, books] = await Promise.all([
    db.find({ kind: "nukiyasuSeriesSnapshot", snapshotVersion: state.activeSnapshotVersion }).toArray(),
    db.find({ kind: "nukiyasuBookSnapshot", snapshotVersion: state.activeSnapshotVersion }).toArray()
  ]);
  return {
    state,
    series: series.map(doc => doc.value),
    books: books.map(doc => doc.value)
  };
}

export async function writeSnapshotVersion(db, { series, books, version }) {
  const seriesOps = series.map(value => ({
    replaceOne: {
      filter: { _id: `nukiyasu:series:${value._id}:${version}` },
      replacement: { _id: `nukiyasu:series:${value._id}:${version}`, kind: "nukiyasuSeriesSnapshot", sourceId: value._id, snapshotVersion: version, value },
      upsert: true
    }
  }));
  const bookOps = books.map(value => ({
    replaceOne: {
      filter: { _id: `nukiyasu:book:${value._id}:${version}` },
      replacement: { _id: `nukiyasu:book:${value._id}:${version}`, kind: "nukiyasuBookSnapshot", sourceId: value._id, snapshotVersion: version, value },
      upsert: true
    }
  }));

  if (seriesOps.length) await db.bulkWrite(seriesOps, { ordered: false });
  if (bookOps.length) await db.bulkWrite(bookOps, { ordered: false });
  await setSyncState(db, {
    activeSnapshotVersion: version,
    baselineReady: true,
    lastSuccessfulSyncAt: new Date(),
    lastError: null
  });

  await Promise.all([
    db.deleteMany({ kind: "nukiyasuSeriesSnapshot", snapshotVersion: { $ne: version } }).catch(() => {}),
    db.deleteMany({ kind: "nukiyasuBookSnapshot", snapshotVersion: { $ne: version } }).catch(() => {})
  ]);
}

export async function recordPending(db, {
  series,
  books,
  type,
  now = new Date(),
  windowMs,
  maxMs
}) {
  const variant = series.variant || "unknown";
  const seriesId = String(series._id);
  const existing = await db.findOne({ kind: "nukiyasuPending", status: "pending", variant, seriesId });
  const firstDetectedAt = existing?.firstDetectedAt || now;
  const mergedBooks = mergeUniqueBooks(existing?.books || [], books || []);
  const pendingId = existing?._id || `nukiyasu:pending:${variant}:${seriesId}:${books?.[0]?._id || "series"}`;
  const document = {
    _id: pendingId,
    kind: "nukiyasuPending",
    status: "pending",
    type: existing?.type || type,
    variant,
    seriesId,
    series,
    books: mergedBooks,
    firstDetectedAt,
    lastDetectedAt: now,
    stabilizeAfter: stabilizationDeadline(firstDetectedAt, now, windowMs, maxMs),
    updatedAt: now
  };

  await db.updateOne(
    { _id: pendingId },
    { $set: document, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return document;
}

export async function promoteReadyPending(db, now = new Date()) {
  await db.updateMany(
    { kind: "nukiyasuPending", status: "pending", stabilizeAfter: { $lte: now } },
    { $set: { status: "ready", readyAt: now, updatedAt: now } }
  );
}

export async function getReadyPending(db, limit = 25) {
  return db.find({ kind: "nukiyasuPending", status: "ready" }).sort({ readyAt: 1, firstDetectedAt: 1 }).limit(limit).toArray();
}

export async function getRecentChanges(db, limit = 10) {
  return db.find({ kind: "nukiyasuPending", status: { $in: ["pending", "ready"] } }).sort({ firstDetectedAt: -1 }).limit(limit).toArray();
}

function deliveryId(pendingId, guildId) {
  return `nukiyasu:delivery:${pendingId}:${guildId}`;
}

export async function claimDelivery(db, pendingId, guildId, now = new Date()) {
  const _id = deliveryId(pendingId, guildId);
  const existing = await db.findOne({ _id });
  if (existing?.status === "sent") return false;
  if (existing?.status === "sending" && existing.leaseUntil && new Date(existing.leaseUntil) > now) return false;
  if (existing?.nextAttemptAt && new Date(existing.nextAttemptAt) > now) return false;
  const leaseUntil = new Date(now.getTime() + 2 * 60 * 1000);
  await db.updateOne(
    { _id },
    {
      $set: { kind: "nukiyasuDelivery", pendingId, guildId, status: "sending", leaseUntil, updatedAt: now },
      $setOnInsert: { createdAt: now },
      $inc: { attempts: 1 }
    },
    { upsert: true }
  );
  return true;
}

export async function markDeliverySent(db, pendingId, guildId) {
  await db.updateOne(
    { _id: deliveryId(pendingId, guildId) },
    { $set: { status: "sent", sentAt: new Date(), leaseUntil: null, lastError: null } }
  );
}

export async function markDeliveryFailed(db, pendingId, guildId, error) {
  await db.updateOne(
    { _id: deliveryId(pendingId, guildId) },
    { $set: { status: "pending", nextAttemptAt: new Date(Date.now() + 60_000), leaseUntil: null, lastError: String(error?.message || error).slice(0, 500) } }
  );
}

export function newSnapshotVersion() {
  return `${Date.now()}-${randomUUID()}`;
}
