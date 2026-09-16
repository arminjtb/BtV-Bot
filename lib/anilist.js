// Cliente de la API de AniList (GraphQL v2): queries de usuario/lista, horarios de emisión,
// búsqueda y las mutations para escribir en la lista del usuario.
//
// CommonJS a propósito — mismo criterio que lib/coImmersion.js y lib/torboxDownloads.js: así lo
// pueden requerir tanto los archivos CJS (commands/slash/log.js) como importarlo los ESM.
//
// Este archivo NO toca la base de datos ni discord.js: sólo habla con AniList. Lo que se guarda
// vive en lib/anilistStore.js.

const axios = require("axios");

const GRAPHQL_URL = "https://graphql.anilist.co";
const OAUTH_AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";
const OAUTH_TOKEN_URL = "https://anilist.co/api/v2/oauth/token";

// AniList soporta el flujo "Authorization Code" con un redirect especial que, en vez de redirigir
// a un servidor tuyo, muestra el código en pantalla para copiarlo a mano (PIN). Es el único flujo
// que sirve para un bot sin servidor web expuesto, y es lo que usa /anilist autorizar.
const PIN_REDIRECT_URI = "https://anilist.co/api/v2/oauth/pin";

// AniList permite 90 req/min (a veces degradado a 30). Se mandan en una sola cola secuencial con
// espaciado mínimo para no depender de la suerte, y si aun así responde 429 se respeta Retry-After.
const MIN_INTERVAL_MS = 750;
const MAX_RETRIES = 3;

let queue = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isConfigured() {
  return Boolean(process.env.ANILIST_CLIENT_ID && process.env.ANILIST_CLIENT_SECRET);
}

// Toda request a AniList pasa por aquí: se encola, se espacia y se reintenta ante 429/5xx.
async function request(query, variables = {}, accessToken = null) {
  const run = async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      try {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json"
        };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

        const { data } = await axios.post(
          GRAPHQL_URL,
          { query, variables },
          { headers, timeout: 20000 }
        );

        if (Array.isArray(data?.errors) && data.errors.length) {
          const err = new Error(data.errors[0]?.message || "Error de AniList");
          err.anilistErrors = data.errors;
          err.status = data.errors[0]?.status;
          throw err;
        }

        return data?.data;
      } catch (err) {
        const status = err.response?.status;

        // 429: AniList dice cuántos segundos esperar. 500/502/503: hipo del servidor, se reintenta.
        if ((status === 429 || (status >= 500 && status < 600)) && attempt < MAX_RETRIES) {
          const retryAfter = Number(err.response?.headers?.["retry-after"]);
          await sleep(Number.isFinite(retryAfter) ? (retryAfter + 1) * 1000 : 2000 * (attempt + 1));
          continue;
        }

        // Los errores de GraphQL (404 usuario inexistente, 400 query mal formada) no se reintentan.
        if (err.anilistErrors) throw err;

        const wrapped = new Error(
          err.response?.data?.errors?.[0]?.message || err.message || "Error de red con AniList"
        );
        wrapped.status = status;
        throw wrapped;
      }
    }
  };

  // Encadena en la cola global para que dos loops (notificador + comandos) no se pisen.
  const result = queue.then(run, run);
  queue = result.then(() => {}, () => {});
  return result;
}

// ─── Fragmentos reutilizables ────────────────────────────────────────────────

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large color }
  bannerImage
  episodes
  duration
  format
  status
  genres
  siteUrl
  averageScore
  popularity
  countryOfOrigin
  isAdult
  season
  seasonYear
  studios(isMain: true) { nodes { name } }
  externalLinks { site url type }
  nextAiringEpisode { episode airingAt }
`;

// ─── Usuario ─────────────────────────────────────────────────────────────────

// Resuelve un nombre de usuario de AniList. Devuelve null si no existe (404 de GraphQL).
async function fetchUserByName(userName) {
  const query = `
    query ($name: String) {
      User(name: $name) {
        id
        name
        siteUrl
        avatar { large medium }
        options { profileColor }
        statistics { anime { count episodesWatched minutesWatched } }
      }
    }
  `;

  try {
    const data = await request(query, { name: userName });
    return data?.User || null;
  } catch (err) {
    if (err.status === 404 || /not found/i.test(err.message)) return null;
    throw err;
  }
}

// El usuario dueño del token. Sirve para validar que el token pegado en el DM es real.
async function fetchViewer(accessToken) {
  const query = `
    query {
      Viewer {
        id
        name
        siteUrl
        avatar { large medium }
      }
    }
  `;
  const data = await request(query, {}, accessToken);
  return data?.Viewer || null;
}

// Trae la lista de anime del usuario en los estados pedidos. Devuelve un mapa
// { PLANNING: [mediaId...], CURRENT: [...] } más un índice plano id -> status.
// Funciona sin token si la lista es pública; con token también lee listas privadas.
async function fetchAnimeList(userName, statuses = ["PLANNING", "CURRENT"], accessToken = null) {
  const query = `
    query ($name: String, $statuses: [MediaListStatus]) {
      MediaListCollection(userName: $name, type: ANIME, status_in: $statuses, forceSingleCompletedList: true) {
        lists {
          status
          entries {
            id
            status
            progress
            media {
              id
              status
              title { romaji english native }
              nextAiringEpisode { episode airingAt }
            }
          }
        }
      }
    }
  `;

  const data = await request(query, { name: userName, statuses }, accessToken);
  const lists = data?.MediaListCollection?.lists || [];

  const byStatus = {};
  const index = {};

  for (const list of lists) {
    for (const entry of list.entries || []) {
      const status = entry.status || list.status;
      const mediaId = entry.media?.id;
      if (!mediaId) continue;

      (byStatus[status] ||= []).push(mediaId);
      index[mediaId] = { status, progress: entry.progress || 0, entryId: entry.id };
    }
  }

  // Una entrada puede aparecer en varias listas personalizadas del usuario; sin esto saldría
  // duplicada en los conteos de /anilist perfil.
  for (const status of Object.keys(byStatus)) {
    byStatus[status] = [...new Set(byStatus[status])];
  }

  return { byStatus, index };
}

// ─── Horarios de emisión ─────────────────────────────────────────────────────

// Todos los episodios que salen (o salieron) entre dos timestamps UNIX, con la media completa.
// Pagina hasta agotar; el rango típico de uso es de minutos u horas, así que son 1-2 páginas.
async function fetchAiringBetween(startUnix, endUnix, { maxPages = 12 } = {}) {
  const query = `
    query ($start: Int, $end: Int, $page: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage currentPage }
        airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
          id
          episode
          airingAt
          media { ${MEDIA_FIELDS} }
        }
      }
    }
  `;

  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const data = await request(query, { start: startUnix, end: endUnix, page });
    const pageData = data?.Page;
    results.push(...(pageData?.airingSchedules || []));
    if (!pageData?.pageInfo?.hasNextPage) break;
    page++;
  }

  return results;
}

// Igual que fetchAiringBetween pero con campos mínimos: se usa para el /calendario, donde se
// piden 7 días completos (cientos de entradas) y no hacen falta descripción ni banner.
async function fetchWeekSchedule(startUnix, endUnix, { maxPages = 20 } = {}) {
  const query = `
    query ($start: Int, $end: Int, $page: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
          episode
          airingAt
          media {
            id
            title { romaji english native }
            format
            episodes
            siteUrl
            coverImage { large color }
            averageScore
            popularity
            countryOfOrigin
            isAdult
          }
        }
      }
    }
  `;

  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const data = await request(query, { start: startUnix, end: endUnix, page });
    results.push(...(data?.Page?.airingSchedules || []));
    if (!data?.Page?.pageInfo?.hasNextPage) break;
    page++;
  }

  return results;
}

// Una media puntual por id — para el botón "Añadir a planning" cuando el embed original ya no
// tiene los datos a mano.
async function fetchMedia(mediaId) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} }
    }
  `;
  const data = await request(query, { id: Number(mediaId) });
  return data?.Media || null;
}

// Búsqueda por texto, para el autocomplete de /calendario y comandos futuros.
async function searchAnime(search, perPage = 10) {
  const query = `
    query ($search: String, $perPage: Int) {
      Page(perPage: $perPage) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          title { romaji english native }
          format
          seasonYear
        }
      }
    }
  `;
  const data = await request(query, { search, perPage });
  return data?.Page?.media || [];
}

// ─── Escritura en la lista del usuario (requiere token) ──────────────────────

// Estado actual de una media en la lista del usuario autenticado. null = no está en su lista.
async function fetchListEntry(accessToken, userId, mediaId) {
  const query = `
    query ($userId: Int, $mediaId: Int) {
      MediaList(userId: $userId, mediaId: $mediaId, type: ANIME) {
        id
        status
        progress
      }
    }
  `;

  try {
    const data = await request(query, { userId: Number(userId), mediaId: Number(mediaId) }, accessToken);
    return data?.MediaList || null;
  } catch (err) {
    if (err.status === 404 || /not found/i.test(err.message)) return null;
    throw err;
  }
}

async function saveListEntry(accessToken, { mediaId, status, progress }) {
  const query = `
    mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress) {
        id
        status
        progress
        media { id title { romaji english } siteUrl }
      }
    }
  `;

  const variables = { mediaId: Number(mediaId) };
  if (status) variables.status = status;
  if (Number.isFinite(progress)) variables.progress = progress;

  const data = await request(query, variables, accessToken);
  return data?.SaveMediaListEntry || null;
}

// ─── OAuth (flujo PIN) ───────────────────────────────────────────────────────

function buildAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: process.env.ANILIST_CLIENT_ID || "",
    redirect_uri: PIN_REDIRECT_URI,
    response_type: "code"
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// Cambia el PIN que el usuario pegó en el DM por un access token (dura 1 año).
async function exchangeCodeForToken(code) {
  const { data } = await axios.post(
    OAUTH_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: process.env.ANILIST_CLIENT_ID,
      client_secret: process.env.ANILIST_CLIENT_SECRET,
      redirect_uri: PIN_REDIRECT_URI,
      code
    },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeout: 20000
    }
  );

  if (!data?.access_token) throw new Error("AniList no devolvió un access_token.");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    // expires_in viene en segundos (≈ 1 año).
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null
  };
}

// ─── Helpers de presentación ─────────────────────────────────────────────────

function pickTitle(media) {
  return (
    media?.title?.romaji ||
    media?.title?.english ||
    media?.title?.native ||
    `Anime #${media?.id}`
  );
}

function altTitle(media) {
  const main = pickTitle(media);
  const candidates = [media?.title?.english, media?.title?.native].filter(Boolean);
  return candidates.find(t => t !== main) || null;
}

// Las descripciones de AniList llegan con entidades HTML sueltas (&iacute;, &mdash;, &#039;).
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "'", lsquo: "'",
  ldquo: '"', rdquo: '"', deg: "°", eacute: "é", egrave: "è",
  aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", ouml: "ö", auml: "ä", szlig: "ß",
  ccedil: "ç", iquest: "¿", iexcl: "¡", trade: "™", copy: "©", reg: "®"
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name] ?? match);
}

// Las descripciones de AniList vienen con HTML embebido (<br>, <i>, <spoiler>).
function cleanDescription(description, maxLength = 350) {
  if (!description) return null;

  const text = decodeEntities(
    String(description)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) return null;
  if (text.length <= maxLength) return text;

  // Corta en el último espacio para no partir una palabra a la mitad.
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

const FORMAT_LABELS = {
  TV: "TV",
  TV_SHORT: "TV corto",
  MOVIE: "Película",
  SPECIAL: "Especial",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Música"
};

function formatLabel(format) {
  return FORMAT_LABELS[format] || format || "Anime";
}

module.exports = {
  isConfigured,
  request,
  fetchUserByName,
  fetchViewer,
  fetchAnimeList,
  fetchAiringBetween,
  fetchWeekSchedule,
  fetchMedia,
  searchAnime,
  fetchListEntry,
  saveListEntry,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  pickTitle,
  altTitle,
  cleanDescription,
  formatLabel,
  PIN_REDIRECT_URI
};
