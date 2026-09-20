// Lógica de negocio del canal de descargas TorBox: crea/actualiza jobs en la DB compartida
// (client.db, colección "btv" — mismo patrón que lib/readathon.js y lib/coImmersion.js), hace
// match entre un job y su torrent/descarga-web en /mylist, y arma la DATA de los embeds (sin
// discord.js: los eventos events/torboxUpload.js y events/torboxPoller.js son quienes construyen
// el EmbedBuilder y los botones finales, igual que hace events/readathon.js con lib/readathon.js).
//
// Un job puede ser de dos tipos (job.type):
//   - "torrent": viene de un magnet, usa /api/torrents/...
//   - "web":     viene de un link normal a un hoster, usa /api/webdl/...
// El resto de la lógica (progreso, estado, cancelar) es idéntica para ambos.
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
  return db.findOne({ kind: "torboxJob", type: "torrent", hash, done: { $ne: true } });
}

// Los links normales no tienen hash — deduplicamos por el link exacto que se subió.
async function findActiveJobByValue(db, value) {
  if (!value) return null;
  return db.findOne({ kind: "torboxJob", type: "web", magnet: value, done: { $ne: true } });
}

async function getActiveJobs(db) {
  return db.find({ kind: "torboxJob", done: { $ne: true } }).toArray();
}

// Crea el job en DB e intenta arrancarlo en TorBox. Si ya se está trackeando (mismo hash para
// torrents, mismo link para webdl, job activo), devuelve ese job existente en vez de duplicar
// embeds. `type` es "torrent" o "web".
async function startJob(db, { guildId, channelId, userId, username, magnet, type = "torrent" }) {
  const hash = type === "torrent" ? torbox.extractHash(magnet) : null;

  const existing = type === "torrent"
    ? await findActiveJobByHash(db, hash)
    : await findActiveJobByValue(db, magnet);
  if (existing) return { job: existing, duplicate: true };

  const job = {
    _id: newJobId(),
    kind: "torboxJob",
    type, // "torrent" | "web"
    guildId,
    channelId,
    messageId: null,
    userId,
    username,
    magnet, // el magnet o link original, tal cual lo mandó el usuario
    hash,
    remoteId: null, // torrent_id o webdownload_id según `type`
    name: null,
    size: null,
    progress: 0,
    downloadSpeed: 0,
    seeders: null,
    eta: null,
    state: "starting",
    done: false,
    cancelled: false,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null
  };

  try {
    if (type === "torrent") {
      const created = await torbox.createTorrent(magnet);
      job.remoteId = created?.torrent_id ?? created?.id ?? null;
      if (created?.hash) job.hash = String(created.hash).toLowerCase();
    } else {
      const created = await torbox.createWebDownload(magnet);
      job.remoteId = created?.webdownload_id ?? created?.id ?? null;
    }
    job.state = "downloading"; // optimista: el próximo poll lo corrige si el estado real es otro
  } catch (err) {
    if (type === "torrent" && err.torboxCode === "DUPLICATE_ITEM" && hash) {
      // No es un error real: el torrent ya existía en la cuenta de TorBox. Lo adoptamos —
      // el siguiente poll lo va a encontrar por hash y va a rellenar remoteId/estado solo.
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

async function updateJobFromRemote(db, job, remote) {
  const $set = {
    remoteId: remote.id ?? job.remoteId,
    name: remote.name || job.name || null,
    size: remote.size ?? job.size ?? null,
    progress: typeof remote.progress === "number" ? remote.progress : job.progress,
    downloadSpeed: remote.download_speed ?? 0,
    seeders: typeof remote.seeders === "number" ? remote.seeders : job.seeders,
    eta: remote.eta ?? null,
    state: pickState(remote),
    updatedAt: new Date()
  };
  if (job.type === "torrent") {
    $set.hash = (remote.hash || job.hash || "").toLowerCase() || null;
  }

  await db.updateOne({ _id: job._id }, { $set });
  return { ...job, ...$set };
}

async function markDone(db, jobId, extra = {}) {
  await db.updateOne(
    { _id: jobId },
    { $set: { done: true, completedAt: new Date(), updatedAt: new Date(), ...extra } }
  );
}

// Cancela un job: intenta borrarlo del lado de TorBox y, si funciona, lo marca como terminado
// (cancelado) en la DB. Si falla, no tocamos la DB — el poller lo sigue viendo activo y el
// usuario puede reintentar el botón. Si el job todavía no tiene remoteId (falló muy al inicio o
// el primer poll no ha corrido), simplemente lo marcamos como cancelado, no hay nada que borrar
// en TorBox.
async function cancelJob(db, job) {
  if (job.remoteId != null) {
    if (job.type === "web") await torbox.controlWebDownload(job.remoteId, "delete");
    else await torbox.controlTorrent(job.remoteId, "delete");
  }
  await markDone(db, job._id, { cancelled: true });
}

// ─── Matching job <-> torrent/descarga-web ────────────────────────────────────

function pickState(remote) {
  return remote.download_state || remote.status || remote.state || "downloading";
}

function isRemoteFinished(remote) {
  if (!remote) return false;
  if (remote.download_finished === true) return true;
  if (remote.download_present === true) return true;
  if (typeof remote.progress === "number" && remote.progress >= 1) return true;
  const state = String(pickState(remote)).toLowerCase();
  return ["completed", "uploading", "cached"].includes(state);
}

// Busca, dentro de la lista completa de /mylist (torrents o webdl según job.type), el item que
// corresponde a este job — primero por remoteId (si ya lo tenemos), si no por hash (torrents,
// cubre el caso DUPLICATE_ITEM, donde nunca nos dieron un id directamente).
function matchRemote(job, list) {
  if (!Array.isArray(list)) return null;

  if (job.remoteId != null) {
    const byId = list.find(t => String(t.id) === String(job.remoteId));
    if (byId) return byId;
  }

  if (job.type === "torrent" && job.hash) {
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
  const title = truncate(job.name || "Link en proceso...", 256);
  const state = job.state || "starting";
  const sourceLabel = job.type === "web" ? "🌐 Link" : "🧲 Torrent";

  if (state === "error") {
    return {
      color: STATE_COLORS.error,
      title: `❌ ${title}`,
      description: truncate(job.error || "Ocurrió un error al procesar esto.", 4000),
      fields: [
        { name: "Tipo", value: sourceLabel, inline: true },
        { name: "Subido por", value: job.username, inline: true }
      ],
      footer: "TorBox"
    };
  }

  if (state === "starting") {
    return {
      color: STATE_COLORS.starting,
      title: `🟡 ${title}`,
      description: "Enviando a TorBox...",
      fields: [
        { name: "Tipo", value: sourceLabel, inline: true },
        { name: "Subido por", value: job.username, inline: true }
      ],
      footer: "TorBox"
    };
  }

  const pct = Math.round((job.progress || 0) * 100);
  const fields = [
    { name: "Tipo", value: sourceLabel, inline: true },
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
  findActiveJobByValue,
  getActiveJobs,
  setMessageId,
  updateJobFromRemote,
  markDone,
  cancelJob,
  isRemoteFinished,
  matchRemote,
  buildJobEmbedData,
  buildFinishedEmbedData
};
