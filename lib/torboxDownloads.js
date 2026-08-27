// Lógica de negocio del canal de descargas TorBox: crea/actualiza jobs en la DB compartida
// (client.db, colección "btv" — mismo patrón que lib/readathon.js y lib/coImmersion.js), hace
// match entre un job y su torrent en /mylist, y arma la DATA de los embeds (sin discord.js: los
// eventos events/torboxUpload.js y events/torboxPoller.js son quienes construyen el EmbedBuilder
// final, igual que hace events/readathon.js con lib/readathon.js).
//
// CommonJS a propósito — ver lib/coImmersion.js.

const crypto = require("crypto");
const torbox = require("./torbox.js");

function newJobId() {
  return `torbox:job:${crypto.randomUUID()}`;
}

function truncate(str, n) {
  const s = String(str ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ─── DB ──────────────────────────────────────────────────────────────────────

async function findActiveJobByHash(db, hash) {
  if (!hash) return null;
  return db.findOne({ kind: "torboxJob", hash, done: { $ne: true } });
}

async function getActiveJobs(db) {
  return db.find({ kind: "torboxJob", done: { $ne: true } }).toArray();
}

// Crea el job en DB e intenta arrancarlo en TorBox. Si el magnet ya se está trackeando (mismo
// hash, job activo), devuelve ese job existente en vez de duplicar embeds.
async function startJob(db, { guildId, channelId, userId, username, magnet }) {
  const hash = torbox.extractHash(magnet);

  if (hash) {
    const existing = await findActiveJobByHash(db, hash);
    if (existing) return { job: existing, duplicate: true };
  }

  const job = {
    _id: newJobId(),
    kind: "torboxJob",
    guildId,
    channelId,
    messageId: null,
    userId,
    username,
    magnet,
    hash,
    torrentId: null,
    name: null,
    size: null,
    progress: 0,
    downloadSpeed: 0,
    seeders: null,
    eta: null,
    state: "starting",
    done: false,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null
  };

  try {
    const created = await torbox.createTorrent(magnet);
    job.torrentId = created?.torrent_id ?? created?.id ?? null;
    if (created?.hash) job.hash = String(created.hash).toLowerCase();
    job.state = "downloading"; // optimista: el próximo poll lo corrige si el estado real es otro
  } catch (err) {
    if (err.torboxCode === "DUPLICATE_ITEM" && hash) {
      // No es un error real: el torrent ya existía en la cuenta de TorBox. Lo adoptamos —
      // el siguiente poll lo va a encontrar por hash y va a rellenar torrentId/estado solo.
      job.state = "downloading";
    } else {
      job.state = "error";
      job.error = err.message;
    }
  }

  await db.insertOne(job);
  return { job, duplicate: false };
}

async function setMessageId(db, jobId, messageId) {
  await db.updateOne({ _id: jobId }, { $set: { messageId, updatedAt: new Date() } });
}

async function updateJobFromTorrent(db, job, torrent) {
  const $set = {
    torrentId: torrent.id ?? job.torrentId,
    hash: (torrent.hash || job.hash || "").toLowerCase() || null,
    name: torrent.name || job.name || null,
    size: torrent.size ?? job.size ?? null,
    progress: typeof torrent.progress === "number" ? torrent.progress : job.progress,
    downloadSpeed: torrent.download_speed ?? 0,
    seeders: typeof torrent.seeders === "number" ? torrent.seeders : job.seeders,
    eta: torrent.eta ?? null,
    state: pickState(torrent),
    updatedAt: new Date()
  };

  await db.updateOne({ _id: job._id }, { $set });
  return { ...job, ...$set };
}

async function markDone(db, jobId, extra = {}) {
  await db.updateOne(
    { _id: jobId },
    { $set: { done: true, completedAt: new Date(), updatedAt: new Date(), ...extra } }
  );
}

// ─── Matching job <-> torrent ─────────────────────────────────────────────────

function pickState(torrent) {
  return torrent.download_state || torrent.status || torrent.state || "downloading";
}

function isTorrentFinished(torrent) {
  if (!torrent) return false;
  if (torrent.download_finished === true) return true;
  if (torrent.download_present === true) return true;
  if (typeof torrent.progress === "number" && torrent.progress >= 1) return true;
  const state = String(pickState(torrent)).toLowerCase();
  return ["completed", "uploading", "cached"].includes(state);
}

// Busca, dentro de la lista completa de /mylist, el torrent que corresponde a este job — primero
// por torrentId (si ya lo tenemos), si no por hash (cubre el caso DUPLICATE_ITEM, donde nunca nos
// dieron un torrentId directamente).
function matchTorrent(job, list) {
  if (!Array.isArray(list)) return null;

  if (job.torrentId != null) {
    const byId = list.find(t => String(t.id) === String(job.torrentId));
    if (byId) return byId;
  }

  if (job.hash) {
    const byHash = list.find(t => (t.hash || "").toLowerCase() === job.hash);
    if (byHash) return byHash;
  }

  return null;
}

// ─── Formato ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (!n || n <= 0) return "—";
  return `${formatBytes(n)}/s`;
}

function formatETA(seconds) {
  const n = Number(seconds);
  if (!n || n <= 0 || !Number.isFinite(n)) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Mismo estilo que lib/readathon.js / voting.js: bloques llenos + vacíos.
function progressBar(fraction, width = 20) {
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0));
  const filled = Math.round(pct * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

const STATE_LABELS = {
  starting: "🟡 Iniciando...",
  downloading: "⬇️ Descargando",
  metadl: "🔍 Obteniendo metadata",
  checkingresumedata: "🔄 Verificando datos",
  "stalled (no seeds)": "⚠️ Sin semillas",
  paused: "⏸️ Pausado",
  uploading: "📤 Sembrando (completo)",
  completed: "✅ Completo",
  cached: "⚡ En caché (completo)"
};

const STATE_COLORS = {
  starting: 0xF59E0B,
  downloading: 0x3B82F6,
  metadl: 0xF59E0B,
  checkingresumedata: 0xF59E0B,
  "stalled (no seeds)": 0xEF4444,
  paused: 0x6B7280,
  error: 0xED4245
};

function stateLabel(state) {
  const key = String(state || "").toLowerCase();
  return STATE_LABELS[key] || `⬇️ ${state}`;
}

function stateColor(state) {
  const key = String(state || "").toLowerCase();
  return STATE_COLORS[key] ?? 0x3B82F6;
}

// ─── Embeds (data plana, sin discord.js) ───────────────────────────────────────

function buildJobEmbedData(job) {
  const title = truncate(job.name || "Magnet en proceso...", 256);
  const state = job.state || "starting";

  if (state === "error") {
    return {
      color: STATE_COLORS.error,
      title: `❌ ${title}`,
      description: truncate(job.error || "Ocurrió un error al procesar este magnet.", 4000),
      fields: [{ name: "Subido por", value: job.username, inline: true }],
      footer: "TorBox"
    };
  }

  if (state === "starting") {
    return {
      color: STATE_COLORS.starting,
      title: `🟡 ${title}`,
      description: "Enviando el magnet a TorBox...",
      fields: [{ name: "Subido por", value: job.username, inline: true }],
      footer: "TorBox"
    };
  }

  const pct = Math.round((job.progress || 0) * 100);
  const fields = [
    { name: "Estado", value: stateLabel(state), inline: true },
    { name: "Progreso", value: `${pct}%`, inline: true },
    { name: "Velocidad", value: formatSpeed(job.downloadSpeed), inline: true }
  ];
  if (job.size) fields.push({ name: "Tamaño", value: formatBytes(job.size), inline: true });
  if (job.eta) fields.push({ name: "ETA", value: formatETA(job.eta), inline: true });
  if (typeof job.seeders === "number") fields.push({ name: "Seeders", value: String(job.seeders), inline: true });
  fields.push({ name: "Subido por", value: job.username, inline: true });

  return {
    color: stateColor(state),
    title,
    description: `\`${progressBar(job.progress || 0)}\` ${pct}%`,
    fields,
    footer: "TorBox"
  };
}

function buildFinishedEmbedData(job, downloadUrl) {
  const title = truncate(job.name || "Descarga completa", 256);

  if (!downloadUrl) {
    return {
      color: 0xED4245,
      title: `⚠️ ${title}`,
      description:
        "La descarga terminó en TorBox pero no se pudo generar el link automáticamente. Revisa el dashboard de TorBox.",
      fields: [],
      footer: "TorBox"
    };
  }

  const fields = [
    { name: "📥 Descargar", value: `[${truncate(job.name || "Link de descarga", 200)}](${downloadUrl})`, inline: false }
  ];
  if (job.size) fields.push({ name: "Tamaño", value: formatBytes(job.size), inline: true });

  return {
    color: 0x57F287,
    title: `✅ ${title}`,
    url: downloadUrl,
    description: "La descarga terminó y ya está lista.",
    fields,
    footer: "TorBox · el link expira en unas horas, descárgalo pronto"
  };
}

module.exports = {
  startJob,
  findActiveJobByHash,
  getActiveJobs,
  setMessageId,
  updateJobFromTorrent,
  markDone,
  isTorrentFinished,
  matchTorrent,
  buildJobEmbedData,
  buildFinishedEmbedData
};
