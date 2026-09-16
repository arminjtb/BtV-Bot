// Loop que vigila AniList y avisa en el canal configurado cuando sale un episodio.
//
// Dos ritmos distintos:
//   · cada 5 min  → mira qué episodios se emitieron desde la última revisión y los anuncia
//   · cada 30 min → refresca la lista de planning/viendo de cada miembro vinculado
//
// Mismo patrón de arranque que events/torboxPoller.js y events/readathon.js (clientReady + una
// bandera en el client para no duplicar intervalos si el evento se dispara dos veces).

import store from "../lib/anilistStore.js";
import anilist from "../lib/anilist.js";
import ui from "../lib/anilistUi.js";

const AIRING_POLL_MS = 5 * 60 * 1000;
const LIST_SYNC_MS = 30 * 60 * 1000;

// Si el bot estuvo caído mucho rato no tiene sentido vomitar 300 avisos atrasados: se recupera
// como máximo esta ventana hacia atrás.
const MAX_BACKFILL_MS = 6 * 60 * 60 * 1000;

// Margen entre envíos para no chocar con el rate limit de Discord al anunciar una tanda grande.
const SEND_DELAY_MS = 400;

const MAX_MENTIONS = 25;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Qué usuarios vinculados están realmente en este servidor. Se resuelve una vez por tick y se
// cachea, porque puede haber varios anuncios seguidos para el mismo guild.
async function resolveGuildMembers(guild, users) {
  const present = [];

  for (const user of users) {
    const member = await guild.members.fetch(user.discordId).catch(() => null);
    if (member) present.push(user);
  }

  return present;
}

function shouldAnnounce(schedule, interestedCount, config) {
  const isPremiere = Number(schedule.episode) === 1;

  if (interestedCount > 0) {
    if (isPremiere) return config.premiereMode !== "off";
    return config.episodesEnabled !== false;
  }

  // Nadie lo tiene en su lista: sólo se anuncian estrenos, y sólo si pasan los filtros de ruido.
  if (!isPremiere) return false;
  if (config.premiereMode !== "always") return false;
  return store.passesPremiereFilter(schedule.media, config);
}

async function announce(client, guildConfig, schedule, guildUsers) {
  const media = schedule.media;
  if (!media?.id) return false;

  const { all: interested } = store.findInterestedUsers(guildUsers, media.id);
  if (!shouldAnnounce(schedule, interested.length, guildConfig)) return false;

  const channel = await client.channels.fetch(guildConfig.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  // Se reserva el aviso ANTES de mandarlo: si el envío falla, mejor perder un aviso que mandar
  // el mismo episodio dos veces cuando el siguiente tick reintente.
  const claimed = await store
    .claimAnnouncement(client.db, guildConfig.guildId, media.id, schedule.episode)
    .catch(err => {
      console.error("[anilistNotifier] Error reservando el aviso:", err.message);
      return false;
    });
  if (!claimed) return false;

  const isPremiere = Number(schedule.episode) === 1;

  const embed = ui.buildAiringEmbed(media, {
    episode: schedule.episode,
    airingAt: schedule.airingAt,
    isPremiere,
    interested
  });

  const row = ui.buildAiringButtons(media.id, {
    episode: schedule.episode,
    siteUrl: media.siteUrl
  });

  const mentions = interested.slice(0, MAX_MENTIONS).map(id => `<@${id}>`);
  if (isPremiere && guildConfig.premiereRoleId) {
    mentions.unshift(`<@&${guildConfig.premiereRoleId}>`);
  }

  await channel.send({
    content: mentions.length ? mentions.join(" ") : undefined,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      users: interested.slice(0, MAX_MENTIONS),
      roles: isPremiere && guildConfig.premiereRoleId ? [guildConfig.premiereRoleId] : []
    }
  });

  return true;
}

async function checkAiring(client) {
  const db = client.db;
  if (!db) return;

  const guilds = await store.getConfiguredGuilds(db);
  if (!guilds.length) return;

  const state = await store.getState(db);
  const now = Math.floor(Date.now() / 1000);

  let since = state.lastAiringCheck;
  if (!since) since = now - 15 * 60;

  const minSince = now - Math.floor(MAX_BACKFILL_MS / 1000);
  if (since < minSince) {
    console.warn(`[anilistNotifier] Hueco de ${Math.round((now - since) / 3600)}h — se recortan los avisos atrasados.`);
    since = minSince;
  }

  if (since >= now) return;

  let schedules;
  try {
    // airingAt_greater/_lesser son exclusivos: el -1/+1 evita perder un episodio que cae justo
    // en el borde de la ventana.
    schedules = await anilist.fetchAiringBetween(since - 1, now + 1);
  } catch (err) {
    console.error("[anilistNotifier] Error trayendo horarios:", err.message);
    return; // no se avanza el cursor: la próxima vuelta reintenta la misma ventana
  }

  if (!schedules.length) {
    await store.setState(db, { lastAiringCheck: now, lastRunAt: new Date() });
    return;
  }

  const allUsers = await store.getAllUsers(db);
  let sent = 0;

  for (const guildConfig of guilds) {
    const guild = await client.guilds.fetch(guildConfig.guildId).catch(() => null);
    if (!guild) continue;

    const guildUsers = await resolveGuildMembers(guild, allUsers);

    for (const schedule of schedules) {
      try {
        const posted = await announce(client, guildConfig, schedule, guildUsers);
        if (posted) {
          sent++;
          await sleep(SEND_DELAY_MS);
        }
      } catch (err) {
        console.error("[anilistNotifier] Error anunciando:", err.message);
      }
    }
  }

  await store.setState(db, { lastAiringCheck: now, lastRunAt: new Date() });
  if (sent) console.log(`[anilistNotifier] ${sent} aviso(s) enviado(s).`);
}

async function syncLists(client) {
  if (!client.db) return;
  await store.syncAllLists(client.db, { force: true });
  await store.pruneAnnouncements(client.db).catch(() => {});
}

function startLoop(fn, intervalMs, firstDelayMs, label) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[anilistNotifier] Error en ${label}:`, err.message);
    } finally {
      running = false;
    }
  };

  setTimeout(run, firstDelayMs);
  return setInterval(run, intervalMs);
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.anilistNotifier) return;

    client.anilistNotifier = startLoop(
      () => checkAiring(client),
      AIRING_POLL_MS,
      15_000,
      "checkAiring"
    );

    client.anilistListSync = startLoop(
      () => syncLists(client),
      LIST_SYNC_MS,
      5_000,
      "syncLists"
    );

    console.log("[anilistNotifier] Started.");
  }
};
