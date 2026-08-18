import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import axios from "axios";

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID = "6951b8e3319c4aea0d5d2b2d";

// Mismos choices/mapeo que /log, para que "tipo" signifique lo mismo en los dos comandos.
const TYPE_MAP = {
  anime: "anime",
  manga: "manga",
  reading: "reading",
  visual_novel: "vn",
  vn: "vn",
  video_game: "game",
  video: "video",
  movie: "movie",
  tv_show: "tv show"
};

const ENDPOINT_MAP = {
  anime: "media/anime",
  manga: "media/manga",
  reading: "media/reading",
  game: "media/game",
  video: "media/video",
  movie: "media/movie",
  "tv show": "media/tv show",
  vn: "media/vn"
};

const TYPE_LABELS = {
  anime: "🎌 Anime",
  manga: "📚 Manga",
  reading: "📖 Lectura",
  vn: "🎮 Novela Visual",
  game: "🕹️ Videojuego",
  movie: "🎬 Película",
  "tv show": "📺 Serie"
};

// GET /users/{username}/immersionlist devuelve TODO el historial del usuario (puede ser varios
// cientos de KB), así que pegarle a un club entero es pesado. Se hace en tandas chicas en vez de
// todo de golpe, mismo patrón que refreshEligibleWorks en lib/characters.js.
const MEMBER_BATCH_SIZE = 5;

function formatChoiceName(name, id) {
  const value = String(name || "Desconocido").trim() || "Desconocido";
  const suffix = ` (${id})`;
  const maxTitleLen = Math.max(0, 100 - suffix.length);
  const title = value.length <= maxTitleLen ? value : `${value.slice(0, Math.max(0, maxTitleLen - 3))}...`;
  return `${title}${suffix}`;
}

function fuzzyScore(query, m) {
  const q = query.toLowerCase();
  const fields = [
    m.title?.contentTitleEnglish,
    m.title?.contentTitleRomaji,
    m.title?.contentTitleNative,
    ...(m.synonyms || []),
    String(m.contentId)
  ].map(f => (f || "").toLowerCase());

  let best = 0;
  for (const field of fields) {
    if (!field) continue;
    if (field === q) return 100;
    if (field.startsWith(q)) best = Math.max(best, 90);
    if (field.includes(q)) best = Math.max(best, 70);
    let i = 0;
    for (const c of field) {
      if (c === q[i]) i++;
      if (i === q.length) { best = Math.max(best, 50); break; }
    }
  }
  return best;
}

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

// Busca, dentro de la immersion list de un usuario, la entrada que matchea este type+contentId
// exacto. La lista viene agrupada por bucket (data[type] = [...]), y cada item ya trae su propio
// `type`, así que basta con mirar el bucket correcto.
async function fetchImmersionEntry(username, type, contentId) {
  try {
    const { data } = await axios.get(`${API_BASE}/users/${encodeURIComponent(username)}/immersionlist`);
    const bucket = data?.[type];
    if (!Array.isArray(bucket)) return null;
    return bucket.find(item => String(item.contentId) === String(contentId)) || null;
  } catch (err) {
    console.error(`[media] Error trayendo immersion list de ${username}:`, err.response?.status || err.message);
    return null;
  }
}

// `mediaStatus` (in_progress/dropped/completed/planning) y `isCompleted` no siempre están
// sincronizados en los datos reales (se ha visto isCompleted:true con mediaStatus:null), así que
// isCompleted manda primero.
function describeStatus(entry) {
  if (entry.isCompleted) {
    return entry.completedAt
      ? `✅ Completada — <t:${Math.floor(new Date(entry.completedAt).getTime() / 1000)}:D>`
      : "✅ Completada";
  }
  if (entry.mediaStatus === "in_progress") return "▶️ En progreso";
  if (entry.mediaStatus === "dropped") return "🗑️ Abandonada";
  if (entry.mediaStatus === "planning") return "📋 En planes";
  if ((entry.logCount || 0) > 0) return "📝 Tiene logs (sin estado marcado)";
  return "📌 En la lista, sin logs";
}

function formatLastLog(entry) {
  if (!entry.lastLogDate) return null;
  return `<t:${Math.floor(new Date(entry.lastLogDate).getTime() / 1000)}:R>`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("media")
    .setDescription("Ve el estado de un título entre los miembros del club (en progreso, terminado, etc.)")

    .addStringOption(o =>
      o.setName("tipo")
        .setDescription("Tipo de contenido")
        .setRequired(true)
        .addChoices(
          { name: "Anime",         value: "anime" },
          { name: "Manga",         value: "manga" },
          { name: "Lectura",       value: "reading" },
          { name: "Novela Visual", value: "visual_novel" },
          { name: "Videojuego",    value: "video_game" },
          { name: "Película",      value: "movie" },
          { name: "Serie",         value: "tv_show" }
        )
    )

    .addStringOption(o =>
      o.setName("titulo")
        .setDescription("Busca y selecciona el título")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  // ================= AUTOCOMPLETE =================
  // Idéntico al de /log (misma búsqueda, mismo formato "Título (id)"), para que elegir el título
  // se sienta igual en los dos comandos.
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const typeRaw = interaction.options.getString("tipo");

    if (!focused || !typeRaw) return interaction.respond([]);

    const apiType = TYPE_MAP[typeRaw];
    if (!apiType) return interaction.respond([]);

    try {
      const { data } = await axios.get(`${API_BASE}/media/search`, {
        params: { search: focused, type: apiType }
      });

      if (!Array.isArray(data)) return interaction.respond([]);

      return interaction.respond(
        data
          .map(m => ({ m, score: fuzzyScore(focused, m) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 25)
          .map(({ m }) => ({
            name: formatChoiceName(
              m.title?.contentTitleEnglish ||
              m.title?.contentTitleRomaji ||
              m.title?.contentTitleNative ||
              "Desconocido",
              m.contentId
            ),
            value: String(m.contentId)
          }))
      );
    } catch {
      return interaction.respond([]);
    }
  },

  // ================= EXECUTE =================
  async execute(interaction) {
    await interaction.deferReply();

    const typeRaw = interaction.options.getString("tipo");
    const id = interaction.options.getString("titulo");
    const apiType = TYPE_MAP[typeRaw];
    const endpoint = ENDPOINT_MAP[apiType];

    if (!endpoint) {
      return interaction.editReply({ content: "Tipo de contenido no válido." });
    }

    const members = await fetchClubMembers();
    const results = [];

    for (let i = 0; i < members.length; i += MEMBER_BATCH_SIZE) {
      const batch = members.slice(i, i + MEMBER_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async member => {
          const entry = await fetchImmersionEntry(member.username, apiType, id);
          return entry ? { username: member.username, entry } : null;
        })
      );
      results.push(...batchResults.filter(Boolean));
    }

    if (results.length === 0) {
      return interaction.editReply({
        content: "Nadie en el club tiene este título en su lista todavía."
      });
    }

    // El título/imagen se sacan de la primera entrada encontrada — la immersion list ya trae esos
    // datos por usuario, así que no hace falta pegarle a /media/{tipo}/{id} aparte.
    const first = results[0].entry;
    const title =
      first.title?.contentTitleEnglish ||
      first.title?.contentTitleRomaji ||
      first.title?.contentTitleNative ||
      id;

    const typeLabel = TYPE_LABELS[apiType] ?? apiType;

    const lines = results
      .sort((a, b) => new Date(b.entry.lastLogDate || 0) - new Date(a.entry.lastLogDate || 0))
      .map(({ username, entry }) => {
        const last = formatLastLog(entry);
        const logsText = entry.logCount > 0 ? ` · ${entry.logCount} log${entry.logCount === 1 ? "" : "s"}` : "";
        const lastText = last ? ` · último: ${last}` : "";
        return `**${username}** — ${describeStatus(entry)}${logsText}${lastText}`;
      });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`${typeLabel} ${title}`)
      .setThumbnail(first.contentImage || null)
      .setDescription(lines.join("\n"))
      .setFooter({
        text: `${results.length} miembro${results.length === 1 ? "" : "s"} del club con esto en su lista`
      });

    return interaction.editReply({ embeds: [embed] });
  }
};
