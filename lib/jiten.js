import axios from "axios";

// Confirmado contra el swagger real de Jiten (ver dump-jiten-api.mjs / dump-jiten-sample.mjs).
// No hay forma de confirmar el dominio real desde este entorno sin red — ajusta con
// JITEN_API_BASE si tu instancia no es esta.
const JITEN_API_BASE = process.env.JITEN_API_BASE || "https://api.jiten.moe";

// GET /api/media-deck/by-link-id/{linkType}/{id} — path params, no query string.
// Devuelve un array de deckId (enteros planos), no de objetos.
const BY_LINK_ID_PATH = (linkType, id) => `/api/media-deck/by-link-id/${linkType}/${encodeURIComponent(id)}`;

// GET /api/media-deck/{id}/detail — devuelve { data: { parentDeck, mainDeck, subDecks } | null, ... }.
// parentDeck/mainDeck/subDecks son DeckDto, que trae genres (number[]) y tags ({tagId,name,percentage}[]).
const DECK_DETAIL_PATH = id => `/api/media-deck/${encodeURIComponent(id)}/detail`;

// GET /api/media-deck/get-media-decks — params: mediaType, genres, tags, offset (entre otros).
// Devuelve { data: DeckDto[], totalItems, pageSize, currentOffset }. No hay parámetro de
// pageSize/limit — cada página trae un tamaño fijo (50, confirmado en vivo) y se pagina con offset.
const GET_MEDIA_DECKS_PATH = "/api/media-deck/get-media-decks";

// Confirmado en components.schemas.LinkType del swagger: Web=1, Vndb=2, Tmdb=3, Anilist=4, Mal=5, ...
const LINK_TYPE = { anilist: 4, vndb: 2 };

// NihongoTracker guarda contentId de anime/manga = id de AniList, y de vn = id de VNDB (sin el
// prefijo "v"). "reading"/"light novel" quedan fuera a propósito: no hay confirmación de que su
// contentId corresponda a un link resoluble en Jiten — se tratan como "sin dato" (ver
// logMatchesChallengeFilter), no bloquean al usuario.
const NIHONGOTRACKER_TYPE_TO_LINK_TYPE = {
  anime: LINK_TYPE.anilist,
  manga: LINK_TYPE.anilist,
  vn: LINK_TYPE.vndb
};

// Resuelve un log de NihongoTracker (type + contentId de AniList/VNDB) al id de deck de Jiten
// correspondiente. Devuelve null si no se pudo resolver (tipo sin link confiable, la obra no
// existe en Jiten, o falló la request).
async function resolveDeckIdForLog(type, contentId) {
  const linkType = NIHONGOTRACKER_TYPE_TO_LINK_TYPE[type];
  if (!linkType || !contentId) return null;

  try {
    const { data } = await axios.get(`${JITEN_API_BASE}${BY_LINK_ID_PATH(linkType, contentId)}`);
    if (!Array.isArray(data) || data.length === 0) return null;

    // Confirmado: la respuesta es un array de deckId (enteros planos). Si el link matchea más de
    // un deck (no debería pasar para AniList/VNDB, pero por si acaso) se usa el primero.
    const deckId = data[0];
    return typeof deckId === "number" ? deckId : Number(deckId?.deckId ?? deckId?.id ?? deckId) || null;
  } catch (err) {
    // 404 es esperado (la obra simplemente no está en Jiten) — no es un error a loguear.
    if (err.response?.status !== 404) {
      console.error(`[jiten] Error resolviendo by-link-id para ${type}:${contentId}:`, err.response?.status || err.message);
    }
    return null;
  }
}

function idsFromDeckDto(deck) {
  if (!deck) return { genreIds: [], tagIds: [] };
  const genreIds = (deck.genres || []).map(g => String(g));
  const tagIds = (deck.tags || []).map(t => String(t?.tagId ?? t));
  return { genreIds, tagIds };
}

// Trae el DeckDto "raíz" (mainDeck, o parentDeck si el id resuelto fuera un subdeck) de un deck de
// Jiten por su id. Devuelve null si no se pudo traer.
async function fetchRootDeckDto(deckId) {
  try {
    const { data } = await axios.get(`${JITEN_API_BASE}${DECK_DETAIL_PATH(deckId)}`);
    const detail = data?.data;
    if (!detail) {
      console.warn(`[jiten] /media-deck/${deckId}/detail no devolvió datos (deck inexistente?).`);
      return null;
    }

    const source = detail.mainDeck || detail.parentDeck || null;
    if (!source) {
      console.warn(`[jiten] /media-deck/${deckId}/detail no trajo mainDeck ni parentDeck. Respuesta cruda:`, JSON.stringify(detail).slice(0, 300));
      return null;
    }

    return source;
  } catch (err) {
    console.error(`[jiten] Error trayendo detalle del deck ${deckId}:`, err.response?.status || err.message);
    return null;
  }
}

// Trae género/tags reales de un deck de Jiten por su id. Devuelve { genreIds: string[], tagIds: string[] }.
async function fetchDeckGenreTags(deckId) {
  return idsFromDeckDto(await fetchRootDeckDto(deckId));
}

// Resuelve un log de NihongoTracker (type + contentId de AniList/VNDB) directo a { title, image }
// vía Jiten. Se usa como respaldo cuando la fuente "oficial" (AniList/VNDB directo) falla o no
// trae título — Jiten ya tiene que resolver el mismo link para sacar género/tag, así que
// reutilizarlo para el título es prácticamente gratis. Devuelve null si no se pudo resolver.
async function resolveTitleForLog(type, contentId) {
  const deckId = await resolveDeckIdForLog(type, contentId);
  if (deckId === null) return null;

  const deck = await fetchRootDeckDto(deckId);
  if (!deck) return null;

  const title = deck.englishTitle || deck.romajiTitle || deck.originalTitle || null;
  if (!title) return null;

  return { title, image: deck.coverName || null };
}

// Cachea en Mongo el deck (y sus géneros/tags) resuelto para un type:contentId de NihongoTracker,
// para no pegarle a Jiten en cada tick del poll (60s, por cada usuario linkeado).
async function getCachedDeckInfo(db, type, contentId) {
  const cacheId = `jiten-deck:${type}:${contentId}`;
  const cached = await db.findOne({ _id: cacheId });
  if (cached) return cached;

  const deckId = await resolveDeckIdForLog(type, contentId);

  let genreIds = [];
  let tagIds = [];
  if (deckId !== null) {
    ({ genreIds, tagIds } = await fetchDeckGenreTags(deckId));
  }

  const doc = {
    _id: cacheId,
    kind: "jitenDeckCache",
    type,
    contentId: String(contentId),
    deckId,
    genreIds,
    tagIds,
    fetchedAt: new Date()
  };
  await db.updateOne({ _id: cacheId }, { $set: doc }, { upsert: true });
  return doc;
}

// Verifica si lo que la persona logueó (type + contentId de NihongoTracker) cumple el filtro
// género/tag de un reto (jitenFilter = { kind: "genre"|"tag", id }). Devuelve:
//  - null  si no hay forma confiable de saberlo (tipo sin link, obra no encontrada en Jiten, o
//          falló la API) — el caller NO debe penalizar a la persona por esto.
//  - true / false si sí se pudo verificar.
// jitenFilter === null/undefined significa "reto general, sin filtro" -> siempre null (no aplica).
async function logMatchesChallengeFilter(db, type, contentId, jitenFilter) {
  if (!jitenFilter) return null;
  if (!NIHONGOTRACKER_TYPE_TO_LINK_TYPE[type] || !contentId) return null;

  const info = await getCachedDeckInfo(db, type, contentId);
  if (info.deckId === null) return null;

  const ids = jitenFilter.kind === "genre" ? info.genreIds : info.tagIds;
  return ids.includes(String(jitenFilter.id));
}

// Lista decks del catálogo de Jiten que matchean un mediaTypeId (+ opcionalmente un género/tag),
// paginando con offset hasta juntar `limit` decks o agotar los resultados. Usado por
// /obras-del-reto para mostrar qué obras cuentan para el reto activo, sin depender de qué haya
// logueado el club hasta ahora.
async function listDecksForJitenFilter(mediaTypeId, jitenFilter, { limit = 150 } = {}) {
  const params = { mediaType: mediaTypeId };
  if (jitenFilter?.kind === "genre") params.genres = jitenFilter.id;
  if (jitenFilter?.kind === "tag") params.tags = jitenFilter.id;

  const results = [];
  let offset = 0;

  try {
    while (results.length < limit) {
      const { data } = await axios.get(`${JITEN_API_BASE}${GET_MEDIA_DECKS_PATH}`, { params: { ...params, offset } });
      const items = data?.data || [];
      if (items.length === 0) break;

      for (const d of items) {
        results.push({
          title: d.englishTitle || d.romajiTitle || d.originalTitle || "???",
          image: d.coverName || null
        });
      }

      offset += items.length;
      if (offset >= (data?.totalItems ?? offset)) break;
    }
  } catch (err) {
    console.error(`[jiten] Error listando decks para mediaTypeId=${mediaTypeId}:`, err.response?.status || err.message);
  }

  return results.slice(0, limit);
}

export default {
  logMatchesChallengeFilter,
  listDecksForJitenFilter,
  resolveTitleForLog
};
