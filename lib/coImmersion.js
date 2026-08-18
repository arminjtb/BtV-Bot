// Rastrea, a partir de los logs que el bot observa (vía /log y vía el mirror del club), quién más
// está inmersando actualmente en la misma media (mismo type+contentId). Todo vive en la misma
// colección compartida del bot, un doc por (type, contentId, username).
//
// CommonJS a propósito (no import/export): así lo pueden requerir tanto los archivos CJS
// (commands/slash/log.js) como importar los ESM (events/clubLogMirror.js) sin romper nada —
// Node interopera CJS -> ESM de forma nativa, pero no al revés sin flags.
//
// No se registra nada de logs privados: si el log viene marcado `private`, el caller no debe
// llamar a recordSighting para él, para no filtrar por otra vía actividad que la persona pidió
// mantener oculta.

const WINDOW_MS = 21 * 24 * 60 * 60 * 1000; // 3 semanas

const VERB_BY_TYPE = {
  anime: "viendo",
  manga: "leyendo",
  vn: "leyendo",
  reading: "leyendo",
  game: "jugando",
  video_game: "jugando",
  video: "viendo",
  movie: "viendo",
  "tv show": "viendo",
  tv_show: "viendo",
  audio: "escuchando"
};

// Saca type/contentId/title/image de un log "completo" (el shape que devuelve
// GET /users/{username}/logs, con mediaId + mediaData). Devuelve null si el log no tiene
// suficiente info para identificar la media de forma inequívoca (p.ej. logs libres sin match,
// que no traen mediaId/mediaData.contentId).
function extractMediaInfo(log) {
  if (!log) return null;

  const type = log.type;
  const contentId = log.mediaId || log.mediaData?.contentId;
  if (!type || !contentId) return null;

  const title =
    log.mediaData?.contentTitleEnglish ||
    log.mediaData?.contentTitleRomaji ||
    log.mediaData?.contentTitleNative ||
    log.description ||
    String(contentId);

  const image = log.mediaData?.contentImage || null;

  return { type, contentId: String(contentId), title, image };
}

function docId(type, contentId, username) {
  return `co-immersion:${type}:${contentId}:${username.toLowerCase()}`;
}

// Registra/actualiza que `username` tiene actividad reciente sobre esta media. Idempotente y
// seguro de llamar repetido: el $max solo avanza `lastLoggedAt` si el dato nuevo es más reciente,
// así que no importa si el mismo log se procesa más de una vez.
async function recordSighting(db, { type, contentId, username, title, image, loggedAt = new Date() }) {
  if (!type || !contentId || !username) return;

  await db.updateOne(
    { _id: docId(type, contentId, username) },
    {
      $set: {
        kind: "coImmersionSighting",
        type,
        contentId: String(contentId),
        username,
        title: title || String(contentId),
        image: image || null
      },
      $max: { lastLoggedAt: loggedAt },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
}

// Siembra sightings a partir de la immersion list completa de un usuario (GET
// /users/{username}/immersionlist). Pensado para arrancar en frío: sin esto, la primera vez que
// se activa el tracking no hay nada que mostrar aunque en la web ya haya gente con logs recientes
// del mismo título, porque el índice de sightings solo se llena con logs observados DESPUÉS de
// activarlo (vía /log o el mirror del club). Usa `lastLogDate` de cada entrada como `loggedAt`, y
// se salta cualquier entrada fuera de la ventana de 3 semanas — no tiene caso sembrar algo que
// `getCoImmersors`/`getActiveImmersion` van a filtrar de todos modos.
async function backfillFromImmersionList(db, username, immersionListData) {
  if (!username || !immersionListData) return 0;

  const cutoff = new Date(Date.now() - WINDOW_MS);
  let recorded = 0;

  for (const bucketType of Object.keys(immersionListData)) {
    const bucket = immersionListData[bucketType];
    if (!Array.isArray(bucket)) continue;

    for (const entry of bucket) {
      if (!entry?.contentId || !entry?.lastLogDate) continue;

      const loggedAt = new Date(entry.lastLogDate);
      if (Number.isNaN(loggedAt.getTime()) || loggedAt < cutoff) continue;

      const title =
        entry.title?.contentTitleEnglish ||
        entry.title?.contentTitleRomaji ||
        entry.title?.contentTitleNative ||
        String(entry.contentId);

      await recordSighting(db, {
        type: entry.type || bucketType,
        contentId: entry.contentId,
        username,
        title,
        image: entry.contentImage || null,
        loggedAt
      });
      recorded++;
    }
  }

  return recorded;
}

// Otras personas con actividad reciente (<= 3 semanas) sobre la misma media, sin contar a
// `excludeUsername`. Ordenado del sighting más reciente al más viejo.
async function getCoImmersors(db, { type, contentId, excludeUsername } = {}) {
  if (!type || !contentId) return [];

  const cutoff = new Date(Date.now() - WINDOW_MS);
  const excludeLower = excludeUsername ? excludeUsername.toLowerCase() : null;

  const docs = await db.find({
    kind: "coImmersionSighting",
    type,
    contentId: String(contentId),
    lastLoggedAt: { $gte: cutoff }
  }).toArray();

  return docs
    .filter(doc => doc.username?.toLowerCase() !== excludeLower)
    .sort((a, b) => new Date(b.lastLoggedAt) - new Date(a.lastLoggedAt))
    .map(doc => ({ username: doc.username, lastLoggedAt: doc.lastLoggedAt }));
}

// Agrupa toda la actividad reciente (<= 3 semanas) por media, para /inmersion-activa.
// Solo incluye media con al menos `minUsers` personas distintas activas.
async function getActiveImmersion(db, { type = null, minUsers = 2 } = {}) {
  const cutoff = new Date(Date.now() - WINDOW_MS);
  const query = { kind: "coImmersionSighting", lastLoggedAt: { $gte: cutoff } };
  if (type) query.type = type;

  // Orden ascendente por lastLoggedAt: al recorrerlos en ese orden, el título/imagen del último
  // doc que toca cada grupo es el más reciente, sin tener que comparar fechas a mano.
  const docs = await db.find(query).sort({ lastLoggedAt: 1 }).toArray();

  const groups = new Map(); // `${type}:${contentId}` -> { type, contentId, title, image, usernames:Set, lastLoggedAt }

  for (const doc of docs) {
    const key = `${doc.type}:${doc.contentId}`;
    const existing = groups.get(key) || { type: doc.type, contentId: doc.contentId, usernames: new Set() };

    existing.usernames.add(doc.username);
    existing.title = doc.title;
    existing.image = doc.image;
    existing.lastLoggedAt = doc.lastLoggedAt;

    groups.set(key, existing);
  }

  return [...groups.values()]
    .filter(g => g.usernames.size >= minUsers)
    .map(g => ({ ...g, usernames: [...g.usernames] }))
    .sort((a, b) => b.usernames.length - a.usernames.length || new Date(b.lastLoggedAt) - new Date(a.lastLoggedAt));
}

function formatNameList(names) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

// Field listo para meter en un embed de discord.js (o null si no hay nadie más). Compartido entre
// el mirror del club y /log para que el texto sea idéntico en ambos lados.
function buildCoImmersionField(others, type) {
  if (!others || others.length === 0) return null;

  const verb = VERB_BY_TYPE[type] || "inmersando en esto";
  const names = others.map(o => `**${o.username}**`);

  return {
    name: `👀 También lo están ${verb}`,
    value: formatNameList(names),
    inline: false
  };
}

module.exports = {
  WINDOW_MS,
  VERB_BY_TYPE,
  extractMediaInfo,
  recordSighting,
  backfillFromImmersionList,
  getCoImmersors,
  getActiveImmersion,
  formatNameList,
  buildCoImmersionField
};
