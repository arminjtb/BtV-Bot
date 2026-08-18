const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const axios = require("axios");
const coImmersion = require("../../lib/coImmersion.js");

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID = "6951b8e3319c4aea0d5d2b2d";

const TYPE_MAP = {
  anime: "anime",
  manga: "manga",
  reading: "reading",
  visual_novel: "vn",
  vn: "vn",
  video_game: "game",
  video: "video",
  movie: "movie",
  tv_show: "tv show",
  audio: "audio"
};

const ENDPOINT_MAP = {
  anime: "media/anime",
  manga: "media/manga",
  reading: "media/reading",
  game: "media/game",
  video: "media/video",
  movie: "media/movie",
  "tv show": "media/tv show",
  audio: "media/audio",
  vn: "media/vn"
};

const TYPE_COLORS = {
  anime:      0x3B82F6,
  manga:      0xF59E0B,
  reading:    0x10B981,
  vn:         0x8B5CF6,
  game:       0xEF4444,
  movie:      0xEC4899,
  "tv show":  0x06B6D4,
  audio:      0x6B7280,
};

const TYPE_LABELS = {
  anime:      "🎌 Anime",
  manga:      "📚 Manga",
  reading:    "📖 Lectura",
  vn:         "🎮 Novela Visual",
  game:       "🕹️ Videojuego",
  movie:      "🎬 Película",
  "tv show":  "📺 Serie",
  audio:      "🎧 Audio",
};

// Tipos cuya "cantidad" principal representa tiempo, no un conteo entero.
const TIME_TYPES = new Set(["game", "movie", "tv show"]);

const getHeaders = (apiKey) => ({
  "X-API-Key": apiKey,
  "Content-Type": "application/json",
  "Accept": "application/json"
});

function mapQuantity(apiType, quantity) {
  switch (apiType) {
    case "anime":      return { episodes: quantity, pages: 0, chars: 0, time: 0, volume: 0 };
    case "manga":      return { episodes: 0, pages: quantity, chars: 0, time: 0, volume: 0 };
    case "reading":    return { episodes: 0, pages: 0, chars: quantity, time: 0, volume: 0 };
    case "vn":         return { episodes: 0, pages: 0, chars: quantity, time: 0, volume: 0 };
    case "game":       return { episodes: 0, pages: 0, chars: 0, time: quantity, volume: 0 };
    case "movie":      return { episodes: 0, pages: 0, chars: 0, time: quantity, volume: 0 };
    case "tv show":    return { episodes: 0, pages: 0, chars: 0, time: quantity, volume: 0 };
    default:           return { episodes: quantity, pages: 0, chars: 0, time: 0, volume: 0 };
  }
}

function formatNumber(n) {
  return n.toLocaleString("es-MX");
}

function formatTime(minutes) {
  if (minutes >= 60) {
    return `${formatNumber(minutes)} min (${(minutes / 60).toFixed(1)}h)`;
  }
  return `${formatNumber(minutes)} min`;
}

// Solo tiene sentido cuando hay caracteres Y tiempo registrados.
function formatSpeed(chars, minutes) {
  if (!chars || !minutes) return null;
  const perHour = chars / (minutes / 60);
  return `${formatNumber(Math.round(perHour))} car/hr`;
}

// Acepta minutos planos ("90"), o formato "2h", "1h30m", "2h1m", "1.5h".
// Devuelve minutos totales (entero) o null si el formato no es válido.
function parseDuration(input) {
  if (input === null || input === undefined) return null;

  const str = String(input).trim().toLowerCase().replace(/\s+/g, "");
  if (str === "") return null;

  if (/^\d+$/.test(str)) return parseInt(str, 10);

  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/.exec(str);
  if (!match || (!match[1] && !match[2])) return null;

  const hours = match[1] ? parseFloat(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;

  return Math.round(hours * 60) + minutes;
}

// Para "cantidad" cuando el tipo NO es de tiempo: debe ser un entero simple.
function parseCount(input) {
  const str = String(input ?? "").trim();
  if (!/^\d+$/.test(str)) return null;
  return parseInt(str, 10);
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

function formatChoiceName(name, id) {
  const value = String(name || "Desconocido").trim() || "Desconocido";
  const suffix = ` (${id})`;
  const maxTitleLen = Math.max(0, 100 - suffix.length);
  const title = value.length <= maxTitleLen ? value : `${value.slice(0, Math.max(0, maxTitleLen - 3))}...`;
  return `${title}${suffix}`;
}

function isObjectId(value) {
  return /^[a-f0-9]{24}$/i.test(value);
}

function tagColorFor(name) {
  const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#ef4444"];
  let hash = 0;

  for (const char of name) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  return colors[Math.abs(hash) % colors.length];
}

async function resolveTags({ apiKey, username, tagNames }) {
  const uniqueTags = [...new Set(tagNames.map(t => t.trim()).filter(Boolean))];
  if (uniqueTags.length === 0) return { ids: [], labels: [] };

  const existingTags = [];
  if (username) {
    try {
      const { data } = await axios.get(`${API_BASE}/tags/user/${encodeURIComponent(username)}`);
      if (Array.isArray(data)) existingTags.push(...data);
    } catch (err) {
      console.error("Tag fetch error:", err.response?.status, err.response?.data || err.message);
    }
  }

  const ids = [];
  const labels = [];

  for (const tagName of uniqueTags) {
    if (isObjectId(tagName)) {
      ids.push(tagName);
      labels.push(tagName);
      continue;
    }

    const existing = existingTags.find(tag =>
      tag.name?.toLowerCase() === tagName.toLowerCase()
    );

    if (existing?._id) {
      ids.push(String(existing._id));
      labels.push(existing.name || tagName);
      continue;
    }

    try {
      const { data } = await axios.post(
        `${API_BASE}/tags`,
        { name: tagName, color: tagColorFor(tagName) },
        { headers: getHeaders(apiKey) }
      );

      ids.push(String(data._id));
      labels.push(data.name || tagName);
    } catch (err) {
      console.error("Tag create error:", err.response?.status, err.response?.data || err.message);
      throw new Error(`No se pudo crear o resolver la etiqueta "${tagName}".`);
    }
  }

  return { ids, labels };
}

async function fetchRecentClubActivity() {
  const { data } = await axios.get(`${API_BASE}/clubs/${CLUB_ID}/recent-activity`, {
    params: { limit: 50 }
  });
  return Array.isArray(data?.activities) ? data.activities : [];
}

async function findUsernameByLogId(logId) {
  if (!logId) return null;

  const activities = await fetchRecentClubActivity();
  const activity = activities.find(item => String(item._id) === String(logId));
  return activity?.user?.username ?? null;
}

async function getLinkedUsername(db, userDoc, discordId) {
  if (userDoc.nihongoUsername) return userDoc.nihongoUsername;

  const recentDiscordLog = await db.findOne(
    { kind: "discordLog", discordId },
    { sort: { createdAt: -1 } }
  );
  const username = await findUsernameByLogId(recentDiscordLog?.logId).catch(() => null);

  if (username) {
    await db.updateOne(
      { discordId },
      { $set: { nihongoUsername: username } }
    );
  }

  return username;
}

function buildEmbed({ media, apiType, mapped, description, tags, xp, isPrivate, user, matched, fallbackTitle, others }) {
  const title =
    media?.title?.contentTitleEnglish ||
    media?.title?.contentTitleRomaji ||
    media?.title?.contentTitleNative ||
    fallbackTitle ||
    "Desconocido";

  const color = TYPE_COLORS[apiType] ?? 0x5865F2;
  const typeLabel = TYPE_LABELS[apiType] ?? apiType;

  const statsFields = [];

  if (mapped.episodes > 0)
    statsFields.push({ name: "📺 Episodios", value: `${formatNumber(mapped.episodes)}`, inline: true });
  if (mapped.pages > 0)
    statsFields.push({ name: "📄 Páginas", value: `${formatNumber(mapped.pages)}`, inline: true });
  if (mapped.volume > 0)
    statsFields.push({ name: "📚 Volumen", value: `${formatNumber(mapped.volume)}`, inline: true });
  if (mapped.chars > 0)
    statsFields.push({ name: "🔤 Caracteres", value: `${formatNumber(mapped.chars)}`, inline: true });
  if (mapped.time > 0)
    statsFields.push({ name: "⏱️ Tiempo", value: formatTime(mapped.time), inline: true });

  const speed = formatSpeed(mapped.chars, mapped.time);
  if (speed)
    statsFields.push({ name: "⚡ Velocidad", value: speed, inline: true });

  if (xp > 0)
    statsFields.push({ name: "✨ XP", value: `+${formatNumber(xp)}`, inline: true });
  if (tags.length > 0)
    statsFields.push({ name: "🏷️ Etiquetas", value: tags.map(t => `\`${t}\``).join(" "), inline: false });

  const coField = coImmersion.buildCoImmersionField(others, apiType);
  if (coField) statsFields.push(coField);

  const baseFooter = isPrivate ? "🔒 Log privado" : "nihongotracker.app";
  const footerText = matched ? baseFooter : `⚠️ Sin match en la base de datos · ${baseFooter}`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${user.username} registró ${typeLabel}`,
      iconURL: user.displayAvatarURL({ dynamic: true })
    })
    .setTitle(title)
    .setThumbnail(media?.contentImage || null)
    .setDescription(description || null)
    .addFields(statsFields)
    .setFooter({ text: footerText })
    .setTimestamp();

  return embed;
}

function buildDeleteButton(logId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`log_delete:${logId}`)
      .setLabel(disabled ? "Log borrado" : "Borrar log")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("log")
    .setDescription("Registra tu inmersión en japonés")

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
    )

    .addStringOption(o =>
      o.setName("cantidad")
        .setDescription("Episodios/Páginas/Caracteres, o Tiempo (90, 2h, 1h30m) según el tipo")
        .setRequired(true)
    )

    .addIntegerOption(o =>
      o.setName("paginas")
        .setDescription("Páginas extra (opcional)")
    )

    .addIntegerOption(o =>
      o.setName("caracteres")
        .setDescription("Caracteres extra (opcional)")
    )

    .addIntegerOption(o =>
      o.setName("volumen")
        .setDescription("Volúmenes extra (opcional)")
    )

    .addStringOption(o =>
      o.setName("tiempo")
        .setDescription("Tiempo extra (opcional). Minutos o formato como 2h, 1h30m, 2h1m")
    )

    .addStringOption(o =>
      o.setName("descripcion")
        .setDescription("Descripción o comentario opcional")
    )

    .addStringOption(o =>
      o.setName("etiquetas")
        .setDescription("Etiquetas separadas por comas")
    )

    .addBooleanOption(o =>
      o.setName("privado")
        .setDescription("Hacer el log privado")
    ),

  // ================= AUTOCOMPLETE =================
  async autocomplete(interaction) {
    const focused  = interaction.options.getFocused();
    const typeRaw  = interaction.options.getString("tipo");

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

    const typeRaw      = interaction.options.getString("tipo");
    const id            = interaction.options.getString("titulo");
    const cantidadRaw   = interaction.options.getString("cantidad");
    const tiempoRaw     = interaction.options.getString("tiempo");
    const volumenExtra  = interaction.options.getInteger("volumen") || 0;
    const tagNames      = (interaction.options.getString("etiquetas") || "")
      .split(",").map(t => t.trim()).filter(Boolean);
    const description   = interaction.options.getString("descripcion") || null;
    const isPrivate      = interaction.options.getBoolean("privado") ?? false;

    const apiType  = TYPE_MAP[typeRaw];
    const endpoint = ENDPOINT_MAP[apiType];

    if (!endpoint)
      return interaction.editReply({ content: "Tipo de contenido no válido." });

    // ================= PARSE CANTIDAD / TIEMPO =================
    let quantity;

    if (TIME_TYPES.has(apiType)) {
      quantity = parseDuration(cantidadRaw);
      if (quantity === null) {
        return interaction.editReply({
          content: "Formato de tiempo inválido en \"cantidad\". Usa minutos (ej. 90) o un formato como 2h, 1h30m, 2h1m."
        });
      }
    } else {
      quantity = parseCount(cantidadRaw);
      if (quantity === null) {
        return interaction.editReply({ content: "\"cantidad\" debe ser un número entero." });
      }
    }

    let extraTime = 0;
    if (tiempoRaw) {
      extraTime = parseDuration(tiempoRaw);
      if (extraTime === null) {
        return interaction.editReply({
          content: "Formato de tiempo inválido en \"tiempo\". Usa minutos (ej. 90) o un formato como 2h, 1h30m, 2h1m."
        });
      }
    }

    // ================= CHECK CUENTA VINCULADA =================
    const userDoc = await interaction.client.db.findOne({ discordId: interaction.user.id });

    if (!userDoc?.apiKey) {
      const embedNoLinkeado = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("❌ Cuenta no vinculada")
        .setDescription(
          "Necesitas vincular tu cuenta antes de poder registrar inmersión.\n\n" +
          "Usa **/link** para conectar tu cuenta de nihongotracker.app."
        )
        .setFooter({ text: "nihongotracker.app" });

      return interaction.editReply({ embeds: [embedNoLinkeado] });
    }

    const nihongoUsername = await getLinkedUsername(
      interaction.client.db,
      userDoc,
      interaction.user.id
    );

    let resolvedTags;
    try {
      resolvedTags = await resolveTags({
        apiKey: userDoc.apiKey,
        username: nihongoUsername,
        tagNames
      });
    } catch (err) {
      return interaction.editReply({ content: err.message });
    }

    // ================= FETCH MEDIA =================
    // Si no matchea contra ningún título conocido, se registra igual como
    // log libre (nihongotracker lo permite) en vez de bloquear el log.
    let media = null;
    let matched = true;

    try {
      const url = `${API_BASE}/${endpoint}/${id}`;
      console.log("Fetching media URL:", url);

      const { data } = await axios.get(url, { headers: getHeaders(userDoc.apiKey) });
      media = data;
    } catch (err) {
      console.error("Media sin match, se registra como log libre:", err.response?.status, err.response?.data);
      media = null;
      matched = false;
    }

    // ================= MAP QUANTITY =================
    const mapped = mapQuantity(apiType, quantity);
    mapped.pages  += interaction.options.getInteger("paginas")    || 0;
    mapped.chars  += interaction.options.getInteger("caracteres") || 0;
    mapped.time   += extraTime;
    mapped.volume += volumenExtra;

    // ================= BODY =================
    const resolvedDescription = description ?? (
      media?.title?.contentTitleNative ||
      media?.title?.contentTitleEnglish ||
      media?.title?.contentTitleRomaji ||
      id
    );

    const body = {
      type: apiType,
      mediaId: id,
      mediaData: {
        contentId: id,
        contentImage: media?.contentImage || "",
        contentTitleNative:  media?.title?.contentTitleNative  || "",
        contentTitleEnglish: media?.title?.contentTitleEnglish || "",
        contentTitleRomaji:  media?.title?.contentTitleRomaji  || "",
        type: apiType
      },
      description: resolvedDescription,
      date:     new Date().toISOString(),
      private:  isPrivate,
      tags:     resolvedTags.ids
    };

    // nihongotracker valida episodes/pages/chars/time/volume como
    // "positivo u omitido" — mandar 0 explícito lo rechaza (400).
    if (mapped.episodes > 0) body.episodes = mapped.episodes;
    if (mapped.pages    > 0) body.pages    = mapped.pages;
    if (mapped.chars    > 0) body.chars    = mapped.chars;
    if (mapped.time     > 0) body.time     = mapped.time;
    if (mapped.volume   > 0) body.volume   = mapped.volume;

    console.log("Sending body:", JSON.stringify(body, null, 2));

    // ================= POST LOG =================
    let logResponse;

    try {
      const { data } = await axios.post(`${API_BASE}/logs`, body, {
        headers: getHeaders(userDoc.apiKey)
      });
      logResponse = data;
    } catch (err) {
      console.error(err.response?.status, JSON.stringify(err.response?.data, null, 2));
      return interaction.editReply({ content: "No se pudo crear el log. Inténtalo de nuevo." });
    }

    if (logResponse?._id) {
      try {
        const inferredUsername = nihongoUsername ?? await findUsernameByLogId(logResponse._id).catch(() => null);

        await interaction.client.db.updateOne(
          { _id: `discord-log:${logResponse._id}` },
          {
            $set: {
              kind: "discordLog",
              logId: String(logResponse._id),
              discordId: interaction.user.id,
              nihongoUsername: inferredUsername,
              createdAt: new Date()
            }
          },
          { upsert: true }
        );

        if (inferredUsername) {
          await interaction.client.db.updateOne(
            { discordId: interaction.user.id },
            { $set: { nihongoUsername: inferredUsername } }
          );
        }

        // No se registra sighting de logs privados: evita filtrar por otra vía actividad que la
        // persona pidió mantener oculta al marcar el log como privado.
        if (inferredUsername && !isPrivate) {
          await coImmersion.recordSighting(interaction.client.db, {
            type: apiType,
            contentId: id,
            username: inferredUsername,
            title: resolvedDescription,
            image: media?.contentImage || null,
            loggedAt: new Date()
          });
        }
      } catch (err) {
        console.error("Failed to mark Discord-created log:", err.message);
      }
    }

    // ================= CO-INMERSIÓN =================
    const others = !isPrivate
      ? await coImmersion.getCoImmersors(interaction.client.db, {
          type: apiType,
          contentId: id,
          excludeUsername: nihongoUsername
        }).catch(() => [])
      : [];

    // ================= EMBED =================
    const xp = logResponse?.xp ?? 0;

    const embed = buildEmbed({
      media,
      apiType,
      mapped,
      description: resolvedDescription,
      tags: resolvedTags.labels,
      xp,
      isPrivate,
      user: interaction.user,
      matched,
      fallbackTitle: id,
      others
    });

    const components = logResponse?._id ? [buildDeleteButton(logResponse._id)] : [];

    return interaction.editReply({ embeds: [embed], components });
  },

  async handleDelete(interaction) {
    const [, logId] = interaction.customId.split(":");
    if (!logId) {
      return interaction.reply({ content: "No encontré el ID del log para borrarlo.", flags: 64 });
    }

    const logDoc = await interaction.client.db.findOne({ _id: `discord-log:${logId}` });
    if (!logDoc) {
      return interaction.reply({ content: "No encontré este log en el registro del bot.", flags: 64 });
    }

    if (logDoc.discordId !== interaction.user.id) {
      return interaction.reply({ content: "Solo quien creó este log puede borrarlo desde este botón.", flags: 64 });
    }

    const userDoc = await interaction.client.db.findOne({ discordId: interaction.user.id });
    if (!userDoc?.apiKey) {
      return interaction.reply({ content: "Tu cuenta ya no está vinculada, no puedo borrar este log.", flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    try {
      await axios.delete(`${API_BASE}/logs/${logId}`, {
        headers: getHeaders(userDoc.apiKey)
      });
    } catch (err) {
      console.error("Log delete error:", err.response?.status, err.response?.data || err.message);
      return interaction.editReply({ content: "No pude borrar el log en NihongoTracker." });
    }

    await interaction.client.db.updateOne(
      { _id: `discord-log:${logId}` },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: interaction.user.id
        }
      }
    );

    const embeds = interaction.message.embeds.map(embed => EmbedBuilder.from(embed));
    if (embeds[0]) {
      embeds[0].setFooter({ text: "Log borrado desde Discord" });
    }

    await interaction.message.edit({
      embeds,
      components: [buildDeleteButton(logId, true)]
    });

    return interaction.editReply({ content: "Log borrado." });
  }
};