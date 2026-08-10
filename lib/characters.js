import axios from "axios";
import { randomUUID } from "crypto";
import readathonLib from "./readathon.js";

const { buildWindow } = readathonLib;

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID = "6951b8e3319c4aea0d5d2b2d";
const ANILIST_API = "https://graphql.anilist.co";
const VNDB_API = "https://api.vndb.org/kana";
const SPAIN_TIME_ZONE = "Europe/Madrid";

const MIN_LOGGERS_FOR_ELIGIBILITY = 2;
const ELIGIBILITY_REFRESH_MS = 20 * 60 * 60 * 1000; // ~20h, se re-corre a lo mucho 1x/día
const MAX_LOG_PAGES_PER_USER = 30; // 30 * 100 = 3000 logs por usuario tope, para no reventar la API en el refresh de elegibilidad

// Tipos que sí tienen un ID externo (AniList o VNDB) confiable en `contentId`.
// "reading" y el resto no tienen catálogo de personajes estructurado.
const CATALOG_TYPES = new Set(["anime", "manga", "vn"]);

// Tipos de contenido que puede pedir un reto. Independiente del personaje que salga.
// Limitado a los tipos con catálogo real de género (AniList/VNDB) — se sacaron "movie", "tv show"
// y "game" porque no hay forma confiable de verificar su género real contra el tag del reto.
const CHALLENGE_CONTENT_TYPES = ["anime", "manga", "vn", "reading"];

const TYPE_LABELS = {
  anime: "🎌 Anime",
  manga: "📚 Manga",
  reading: "📖 Lectura",
  vn: "🎮 Novela Visual"
};

// Rangos [min, max] inclusive por dificultad. anime/manga = conteo, vn/reading = caracteres.
const DIFFICULTY_RANGES = {
  anime:      { easy: [1, 4],       hard: [5, 10] },
  manga:      { easy: [20, 200],    hard: [201, 600] },
  vn:         { easy: [1000, 15000], hard: [16000, 50000] },
  reading:    { easy: [1000, 15000], hard: [16000, 50000] }
};

const UNIT_BY_CONTENT_TYPE = {
  anime: "episodes",
  manga: "pages",
  vn: "chars",
  reading: "chars"
};

// Campo del log de NihongoTracker que hay que sumar según el tipo de reto.
const LOG_FIELD_BY_CONTENT_TYPE = {
  anime: "episodes",
  manga: "pages",
  vn: "chars",
  reading: "chars"
};

// Diccionario género/tag (inglés, como vienen de AniList genres o VNDB tags) -> tag en español para el reto.
// Se usa el primer match encontrado en la lista de géneros/tags de la obra; si no hay match, "general".
const GENRE_TAG_MAP = {
  action: "acción",
  adventure: "aventura",
  comedy: "comedia",
  drama: "drama",
  ecchi: "ecchi",
  fantasy: "fantasía",
  horror: "terror",
  "mahou shoujo": "mahou shoujo",
  mecha: "mecha",
  music: "música",
  mystery: "misterio",
  "murder mystery": "misterio",
  psychological: "psicológico",
  romance: "romance",
  "romantic drama": "romance",
  "sci-fi": "ciencia ficción",
  "science fiction": "ciencia ficción",
  "slice of life": "slice of life",
  sports: "deportes",
  supernatural: "sobrenatural",
  thriller: "suspenso",
  tragedy: "tragedia",
  nakige: "drama",
  chuunige: "acción",
  "coming of age": "coming of age"
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// AniList tiene, además del límite de 90 req/min, un "burst limiter": si lo disparas te bloquea con
// 429 durante un minuto completo, y cualquier request que caiga en esa ventana también falla. Sin
// reintentar respetando Retry-After, un solo 429 arruina en cascada todo lo que sigue en ese minuto.
async function postAnilist(body, attempt = 1) {
  try {
    return await axios.post(ANILIST_API, body);
  } catch (err) {
    if (err.response?.status === 429 && attempt <= 3) {
      const retryAfterSec = Number(err.response.headers?.["retry-after"]) || 60;
      await sleep((retryAfterSec + 1) * 1000);
      return postAnilist(body, attempt + 1);
    }
    throw err;
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toDateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Fecha "de hoy" (año/mes/día) según la zona horaria de España, para decidir si ya empezó un nuevo día.
function getTodaySpainDateParts(referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SPAIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(referenceDate);

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

// Los ObjectId de Mongo codifican el timestamp de creación en los primeros 4 bytes.
// Usamos esto (no el campo `date`, que el usuario puede editar libremente al loguear) para
// determinar si un log realmente ocurrió después de que arrancó el evento.
function objectIdTimestamp(id) {
  if (!id || !/^[a-f0-9]{24}$/i.test(id)) return null;
  return new Date(parseInt(id.substring(0, 8), 16) * 1000);
}

// ================= ELEGIBILIDAD DE OBRAS =================

async function fetchClubMembers() {
  const members = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data } = await axios.get(`${API_BASE}/clubs/${CLUB_ID}/rankings`, {
      params: { period: "all-time", limit, offset }
    });
    const rankings = Array.isArray(data?.rankings) ? data.rankings : [];
    members.push(...rankings.map(entry => entry.user).filter(user => user?.username));

    const total = data?.pagination?.total;
    if (rankings.length < limit || (Number.isFinite(total) && offset + rankings.length >= total)) break;
    offset += rankings.length;
  }

  return [...new Map(members.map(m => [m.username.toLowerCase(), m])).values()];
}

async function fetchAllUserLogs(username) {
  const logs = [];
  const limit = 100;

  for (let page = 1; page <= MAX_LOG_PAGES_PER_USER; page++) {
    const { data } = await axios.get(`${API_BASE}/users/${encodeURIComponent(username)}/logs`, {
      params: { page, limit }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    logs.push(...data);
    if (data.length < limit) break;
  }

  return logs;
}

// Recorre a todos los miembros del club, agrupa sus logs de anime/manga/vn por (type, contentId)
// y cachea como "eligibleWork" los que tengan >= MIN_LOGGERS_FOR_ELIGIBILITY usuarios distintos.
// Nota: solo cuenta logs públicos (el endpoint de logs de usuario, sin API key, no expone privados).
// Un título "roto" es cuando lo único que teníamos era el ID crudo (pasa cuando alguien loguea
// con /log un título que no matcheó contra el catálogo de nihongotracker, y el log queda con
// contentTitleNative/English/Romaji vacíos). En ese caso mejor resolver el título real contra
// AniList/VNDB directamente en vez de mostrar el ID.
function looksLikeRawId(title, contentId) {
  const t = String(title ?? "").trim();
  return t === "" || t === String(contentId).trim();
}

async function fetchAuthoritativeTitle(type, contentId) {
  try {
    if (type === "vn") {
      const { data } = await axios.post(`${VNDB_API}/vn`, {
        filters: ["id", "=", toVndbId(contentId)],
        fields: "title"
      });
      return data?.results?.[0]?.title || null;
    }

    const query = `
      query ($id: Int, $type: MediaType) {
        Media(id: $id, type: $type) {
          title { english romaji native }
        }
      }
    `;
    const { data } = await postAnilist({
      query,
      variables: { id: Number(contentId), type: type === "manga" ? "MANGA" : "ANIME" }
    });
    const t = data?.data?.Media?.title;
    return t?.english || t?.romaji || t?.native || null;
  } catch {
    return null;
  }
}

async function refreshEligibleWorks(db) {
  const members = await fetchClubMembers();
  const workLoggers = new Map(); // key `${type}:${contentId}` -> { type, contentId, title, image, users:Set, genresHint }

  for (let i = 0; i < members.length; i += 5) {
    const batch = members.slice(i, i + 5);
    const results = await Promise.all(batch.map(async member => {
      const logs = await fetchAllUserLogs(member.username).catch(() => []);
      return { member, logs };
    }));

    for (const { member, logs } of results) {
      for (const log of logs) {
        if (!CATALOG_TYPES.has(log.type)) continue;
        const contentId = log.mediaId || log.mediaData?.contentId;
        if (!contentId) continue;

        const key = `${log.type}:${contentId}`;
        const existing = workLoggers.get(key) || {
          type: log.type,
          contentId: String(contentId),
          title:
            log.mediaData?.contentTitleEnglish ||
            log.mediaData?.contentTitleRomaji ||
            log.mediaData?.contentTitleNative ||
            String(contentId),
          image: log.mediaData?.contentImage || null,
          users: new Set()
        };
        existing.users.add(member.username.toLowerCase());
        workLoggers.set(key, existing);
      }
    }
  }

  const now = new Date();
  let eligibleCount = 0;

  for (const work of workLoggers.values()) {
    if (work.users.size < MIN_LOGGERS_FOR_ELIGIBILITY) continue;
    eligibleCount++;

    let title = work.title;
    if (looksLikeRawId(title, work.contentId)) {
      title = (await fetchAuthoritativeTitle(work.type, work.contentId)) || title;
      // AniList tiene un rate limit bajo (sin API key); una pausa evita que las siguientes
      // consultas empiecen a fallar con 429 y se queden sin arreglar en silencio.
      if (work.type !== "vn") await sleep(700);
    }

    await db.updateOne(
      { _id: `eligible-work:${work.type}:${work.contentId}` },
      {
        $set: {
          kind: "eligibleWork",
          type: work.type,
          contentId: work.contentId,
          title,
          image: work.image,
          memberCount: work.users.size,
          lastCheckedAt: now
        },
        $setOnInsert: { createdAt: now, catalogFetchedAt: null, genres: [] }
      },
      { upsert: true }
    );
  }

  await db.updateOne(
    { _id: "character-event:state" },
    { $set: { kind: "characterEventState", lastEligibilityRefreshAt: now } },
    { upsert: true }
  );

  return eligibleCount;
}

async function getEligibleWorks(db) {
  return db.find({ kind: "eligibleWork", memberCount: { $gte: MIN_LOGGERS_FOR_ELIGIBILITY } }).toArray();
}

async function ensureEligibleWorksFresh(db) {
  const state = await db.findOne({ _id: "character-event:state" });
  const lastRefresh = state?.lastEligibilityRefreshAt ? new Date(state.lastEligibilityRefreshAt) : null;

  if (!lastRefresh || Date.now() - lastRefresh.getTime() > ELIGIBILITY_REFRESH_MS) {
    await refreshEligibleWorks(db);
  }
}

// ================= CATÁLOGO DE PERSONAJES (ANILIST / VNDB) =================

async function fetchAnilistCharacters(contentId, type) {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        genres
        characters(page: 1, perPage: 25, sort: [ROLE, RELEVANCE]) {
          edges {
            role
            node { id name { full userPreferred } image { large } }
          }
        }
      }
    }
  `;

  const { data } = await postAnilist({
    query,
    variables: { id: Number(contentId), type: type === "manga" ? "MANGA" : "ANIME" }
  });

  const media = data?.data?.Media;
  if (!media) return { genres: [], characters: [] };

  const characters = (media.characters?.edges || []).map(edge => ({
    source: "anilist",
    charId: String(edge.node.id),
    name: edge.node.name?.full || edge.node.name?.userPreferred || "Desconocido",
    image: edge.node.image?.large || null,
    role: edge.role === "MAIN" ? "main" : "side"
  }));

  return { genres: media.genres || [], characters };
}

// NihongoTracker guarda el contentId de VN igual que AniList: numérico, sin el prefijo "v" de VNDB.
// Si en tu base ya viene con el prefijo, esta función lo detecta igual.
function toVndbId(contentId) {
  const raw = String(contentId).trim();
  return raw.toLowerCase().startsWith("v") ? raw : `v${raw}`;
}

async function fetchVndbCharacters(contentId) {
  const vndbId = toVndbId(contentId);

  const [vnRes, charRes] = await Promise.all([
    axios.post(`${VNDB_API}/vn`, {
      filters: ["id", "=", vndbId],
      fields: "title, tags.name, tags.category"
    }),
    axios.post(`${VNDB_API}/character`, {
      filters: ["vn", "=", ["id", "=", vndbId]],
      fields: "id, name, original, image.url, vns.id, vns.role",
      results: 50
    })
  ]);

  const vn = vnRes.data?.results?.[0];
  // "cont" = tags de contenido/tema, lo más parecido a un género.
  const genres = (vn?.tags || [])
    .filter(t => t.category === "cont")
    .map(t => t.name);

  const characters = (charRes.data?.results || []).map(node => {
    const vnLink = (node.vns || []).find(v => v.id === vndbId);
    return {
      source: "vndb",
      charId: node.id,
      name: node.name || node.original || "Desconocido",
      image: node.image?.url || null,
      role: vnLink?.role === "main" ? "main" : "side"
    };
  });

  return { genres, characters };
}

// Trae y cachea el catálogo de personajes de una obra elegible (perezoso: solo se llama la primera vez
// que la obra se necesita, o si el cache está vacío). No se re-ejecuta en cada refresh de elegibilidad
// para no reventar el rate limit de AniList/VNDB.
// Devuelve los géneros actuales de la obra (recién traídos, o los que ya tenía cacheados) para que
// el caller pueda usarlos de una vez para el tag del reto, en vez de leer el objeto `work` desactualizado.
async function ensureCharacterCatalog(db, work) {
  if (work.catalogFetchedAt) return work.genres || [];

  let result;
  try {
    result = work.type === "vn"
      ? await fetchVndbCharacters(work.contentId)
      : await fetchAnilistCharacters(work.contentId, work.type);
  } catch (err) {
    console.error(`[characters] Error trayendo catálogo de ${work.type}:${work.contentId}:`, err.response?.data || err.message);
    return work.genres || [];
  }

  const now = new Date();

  for (const char of result.characters) {
    // La clave incluye la obra (workType+contentId) a propósito: en VNDB (y a veces AniList con
    // reediciones) el mismo personaje puede tener el mismo charId en más de una obra elegible
    // (p.ej. Rance aparece con el mismo ID en Rance VI y Rance VII). Sin esto, cada catalogación
    // pisaba el documento del personaje anterior y se lo "robaba" a la otra obra silenciosamente.
    await db.updateOne(
      { _id: `character:${char.source}:${char.charId}:${work.type}:${work.contentId}` },
      {
        $set: {
          name: char.name,
          image: char.image,
          role: char.role,
          workType: work.type,
          workContentId: work.contentId,
          workTitle: work.title
        },
        $setOnInsert: {
          kind: "character",
          claimed: false,
          createdAt: now
        }
      },
      { upsert: true }
    );
  }

  await db.updateOne(
    { _id: work._id },
    { $set: { catalogFetchedAt: now, genres: result.genres } }
  );

  return result.genres;
}

// ================= GENERACIÓN DEL RETO =================

function mapGenresToTag(genres) {
  for (const genre of genres || []) {
    const match = GENRE_TAG_MAP[String(genre).toLowerCase()];
    if (match) return match;
  }
  return "general";
}

function generateChallenge(role) {
  const difficulty = role === "main" ? "hard" : "easy";
  const contentType = CHALLENGE_CONTENT_TYPES[randomInt(0, CHALLENGE_CONTENT_TYPES.length - 1)];
  const [min, max] = DIFFICULTY_RANGES[contentType][difficulty];
  const amount = randomInt(min, max);
  const unit = UNIT_BY_CONTENT_TYPE[contentType];

  return { difficulty, contentType, amount, unit };
}

// ================= EL EVENTO DIARIO =================

// Reserva atómicamente el roll del día. Antes esto era un check-then-act (leer lastRolledDate,
// y si no era hoy, escribirlo) en dos pasos separados — con el bot corriendo 2 veces a la vez
// (p.ej. reinicios donde el proceso viejo no murió a tiempo) ambos procesos podían leer "todavía
// no rolleé hoy" antes de que ninguno alcanzara a escribir, y los dos tiraban su propio 1/5 y
// podían generar 2 personajes el mismo día.
// $max solo aplica el $set si el valor nuevo es mayor al que ya había — como todayKey es
// "YYYY-MM-DD" (con ceros), la comparación de string de Mongo coincide con la cronológica. Al
// devolver el documento "antes" del update, comparamos ese valor viejo contra hoy: si ya era hoy,
// esta llamada perdió la carrera y no debe rollear. findOneAndUpdate es atómico a nivel de
// documento en Mongo, así que solo una llamada puede ganar sin importar cuántos procesos compitan.
async function claimDailyRoll(db, todayKey) {
  const before = await db.findOneAndUpdate(
    { _id: "character-event:state" },
    {
      $max: { lastRolledDate: todayKey },
      $setOnInsert: { kind: "characterEventState" }
    },
    { upsert: true, returnDocument: "before" }
  );

  const previousDate = before?.value?.lastRolledDate ?? before?.lastRolledDate ?? null;
  return previousDate !== todayKey;
}

async function getActiveEvent(db) {
  return db.findOne({ kind: "dailyCharacterEvent", status: "active" });
}

// Intenta armar el evento del día: 1/5 de probabilidad, obra al azar entre las elegibles con al
// menos un personaje sin reclamar, personaje al azar dentro de esa obra. Devuelve null si no tocó
// evento hoy, o si no hay ningún personaje disponible.
async function rollDailyEvent(db) {
  const todayParts = getTodaySpainDateParts();
  const todayKey = toDateKey(todayParts);

  if (!(await claimDailyRoll(db, todayKey))) return null;

  if (Math.random() >= 0.2) return null; // 1/5

  await ensureEligibleWorksFresh(db);
  const works = await getEligibleWorks(db);
  if (works.length === 0) return null;

  // Baraja las obras y prueba una por una hasta encontrar una con personaje disponible,
  // así una obra sin personajes cacheados aún no bloquea el sorteo.
  const shuffled = [...works].sort(() => Math.random() - 0.5);

  for (const work of shuffled) {
    const genres = await ensureCharacterCatalog(db, work);
    const candidates = await db.find({
      kind: "character",
      claimed: false,
      workType: work.type,
      workContentId: work.contentId
    }).toArray();

    if (candidates.length === 0) continue;

    const character = candidates[randomInt(0, candidates.length - 1)];
    const challenge = generateChallenge(character.role);
    const tag = mapGenresToTag(genres);
    const window = buildWindow(todayParts);

    const eventDoc = {
      _id: `character-event:${randomUUID().split("-")[0]}`,
      kind: "dailyCharacterEvent",
      status: "active",
      characterId: character._id,
      characterName: character.name,
      characterImage: character.image,
      characterRole: character.role,
      workTitle: work.title,
      workType: work.type,
      workContentId: work.contentId,
      challenge: { ...challenge, tag },
      startAt: window.startAt,
      deadline: window.endAt,
      channelId: null,
      messageId: null,
      winnerDiscordId: null,
      createdAt: new Date()
    };

    await db.insertOne(eventDoc);
    return eventDoc;
  }

  return null;
}

async function setEventMessage(db, eventId, channelId, messageId) {
  await db.updateOne({ _id: eventId }, { $set: { channelId, messageId } });
}

// ================= RESOLUCIÓN DEL RETO =================

// Tipos para los que sabemos de dónde sacar género real. anime/manga van a AniList; vn a VNDB.
// "reading" se deja fuera a propósito: no hay confirmación de que el contentId de un log de lectura
// corresponda a un ID de AniList (podría ser cualquier texto/libro), así que en vez de arriesgar un
// match incorrecto, se trata como "sin dato" (ver fetchGenresForLoggedContent) y el tag no bloquea.
const GENRE_SOURCE_BY_TYPE = {
  anime: "anilist",
  manga: "anilist-manga",
  vn: "vndb"
};

async function fetchAnilistGenres(contentId, anilistType) {
  const query = `
    query ($id: Int, $type: MediaType) {
      Media(id: $id, type: $type) {
        genres
      }
    }
  `;
  const { data } = await postAnilist({
    query,
    variables: { id: Number(contentId), type: anilistType }
  });
  return data?.data?.Media?.genres || [];
}

async function fetchVndbGenres(contentId) {
  const vndbId = toVndbId(contentId);
  const { data } = await axios.post(`${VNDB_API}/vn`, {
    filters: ["id", "=", vndbId],
    fields: "tags.name, tags.category"
  });
  const vn = data?.results?.[0];
  // "cont" = tags de contenido/tema, lo más parecido a un género.
  return (vn?.tags || []).filter(t => t.category === "cont").map(t => t.name);
}

// Trae (y cachea) el género real de lo que la persona logueó, para comparar contra el tag del reto.
// Devuelve null cuando no hay forma confiable de saberlo (tipo sin catálogo, sin contentId, o falla
// la API externa) — en ese caso el caller no debe bloquear a la persona por una limitación nuestra.
async function fetchGenresForLoggedContent(db, type, contentId) {
  const source = GENRE_SOURCE_BY_TYPE[type];
  if (!source || !contentId) return null;

  const cacheId = `log-genre:${type}:${contentId}`;
  const cached = await db.findOne({ _id: cacheId });
  if (cached) return cached.genres || [];

  let genres;
  try {
    if (source === "vndb") {
      genres = await fetchVndbGenres(contentId);
    } else {
      genres = await fetchAnilistGenres(contentId, source === "anilist-manga" ? "MANGA" : "ANIME");
    }
  } catch (err) {
    console.error(`[characters] Error trayendo género real de ${type}:${contentId}:`, err.response?.data || err.message);
    return null;
  }

  await db.updateOne(
    { _id: cacheId },
    { $set: { kind: "logGenreCache", type, contentId: String(contentId), genres, fetchedAt: new Date() } },
    { upsert: true }
  );

  return genres;
}

async function fetchUserLogsSince(username, sinceDate) {
  const logs = [];
  const limit = 100;

  for (let page = 1; page <= 20; page++) {
    const { data } = await axios.get(`${API_BASE}/users/${encodeURIComponent(username)}/logs`, {
      params: { page, limit }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    logs.push(...data);

    // Los logs vienen ordenados del más reciente al más viejo; si ya vimos uno creado antes del
    // evento, no hace falta seguir paginando.
    const oldest = data[data.length - 1];
    const oldestCreatedAt = objectIdTimestamp(oldest._id);
    if (data.length < limit || (oldestCreatedAt && oldestCreatedAt < sinceDate)) break;
  }

  return logs;
}

// Revisa el progreso de todos los miembros linkeados contra el reto activo. Devuelve
// { discordId, username, completedAt } del primero en cumplir, o null si nadie lo ha logrado aún.
async function checkEventProgress(db, event) {
  const linkedUsers = await db.find({ nihongoUsername: { $exists: true, $ne: null } }).toArray();
  const field = LOG_FIELD_BY_CONTENT_TYPE[event.challenge.contentType];
  const startAt = new Date(event.startAt);

  let winner = null;

  for (const user of linkedUsers) {
    const logs = await fetchUserLogsSince(user.nihongoUsername, startAt).catch(() => []);

    const relevant = logs
      .map(log => ({ log, createdAt: objectIdTimestamp(log._id) }))
      .filter(({ log, createdAt }) =>
        createdAt && createdAt >= startAt &&
        log.type === event.challenge.contentType &&
        Number(log[field]) > 0
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    if (relevant.length === 0) continue;

    let running = 0;
    let completedAt = null;

    for (const { log, createdAt } of relevant) {
      if (event.challenge.tag !== "general") {
        const contentId = log.mediaId || log.mediaData?.contentId;
        const genres = await fetchGenresForLoggedContent(db, log.type, contentId).catch(() => null);

        // null = no pudimos determinar el género real (tipo sin catálogo, falta contentId, o falló
        // la API externa). No penalizamos a la persona por eso: se cuenta como si cumpliera.
        const matchesGenre = genres === null || mapGenresToTag(genres) === event.challenge.tag;
        if (!matchesGenre) continue;
      }

      running += Number(log[field]) || 0;
      if (running >= event.challenge.amount) {
        completedAt = createdAt;
        break;
      }
    }

    if (completedAt && (!winner || completedAt < winner.completedAt)) {
      winner = { discordId: user.discordId, username: user.nihongoUsername, completedAt };
    }
  }

  return winner;
}

async function completeEvent(db, event, winner) {
  await db.updateOne(
    { _id: event._id },
    { $set: { status: "completed", winnerDiscordId: winner.discordId, completedAt: new Date() } }
  );

  await db.updateOne(
    { _id: `character-owned:${event.characterId}` },
    {
      $set: {
        kind: "characterOwned",
        characterId: event.characterId,
        discordId: winner.discordId,
        eventId: event._id,
        wonAt: new Date()
      }
    },
    { upsert: true }
  );

  await db.updateOne({ _id: event.characterId }, { $set: { claimed: true } });
}

async function expireEvent(db, event) {
  await db.updateOne({ _id: event._id }, { $set: { status: "expired", expiredAt: new Date() } });
  // El personaje NO se marca como claimed: vuelve al pool y puede volver a salir otro día.
}

// ================= TESTING / ADMIN =================

// Genera un evento de personaje sin pasar por el gate de "una vez al día" ni el sorteo de 1/5.
// Pensado para pruebas manuales. No toca character-event:state, así que no interfiere con el
// sorteo real del día. Si se pasan workType/workContentId, restringe a esa obra específica.
async function forceSpawnEvent(db, { workType, workContentId } = {}) {
  await ensureEligibleWorksFresh(db);
  let works = await getEligibleWorks(db);
  if (works.length === 0) return null;

  if (workType && workContentId) {
    works = works.filter(w => w.type === workType && String(w.contentId) === String(workContentId));
    if (works.length === 0) return null;
  }

  const shuffled = [...works].sort(() => Math.random() - 0.5);
  const todayParts = getTodaySpainDateParts();
  const window = buildWindow(todayParts);

  for (const work of shuffled) {
    const genres = await ensureCharacterCatalog(db, work);
    const candidates = await db.find({
      kind: "character",
      claimed: false,
      workType: work.type,
      workContentId: work.contentId
    }).toArray();

    if (candidates.length === 0) continue;

    const character = candidates[randomInt(0, candidates.length - 1)];
    const challenge = generateChallenge(character.role);
    const tag = mapGenresToTag(genres);

    const eventDoc = {
      _id: `character-event:${randomUUID().split("-")[0]}`,
      kind: "dailyCharacterEvent",
      status: "active",
      characterId: character._id,
      characterName: character.name,
      characterImage: character.image,
      characterRole: character.role,
      workTitle: work.title,
      workType: work.type,
      workContentId: work.contentId,
      challenge: { ...challenge, tag },
      startAt: window.startAt,
      deadline: window.endAt,
      channelId: null,
      messageId: null,
      winnerDiscordId: null,
      createdAt: new Date(),
      test: true
    };

    await db.insertOne(eventDoc);
    return eventDoc;
  }

  return null;
}

export default {
  TYPE_LABELS,
  refreshEligibleWorks,
  ensureEligibleWorksFresh,
  getEligibleWorks,
  rollDailyEvent,
  forceSpawnEvent,
  getActiveEvent,
  setEventMessage,
  checkEventProgress,
  completeEvent,
  expireEvent,
  objectIdTimestamp
};
