import axios from "axios";
import { EmbedBuilder } from "discord.js";
import coImmersion from "../lib/coImmersion.js";

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID = "6951b8e3319c4aea0d5d2b2d";
const TARGET_CHANNEL_ID = "1499984174763741355";
const POLL_MS = 60 * 1000;
const STATE_ID = "club-log-mirror:state";
const ACTIVITY_LIMIT = 50;
const MAX_SEEN_IDS = 500;

const TYPE_COLORS = {
  reading: 0x10B981,
  anime: 0x3B82F6,
  vn: 0x8B5CF6,
  game: 0xEF4444,
  video_game: 0xEF4444,
  video: 0xF97316,
  manga: 0xF59E0B,
  audio: 0x6B7280,
  movie: 0xEC4899,
  "tv show": 0x06B6D4,
  other: 0x5865F2
};

const TYPE_LABELS = {
  reading: "📖 Lectura",
  anime: "🎌 Anime",
  vn: "🎮 Novela Visual",
  game: "🕹️ Videojuego",
  video_game: "🕹️ Videojuego",
  video: "🎞️ Video",
  manga: "📚 Manga",
  audio: "🎧 Audio",
  movie: "🎬 Película",
  "tv show": "📺 Serie",
  other: "📝 Otro"
};

function formatNumber(value) {
  return Number(value).toLocaleString("es-MX");
}

function formatTime(minutes) {
  if (minutes >= 60) return `${formatNumber(minutes)} min (${(minutes / 60).toFixed(1)}h)`;
  return `${formatNumber(minutes)} min`;
}

// Solo tiene sentido cuando hay caracteres Y tiempo registrados.
function formatSpeed(chars, minutes) {
  if (!chars || !minutes) return null;
  const perHour = chars / (minutes / 60);
  return `${formatNumber(Math.round(perHour))} car/hr`;
}

function addStat(fields, name, value, formatter = formatNumber) {
  if (!value || value <= 0) return;
  fields.push({ name, value: formatter(value), inline: true });
}

function buildLogEmbed(activity, others = []) {
  const details = activity.details ?? {};
  const metadata = activity.metadata ?? {};
  const media = details.media ?? {};
  const detailTitle =
    media.title?.contentTitleEnglish ||
    media.title?.contentTitleRomaji ||
    media.title?.contentTitleNative;
  const mediaTitle = detailTitle || activity.media?.title || activity.content || "Contenido sin título";
  const username = activity.user?.username || "Usuario desconocido";
  const apiType = details.type || media.type || activity.media?.type || "other";
  const typeLabel = TYPE_LABELS[apiType] ?? apiType;
  const fields = [];

  const chars = details.chars ?? metadata.chars;
  const time = details.time ?? metadata.time;

  addStat(fields, "📺 Episodios", details.episodes ?? metadata.episodes);
  addStat(fields, "📄 Páginas", details.pages ?? metadata.pages);
  addStat(fields, "📚 Volumen", details.volume ?? metadata.volume);
  addStat(fields, "🔤 Caracteres", chars);
  addStat(fields, "⏱️ Tiempo", time, formatTime);

  const speed = formatSpeed(chars, time);
  if (speed) fields.push({ name: "⚡ Velocidad", value: speed, inline: true });

  addStat(fields, "✨ XP", details.xp ?? metadata.xp, value => `+${formatNumber(value)}`);

  const rawTagSource = Array.isArray(details.tagLabels) ? details.tagLabels : details.tags;
  const tags = Array.isArray(rawTagSource)
    ? rawTagSource
        .map(tag => (tag && typeof tag === "object" ? tag.name : tag))
        .filter(tag => typeof tag === "string" && tag.length > 0)
    : [];
  if (tags.length > 0) {
    fields.push({ name: "🏷️ Etiquetas", value: tags.map(tag => `\`${tag}\``).join(" "), inline: false });
  }

  const coField = coImmersion.buildCoImmersionField(others, apiType);
  if (coField) fields.push(coField);

  const embed = new EmbedBuilder()
    .setColor(TYPE_COLORS[apiType] ?? 0x5865F2)
    .setAuthor({
      name: `${username} registró ${typeLabel}`,
      iconURL: activity.user?.avatar || undefined
    })
    .setTitle(mediaTitle)
    .setFooter({ text: "creado desde nihongotracker.app" })
    .setTimestamp(new Date(activity.createdAt));

  if (media.contentImage) {
    embed.setThumbnail(media.contentImage);
  }

  const description = details.description || activity.content;
  if (description) {
    embed.setDescription(description);
  }

  if (fields.length > 0) embed.addFields(fields);

  return embed;
}

async function fetchRecentLogs() {
  const { data } = await axios.get(`${API_BASE}/clubs/${CLUB_ID}/recent-activity`, {
    params: { limit: ACTIVITY_LIMIT }
  });
  const activities = Array.isArray(data?.activities) ? data.activities : [];
  return activities
    .filter(activity => activity.type === "log" && activity._id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function fetchUserLogDetails(activity) {
  const username = activity.user?.username;
  const logId = activity._id;
  if (!username || !logId) return null;

  const { data } = await axios.get(`${API_BASE}/users/${encodeURIComponent(username)}/logs`, {
    params: { page: 1, limit: 10 }
  });

  if (!Array.isArray(data)) return null;
  const log = data.find(item => String(item._id) === String(logId)) ?? null;
  if (!log) return null;

  if (!Array.isArray(log.tags) || log.tags.length === 0) return log;

  // log.tags puede venir como IDs planos ("507f...") o ya poblado
  // ({ _id, name, ... }). Si viene poblado, usamos el name directo
  // y evitamos el fetch/lookup extra.
  const rawTags = log.tags.map(tag =>
    tag && typeof tag === "object" ? { id: String(tag._id ?? ""), name: tag.name } : { id: String(tag), name: null }
  );

  const missingIds = rawTags.filter(t => !t.name).map(t => t.id).filter(Boolean);
  let tagMap = new Map();
  if (missingIds.length > 0) {
    const tags = await fetchUserTags(username).catch(() => []);
    tagMap = new Map(tags.map(tag => [String(tag._id), tag.name]));
  }

  const tagLabels = rawTags
    .map(t => t.name || tagMap.get(t.id) || t.id)
    .filter(label => typeof label === "string" && label.length > 0);

  return {
    ...log,
    tagLabels
  };
}

async function fetchUserTags(username) {
  const { data } = await axios.get(`${API_BASE}/tags/user/${encodeURIComponent(username)}`);
  return Array.isArray(data) ? data : [];
}

async function isDiscordCreatedLog(db, logId) {
  const existing = await db.findOne({ _id: `discord-log:${logId}` });
  return Boolean(existing);
}

async function wasAlreadyPosted(db, logId) {
  const existing = await db.findOne({ _id: `club-log-mirror:posted:${logId}` });
  return Boolean(existing);
}

async function rememberPostedLog(db, activity) {
  await db.updateOne(
    { _id: `club-log-mirror:posted:${activity._id}` },
    {
      $set: {
        kind: "clubLogMirrorPosted",
        logId: String(activity._id),
        userId: activity.user?._id ?? null,
        username: activity.user?.username ?? null,
        createdAt: new Date(activity.createdAt),
        postedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function updateSeenState(db, state, processedIds) {
  const previousIds = Array.isArray(state?.recentLogIds) ? state.recentLogIds : [];
  const recentLogIds = [...new Set([...processedIds, ...previousIds])].slice(0, MAX_SEEN_IDS);

  await db.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        kind: "clubLogMirrorState",
        recentLogIds,
        lastCheckedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function mirrorClubLogs(client) {
  const db = client.db;
  if (!db) return;

  const logs = await fetchRecentLogs();
  if (logs.length === 0) return;

  const state = await db.findOne({ _id: STATE_ID });
  const stateSeenIds = new Set(state?.recentLogIds ?? []);

  if (!state) {
    await updateSeenState(db, null, logs.map(log => String(log._id)));
    console.log(`[clubLogMirror] Baseline initialized with ${logs.length} logs.`);
    return;
  }

  const channel = await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`[clubLogMirror] Channel ${TARGET_CHANNEL_ID} not found or not text-based.`);
    return;
  }

  const processedIds = [];

  for (const log of logs) {
    const logId = String(log._id);
    if (stateSeenIds.has(logId)) continue;

    if (await isDiscordCreatedLog(db, logId)) {
      processedIds.push(logId);
      continue;
    }

    if (await wasAlreadyPosted(db, logId)) {
      processedIds.push(logId);
      continue;
    }

    const details = await fetchUserLogDetails(log).catch(err => {
      console.error("[clubLogMirror] Failed to fetch log details:", err.response?.data || err.message);
      return null;
    });
    const enrichedLog = { ...log, details };

    // No se registra sighting de logs privados: evita filtrar por otra vía actividad que la
    // persona pidió mantener oculta al marcar el log como privado.
    const mediaInfo = details && !details.private ? coImmersion.extractMediaInfo(details) : null;
    const username = log.user?.username;

    let others = [];
    if (mediaInfo && username) {
      await coImmersion.recordSighting(db, {
        ...mediaInfo,
        username,
        loggedAt: log.createdAt ? new Date(log.createdAt) : new Date()
      }).catch(err => console.error("[clubLogMirror] Failed to record sighting:", err.message));

      others = await coImmersion.getCoImmersors(db, {
        type: mediaInfo.type,
        contentId: mediaInfo.contentId,
        excludeUsername: username
      }).catch(() => []);
    }

    await channel.send({ embeds: [buildLogEmbed(enrichedLog, others)] });
    await rememberPostedLog(db, enrichedLog);
    processedIds.push(logId);
  }

  if (processedIds.length > 0) {
    await updateSeenState(db, state, processedIds);
  } else {
    await db.updateOne({ _id: STATE_ID }, { $set: { lastCheckedAt: new Date() } });
  }
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.clubLogMirrorInterval) return;

    let running = false;
    const run = async () => {
      if (running) return;
      running = true;

      try {
        await mirrorClubLogs(client);
      } catch (err) {
        console.error("[clubLogMirror] Error:", err.response?.data || err.message);
      } finally {
        running = false;
      }
    };

    client.clubLogMirrorInterval = setInterval(run, POLL_MS);
    setTimeout(run, 10 * 1000);
    console.log("[clubLogMirror] Started.");
  }
};