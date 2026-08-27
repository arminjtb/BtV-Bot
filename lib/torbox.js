// Cliente HTTP puro para la API de TorBox (https://api-docs.torbox.app). CommonJS a propósito,
// mismo motivo que el resto de lib/*.js (ver lib/coImmersion.js): así lo puede importar tanto
// código CJS como ESM sin romper nada.
//
// Solo hace llamadas a la API — nada de discord.js, nada de base de datos. La orquestación
// (jobs, DB, texto de los embeds) vive en lib/torboxDownloads.js.

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

// Saca hasta `limit` magnet links de un texto libre (el contenido de un mensaje de Discord),
// deduplicados por hash.
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

module.exports = {
  isConfigured,
  extractHash,
  extractMagnets,
  createTorrent,
  getTorrentList,
  requestDownloadLink
};
