// Persistencia y lógica de la integración con AniList. Todo vive en la colección compartida del
// bot (client.db) discriminando por `kind`, mismo patrón que lib/readathon.js, lib/coImmersion.js
// y lib/torboxDownloads.js.
//
// CommonJS a propósito — ver lib/coImmersion.js.
//
// Documentos que maneja:
//   kind: "anilistUser"    _id: anilist:user:<discordId>   — vínculo de un miembro con su cuenta
//   kind: "anilistGuild"   _id: anilist:guild:<guildId>    — canal y config de avisos del servidor
//   kind: "anilistAnn"     _id: anilist:ann:<guild>:<media>:<ep> — antiduplicados de avisos
//   kind: "anilistState"   _id: anilist:state              — hasta dónde revisó el notificador

const anilist = require("./anilist.js");

const USER_ID = discordId => `anilist:user:${discordId}`;
const GUILD_ID = guildId => `anilist:guild:${guildId}`;
const ANN_ID = (guildId, mediaId, episode) => `anilist:ann:${guildId}:${mediaId}:${episode}`;
const STATE_ID = "anilist:state";

// Cada cuánto se refresca la lista de planning de cada miembro desde AniList.
const LIST_TTL_MS = 30 * 60 * 1000;

// Los docs antidupĺicados sólo sirven para no repetir un aviso; a los 30 días son basura.
const ANNOUNCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  channelId: null,
  // "always"  → se anuncian TODOS los estrenos (ep. 1) aunque nadie los tenga en planning
  // "planning"→ sólo los estrenos que alguien tenga en su lista
  // "off"     → nada de estrenos
  premiereMode: "always",
  // Avisos de episodios que no son el 1: siempre requieren que alguien lo tenga en lista,
  // si no el canal sería ilegible (salen ~300 episodios por semana).
  episodesEnabled: true,
  // Filtros aplicados sólo a los estrenos que NADIE tiene en lista (los que sí, pasan siempre).
  countries: ["JP"],
  minPopularity: 1500,
  allowAdult: false,
  timeZone: "America/Mexico_City",
  // Rol opcional al que se hace ping en cada estreno (aparte de las menciones individuales).
  premiereRoleId: null
};

// ─── Usuarios ────────────────────────────────────────────────────────────────

async function getUser(db, discordId) {
  return db.findOne({ _id: USER_ID(discordId) });
}

async function getAllUsers(db) {
  return db.find({ kind: "anilistUser" }).toArray();
}

async function linkUser(db, discordId, { anilistId, anilistName, avatar, siteUrl }) {
  await db.updateOne(
    { _id: USER_ID(discordId) },
    {
      $set: {
        kind: "anilistUser",
        discordId,
        anilistId,
        anilistName,
        avatar: avatar || null,
        siteUrl: siteUrl || null,
        linkedAt: new Date()
      },
      // La lista se sincroniza aparte; al re-vincular se invalida la cache.
      $unset: { listSyncedAt: "", planning: "", current: "", listError: "" }
    },
    { upsert: true }
  );

  return getUser(db, discordId);
}

// El token de escritura se guarda sobre el mismo doc: se puede estar vinculado (sólo lectura) sin
// haber autorizado nunca, y autorizar después.
async function setUserToken(db, discordId, { accessToken, refreshToken, expiresAt }) {
  await db.updateOne(
    { _id: USER_ID(discordId) },
    {
      $set: {
        kind: "anilistUser",
        discordId,
        accessToken,
        refreshToken: refreshToken || null,
        tokenExpiresAt: expiresAt || null,
        authorizedAt: new Date()
      }
    },
    { upsert: true }
  );

  return getUser(db, discordId);
}

async function clearUserToken(db, discordId) {
  await db.updateOne(
    { _id: USER_ID(discordId) },
    { $unset: { accessToken: "", refreshToken: "", tokenExpiresAt: "", authorizedAt: "" } }
  );
}

async function unlinkUser(db, discordId) {
  const result = await db.deleteOne({ _id: USER_ID(discordId) });
  return result.deletedCount > 0;
}

function hasWriteAccess(user) {
  if (!user?.accessToken) return false;
  if (user.tokenExpiresAt && new Date(user.tokenExpiresAt).getTime() < Date.now()) return false;
  return true;
}

// ─── Sincronización de listas ────────────────────────────────────────────────

// Baja planning + viendo de un usuario y lo cachea en su doc. `force` ignora el TTL.
async function syncUserList(db, user, { force = false } = {}) {
  if (!user?.anilistName) return user;

  const fresh = user.listSyncedAt && Date.now() - new Date(user.listSyncedAt).getTime() < LIST_TTL_MS;
  if (fresh && !force) return user;

  try {
    // Si autorizó, se usa su token para poder leer también listas privadas.
    const token = hasWriteAccess(user) ? user.accessToken : null;
    const { byStatus } = await anilist.fetchAnimeList(user.anilistName, ["PLANNING", "CURRENT"], token);

    const planning = byStatus.PLANNING || [];
    const current = byStatus.CURRENT || [];

    await db.updateOne(
      { _id: USER_ID(user.discordId) },
      {
        $set: { planning, current, listSyncedAt: new Date() },
        $unset: { listError: "" }
      }
    );

    return { ...user, planning, current, listSyncedAt: new Date() };
  } catch (err) {
    // Una lista privada o un usuario renombrado no debe tumbar el loop del notificador.
    await db.updateOne(
      { _id: USER_ID(user.discordId) },
      { $set: { listError: err.message, listSyncedAt: new Date() } }
    );
    console.error(`[anilist] No pude sincronizar la lista de ${user.anilistName}:`, err.message);
    return { ...user, listError: err.message };
  }
}

async function syncAllLists(db, { force = false } = {}) {
  const users = await getAllUsers(db);
  const synced = [];

  // Secuencial a propósito: lib/anilist.js ya encola, pero así tampoco se dispara una ráfaga de
  // promesas si el club crece a 50 miembros.
  for (const user of users) {
    synced.push(await syncUserList(db, user, { force }));
  }

  return synced;
}

// Devuelve { planning: [discordId], current: [discordId] } para una media concreta.
function findInterestedUsers(users, mediaId) {
  const id = Number(mediaId);
  const planning = [];
  const current = [];

  for (const user of users) {
    if ((user.current || []).includes(id)) current.push(user.discordId);
    else if ((user.planning || []).includes(id)) planning.push(user.discordId);
  }

  return { planning, current, all: [...current, ...planning] };
}

// ─── Configuración por servidor ──────────────────────────────────────────────

async function getGuildConfig(db, guildId) {
  const doc = await db.findOne({ _id: GUILD_ID(guildId) });
  return { ...DEFAULT_CONFIG, ...(doc || {}), guildId };
}

async function setGuildConfig(db, guildId, patch) {
  await db.updateOne(
    { _id: GUILD_ID(guildId) },
    { $set: { kind: "anilistGuild", guildId, ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
  return getGuildConfig(db, guildId);
}

async function getConfiguredGuilds(db) {
  const docs = await db.find({ kind: "anilistGuild", channelId: { $ne: null } }).toArray();
  return docs.map(doc => ({ ...DEFAULT_CONFIG, ...doc }));
}

// ─── Antiduplicados ──────────────────────────────────────────────────────────

// insertOne + catch de duplicate key: es atómico, así que aunque dos ticks del loop se solapen
// sólo uno gana y el aviso sale una vez.
async function claimAnnouncement(db, guildId, mediaId, episode) {
  try {
    await db.insertOne({
      _id: ANN_ID(guildId, mediaId, episode),
      kind: "anilistAnn",
      guildId,
      mediaId: Number(mediaId),
      episode: Number(episode),
      createdAt: new Date()
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // ya se anunció
    throw err;
  }
}

async function pruneAnnouncements(db) {
  await db.deleteMany({
    kind: "anilistAnn",
    createdAt: { $lt: new Date(Date.now() - ANNOUNCE_TTL_MS) }
  });
}

// ─── Estado del notificador ──────────────────────────────────────────────────

async function getState(db) {
  return (await db.findOne({ _id: STATE_ID })) || {};
}

async function setState(db, patch) {
  await db.updateOne(
    { _id: STATE_ID },
    { $set: { kind: "anilistState", ...patch } },
    { upsert: true }
  );
}

// ─── Filtros de estreno ──────────────────────────────────────────────────────

// Decide si un estreno que NADIE tiene en su lista merece anunciarse. Los que sí tiene alguien
// se saltan este filtro por completo.
function passesPremiereFilter(media, config) {
  if (!media) return false;
  if (media.isAdult && !config.allowAdult) return false;

  const countries = config.countries || [];
  if (countries.length && media.countryOfOrigin && !countries.includes(media.countryOfOrigin)) {
    return false;
  }

  const minPopularity = Number(config.minPopularity) || 0;
  if (minPopularity && (media.popularity || 0) < minPopularity) return false;

  return true;
}

module.exports = {
  DEFAULT_CONFIG,
  getUser,
  getAllUsers,
  linkUser,
  setUserToken,
  clearUserToken,
  unlinkUser,
  hasWriteAccess,
  syncUserList,
  syncAllLists,
  findInterestedUsers,
  getGuildConfig,
  setGuildConfig,
  getConfiguredGuilds,
  claimAnnouncement,
  pruneAnnouncements,
  getState,
  setState,
  passesPremiereFilter
};
