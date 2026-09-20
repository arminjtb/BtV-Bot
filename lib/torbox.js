// Cliente HTTP puro para la API de TorBox (https://api-docs.torbox.app). CommonJS a propósito,
// mismo motivo que el resto de lib/*.js (ver lib/coImmersion.js): así lo puede importar tanto
// código CJS como ESM sin romper nada.
//
// Solo hace llamadas a la API — nada de discord.js, nada de base de datos. La orquestación
// (jobs, DB, texto de los embeds) vive en lib/torboxDownloads.js.
//
// Maneja dos "familias" de descargas de TorBox:
//   - torrents  (/api/torrents/...)  — a partir de un magnet
//   - webdl     (/api/webdl/...)     — a partir de un link normal a un hoster soportado
// No filtramos qué hosts acepta TorBox: si el link no sirve, createWebDownload/createTorrent
// regresan el error de la API tal cual, y ese es el mensaje que se le muestra al usuario.

const axios = require("axios");

const API_BASE = "https://api.torbox.app";
const API_VERSION = "v1";

function apiKey() {
  const key = process.env.TORBOX_API_KEY;
  if (!key) throw new Error("Falta TORBOX_API_KEY en el .env");
  return key;
}

function isConfigured() {
  return Boolean(process.env.TORBOX_API_KEY);
}

function authHeaders() {
  return { Authorization: `Bearer ${apiKey()}` };
}

// TorBox siempre responde { success, error, detail, data }. `detail` es un mensaje pensado para
// mostrarse directo al usuario (así lo dice su documentación), así que lo usamos como mensaje del
// Error.
function apiError(data, fallback) {
  const err = new Error(data?.detail || fallback);
  err.torboxCode = data?.error || null;
  return err;
}

// Extrae el hash BTIH de un magnet link (en minúsculas). Sirve para encontrar el torrent en
// /mylist sin depender de que TorBox nos haya devuelto un torrent_id (p.ej. si el magnet ya
// existía en la cuenta y createtorrent devolvió DUPLICATE_ITEM).
function extractHash(magnet) {
  const match = /btih:([a-z0-9]+)/i.exec(magnet || "");
  return match ? match[1].toLowerCase() : null;
}

// Saca hasta `limit` magnet links de un texto libre, deduplicados por hash.
function extractMagnets(text, limit = 5) {
  const matches = String(text || "").match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s]*/gi) || [];
  const seen = new Set();
  const out = [];

  for (const m of matches) {
    const key = extractHash(m) || m;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= limit) break;
  }

  return out;
}

// Saca tanto magnets como links normales de un texto libre (el contenido de un mensaje de
// Discord). Cada entrada trae { type: "torrent" | "web", value }. No hay validación de host aquí
// — eso lo decide TorBox al recibir el link.
function extractLinks(text, limit = 5) {
  const str = String(text || "");
  const magnets = extractMagnets(str, limit);
  const seen = new Set(magnets.map(m => extractHash(m) || m));
  const out = magnets.map(value => ({ type: "torrent", value }));

  if (out.length < limit) {
    const urlMatches = str.match(/https?:\/\/[^\s<>]+/gi) || [];
    for (const url of urlMatches) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ type: "web", value: url });
      if (out.length >= limit) break;
    }
  }

  return out;
}

// ─── Torrents ──────────────────────────────────────────────────────────────

async function createTorrent(magnet) {
  const form = new FormData();
  form.append("magnet", magnet);

  const { data } = await axios.post(
    `${API_BASE}/${API_VERSION}/api/torrents/createtorrent`,
    form,
    { headers: authHeaders() }
  );

  if (!data?.success) throw apiError(data, "TorBox rechazó el magnet.");
  return data.data; // { torrent_id, hash, auth_id }
}

// Sin `id`: lista completa de la cuenta. Con `id`: solo ese torrent (como objeto, no array).
// Siempre pedimos bypassCache para tener datos frescos de progreso/velocidad.
async function getTorrentList({ id, bypassCache = true } = {}) {
  const params = { bypass_cache: bypassCache ? "true" : "false" };
  if (id != null) params.id = id;

  const { data } = await axios.get(
    `${API_BASE}/${API_VERSION}/api/torrents/mylist`,
    { headers: authHeaders(), params }
  );

  if (!data?.success) throw apiError(data, "No se pudo obtener la lista de torrents de TorBox.");
  return data.data;
}

// Pide el link de descarga (CDN) para un torrent ya terminado. Si el torrent tiene más de un
// archivo, pasa `zip: true` para pedir un solo link con todo comprimido en vez de tener que elegir
// un file_id.
async function requestDownloadLink({ torrentId, fileId, zip }) {
  const params = { token: apiKey(), torrent_id: torrentId };
  if (zip) params.zip_link = "true";
  else if (fileId != null) params.file_id = fileId;

  const { data } = await axios.get(
    `${API_BASE}/${API_VERSION}/api/torrents/requestdl`,
    { params }
  );

  if (!data?.success) throw apiError(data, "No se pudo generar el link de descarga.");
  return data.data; // string con la URL del CDN
}

// operation: "delete" (también soporta "pause"/"resume"/"reannounce" según la doc de TorBox,
// pero acá solo usamos delete para cancelar).
async function controlTorrent(torrentId, operation = "delete") {
  const { data } = await axios.post(
    `${API_BASE}/${API_VERSION}/api/torrents/controltorrent`,
    { torrent_id: torrentId, operation },
    { headers: authHeaders() }
  );

  if (!data?.success) throw apiError(data, "No se pudo cancelar el torrent.");
  return data.data;
}

// ─── Web downloads (hosters normales, no torrents) ─────────────────────────

async function createWebDownload(link) {
  const form = new FormData();
  form.append("link", link);

  const { data } = await axios.post(
    `${API_BASE}/${API_VERSION}/api/webdl/createwebdownload`,
    form,
    { headers: authHeaders() }
  );

  if (!data?.success) throw apiError(data, "TorBox rechazó el link.");
  return data.data; // { webdownload_id, hash, ... }
}

async function getWebDownloadList({ id, bypassCache = true } = {}) {
  const params = { bypass_cache: bypassCache ? "true" : "false" };
  if (id != null) params.id = id;

  const { data } = await axios.get(
    `${API_BASE}/${API_VERSION}/api/webdl/mylist`,
    { headers: authHeaders(), params }
  );

  if (!data?.success) throw apiError(data, "No se pudo obtener la lista de descargas web de TorBox.");
  return data.data;
}

async function requestWebDownloadLink({ webId, fileId, zip }) {
  const params = { token: apiKey(), web_id: webId };
  if (zip) params.zip_link = "true";
  else if (fileId != null) params.file_id = fileId;

  const { data } = await axios.get(
    `${API_BASE}/${API_VERSION}/api/webdl/requestdl`,
    { params }
  );

  if (!data?.success) throw apiError(data, "No se pudo generar el link de descarga.");
  return data.data;
}

// NOTA: a diferencia de controltorrent (bien documentado, ver arriba), el nombre exacto del
// parámetro de id para este endpoint no está claro — la doc pública de TorBox lo muestra como
// query param `id`, mientras que SDKs no oficiales usan `webdownload_id`/`webdl_id` en el body.
// Si cancelar una descarga web (no-torrent) falla, esto es lo primero a revisar contra la doc
// vigente de TorBox.
async function controlWebDownload(webId, operation = "delete") {
  const { data } = await axios.post(
    `${API_BASE}/${API_VERSION}/api/webdl/controlwebdownload`,
    { operation },
    { headers: authHeaders(), params: { id: webId } }
  );

  if (!data?.success) throw apiError(data, "No se pudo cancelar la descarga web.");
  return data.data;
}

module.exports = {
  isConfigured,
  extractHash,
  extractMagnets,
  extractLinks,
  createTorrent,
  getTorrentList,
  requestDownloadLink,
  controlTorrent,
  createWebDownload,
  getWebDownloadList,
  requestWebDownloadLink,
  controlWebDownload
};
