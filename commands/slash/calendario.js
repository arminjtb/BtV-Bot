import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} from "discord.js";

import store from "../../lib/anilistStore.js";
import anilist from "../../lib/anilist.js";
import actions from "../../lib/anilistActions.js";
import ui from "../../lib/anilistUi.js";

const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const DAY_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];

// La semana entera son ~300 emisiones; se cachea para que cambiar de día no repita la query.
const WEEK_CACHE_TTL_MS = 15 * 60 * 1000;
const weekCache = new Map(); // weekStartUnix -> { fetchedAt, schedules }

const MAX_LINES = 30;

// ─── Fechas en la zona horaria del servidor ──────────────────────────────────

// Mismo truco que lib/readathon.js: se saca el offset real de la zona con Intl en vez de asumir
// que el proceso corre en esa zona.
function getOffsetMinutes(timeZone, referenceDate) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(referenceDate)
    .find(part => part.type === "timeZoneName")?.value;

  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name || "");
  if (!match) return 0; // UTC como último recurso

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

// Partes año/mes/día y día de la semana (0 = lunes) de una fecha vista desde `timeZone`.
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;
  const weekdayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0
  };
}

// Medianoche local de un día concreto, expresada en epoch UTC.
function zonedMidnightUnix({ year, month, day }, timeZone) {
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const offset = getOffsetMinutes(timeZone, noonUtc);
  return Math.floor((Date.UTC(year, month - 1, day) - offset * 60_000) / 1000);
}

function addDays({ year, month, day }, amount) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

// Los 7 días de la semana en curso (lunes → domingo) con sus límites en epoch.
function buildWeek(timeZone, offsetWeeks = 0) {
  const today = zonedParts(new Date(), timeZone);
  const monday = addDays(today, -today.weekday + offsetWeeks * 7);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const parts = addDays(monday, i);
    const start = zonedMidnightUnix(parts, timeZone);
    const end = zonedMidnightUnix(addDays(parts, 1), timeZone);

    days.push({
      index: i,
      name: DAY_NAMES[i],
      parts,
      label: `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}`,
      start,
      end,
      isToday:
        offsetWeeks === 0 &&
        parts.year === today.year &&
        parts.month === today.month &&
        parts.day === today.day
    });
  }

  return { days, start: days[0].start, end: days[6].end, todayIndex: offsetWeeks === 0 ? today.weekday : 0 };
}

function formatTime(unix, timeZone) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(unix * 1000));
}

// ─── Datos ───────────────────────────────────────────────────────────────────

async function getWeekSchedules(week) {
  const cached = weekCache.get(week.start);
  if (cached && Date.now() - cached.fetchedAt < WEEK_CACHE_TTL_MS) return cached.schedules;

  const schedules = await anilist.fetchWeekSchedule(week.start - 1, week.end + 1);
  weekCache.set(week.start, { fetchedAt: Date.now(), schedules });

  // La cache no crece sin control: sólo interesan la semana pasada, esta y la siguiente.
  if (weekCache.size > 6) {
    const oldest = [...weekCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    weekCache.delete(oldest[0]);
  }

  return schedules;
}

// Miembros del servidor con AniList vinculado, con su nombre visible en Discord resuelto.
async function getGuildAnilistMembers(interaction) {
  const users = await store.getAllUsers(interaction.client.db);
  const present = [];

  for (const user of users) {
    const member = await interaction.guild.members.fetch(user.discordId).catch(() => null);
    if (member) present.push({ ...user, displayName: member.displayName });
  }

  return present;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function filterForScope(schedules, { scope, members, viewerId, config }) {
  const followedBy = new Map(); // mediaId -> [displayName]

  for (const member of members) {
    for (const id of [...(member.current || []), ...(member.planning || [])]) {
      if (!followedBy.has(id)) followedBy.set(id, []);
      followedBy.get(id).push(member.displayName || member.anilistName);
    }
  }

  const viewer = members.find(m => m.discordId === viewerId);
  const viewerIds = new Set([...(viewer?.current || []), ...(viewer?.planning || [])]);

  const rows = schedules
    .map(schedule => ({
      schedule,
      media: schedule.media,
      followers: followedBy.get(schedule.media?.id) || [],
      isViewers: viewerIds.has(schedule.media?.id)
    }))
    .filter(row => {
      if (!row.media) return false;
      if (row.media.isAdult && !config.allowAdult) return false;
      if (scope === "mios") return row.isViewers;
      if (scope === "club") return row.followers.length > 0;

      // scope "todos": se respeta el filtro de países para no llenarlo de donghua si no se quiere.
      const countries = config.countries || [];
      if (countries.length && row.media.countryOfOrigin && !countries.includes(row.media.countryOfOrigin)) {
        return false;
      }
      return true;
    });

  // En "todos" hay decenas de entradas por día: primero las que alguien sigue, luego por
  // popularidad, para que lo relevante quede arriba del corte.
  if (scope === "todos") {
    rows.sort((a, b) => {
      const followDiff = (b.followers.length > 0) - (a.followers.length > 0);
      if (followDiff) return followDiff;
      return (b.media.popularity || 0) - (a.media.popularity || 0);
    });
  } else {
    rows.sort((a, b) => a.schedule.airingAt - b.schedule.airingAt);
  }

  return rows;
}

function buildEmbed({ week, day, rows, scope, timeZone, totalForDay }) {
  const scopeLabel = {
    club: "los que sigue alguien del club",
    mios: "los tuyos",
    todos: "todos los que salen"
  }[scope];

  const embed = new EmbedBuilder()
    .setColor(0x02A9FF)
    .setTitle(`📅 ${day.name} ${day.label}${day.isToday ? " · hoy" : ""}`)
    .setFooter({
      text: `Mostrando ${scopeLabel} · ${timeZone} · semana del ${week.days[0].label} al ${week.days[6].label}`
    });

  if (!rows.length) {
    embed.setDescription(
      scope === "mios"
        ? "No tienes ningún anime que salga este día.\n\nPrueba con **Todos** para ver qué hay."
        : scope === "club"
          ? "Nadie del club sigue nada que salga este día.\n\nPrueba con **Todos**."
          : "No hay emisiones registradas para este día."
    );
    return embed;
  }

  const shown = scope === "todos" ? rows.slice(0, MAX_LINES) : rows.slice(0, MAX_LINES);

  const lines = shown.map(({ schedule, media, followers, isViewers }) => {
    const time = formatTime(schedule.airingAt, timeZone);
    const title = anilist.pickTitle(media);
    const total = media.episodes ? `/${media.episodes}` : "";
    const mark = isViewers ? "⭐" : followers.length ? "👥" : "▫️";

    const people = followers.length
      ? ` — *${followers.slice(0, 4).join(", ")}${followers.length > 4 ? ` +${followers.length - 4}` : ""}*`
      : "";

    return `${mark} \`${time}\` **[${title.slice(0, 60)}](${media.siteUrl})** · ep ${schedule.episode}${total}${people}`;
  });

  let description = lines.join("\n");
  if (rows.length > shown.length) {
    description += `\n\n…y **${rows.length - shown.length}** más ese día.`;
  }

  embed.setDescription(description.slice(0, 4000));

  if (totalForDay) {
    embed.setAuthor({ name: `${totalForDay} emisiones en total este día` });
  }

  return embed;
}

function buildComponents({ week, dayIndex, scope, invokerId, rows }) {
  const daySelect = new StringSelectMenuBuilder()
    .setCustomId(`calendario_day:${invokerId}:${scope}`)
    .setPlaceholder("Cambiar de día")
    .addOptions(
      week.days.map(day => ({
        label: `${day.name} ${day.label}${day.isToday ? " (hoy)" : ""}`,
        value: String(day.index),
        emoji: DAY_EMOJIS[day.index],
        default: day.index === dayIndex
      }))
    );

  const scopeRow = new ActionRowBuilder().addComponents(
    ...["club", "mios", "todos"].map(value =>
      new ButtonBuilder()
        .setCustomId(`calendario_scope:${invokerId}:${dayIndex}:${value}`)
        .setLabel({ club: "Del club", mios: "Los míos", todos: "Todos" }[value])
        .setStyle(value === scope ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(value === scope)
    )
  );

  const components = [new ActionRowBuilder().addComponents(daySelect), scopeRow];

  // Menú para añadir a planning cualquiera de los que se están viendo en pantalla.
  const addable = rows.slice(0, 25).filter(row => row.media?.id);
  if (addable.length) {
    const addSelect = new StringSelectMenuBuilder()
      .setCustomId("calendario_add")
      .setPlaceholder("➕ Añadir uno a tu planning de AniList")
      .addOptions(
        addable.map(({ media }) => ({
          label: anilist.pickTitle(media).slice(0, 100),
          value: String(media.id),
          description: `${anilist.formatLabel(media.format)}${media.episodes ? ` · ${media.episodes} eps` : ""}`.slice(0, 100)
        }))
      );

    components.push(new ActionRowBuilder().addComponents(addSelect));
  }

  return components;
}

async function render(interaction, { dayIndex, scope, invokerId }) {
  const config = await store.getGuildConfig(interaction.client.db, interaction.guildId);
  const timeZone = config.timeZone || "America/Mexico_City";

  const week = buildWeek(timeZone);
  const day = week.days[dayIndex];

  const schedules = await getWeekSchedules(week);
  const daySchedules = schedules.filter(s => s.airingAt >= day.start && s.airingAt < day.end);

  const members = await getGuildAnilistMembers(interaction);
  const rows = filterForScope(daySchedules, {
    scope,
    members,
    viewerId: interaction.user.id,
    config
  });

  return {
    embeds: [
      buildEmbed({
        week,
        day,
        rows,
        scope,
        timeZone,
        totalForDay: scope !== "todos" ? daySchedules.length : null
      })
    ],
    components: buildComponents({ week, dayIndex, scope, invokerId, rows })
  };
}

// ─── Comando ─────────────────────────────────────────────────────────────────

export default {
  data: new SlashCommandBuilder()
    .setName("calendario")
    .setDescription("Qué anime sale cada día de la semana")
    .addStringOption(o =>
      o
        .setName("dia")
        .setDescription("Día a mostrar (por defecto, hoy)")
        .addChoices(
          { name: "Lunes", value: "0" },
          { name: "Martes", value: "1" },
          { name: "Miércoles", value: "2" },
          { name: "Jueves", value: "3" },
          { name: "Viernes", value: "4" },
          { name: "Sábado", value: "5" },
          { name: "Domingo", value: "6" }
        )
        .setRequired(false)
    )
    .addStringOption(o =>
      o
        .setName("ver")
        .setDescription("Qué anime listar")
        .addChoices(
          { name: "Los que sigue el club", value: "club" },
          { name: "Sólo los míos", value: "mios" },
          { name: "Todos los que salen", value: "todos" }
        )
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        embeds: [ui.errorEmbed("Sólo en servidores", "Este comando necesita un servidor.")],
        flags: 64
      });
    }

    await interaction.deferReply();

    const config = await store.getGuildConfig(interaction.client.db, interaction.guildId);
    const timeZone = config.timeZone || "America/Mexico_City";
    const week = buildWeek(timeZone);

    const dayOption = interaction.options.getString("dia");
    const dayIndex = dayOption !== null ? Number(dayOption) : week.todayIndex;
    const scope = interaction.options.getString("ver") || "club";

    try {
      const payload = await render(interaction, {
        dayIndex,
        scope,
        invokerId: interaction.user.id
      });

      return interaction.editReply(payload);
    } catch (err) {
      console.error("[calendario] Error:", err.message);
      return interaction.editReply({
        embeds: [
          ui.errorEmbed(
            "No pude armar el calendario",
            `AniList respondió: \`${err.message}\`\n\nInténtalo en un minuto.`
          )
        ]
      });
    }
  },

  // Llamado desde events/anilistInteractions.js para todo customId "calendario_*".
  async handleComponent(interaction) {
    const [action, invokerId, ...rest] = interaction.customId.split(":");

    // El menú de añadir sí lo puede usar cualquiera: es una acción sobre la lista de quien pulsa,
    // no cambia el mensaje compartido.
    if (action === "calendario_add") {
      const mediaId = interaction.values?.[0];
      if (!mediaId) return;
      return actions.setStatus(interaction, mediaId, "PLANNING");
    }

    // Navegar sí reescribe el mensaje: se limita a quien lanzó el comando para que dos personas
    // no se peleen por la misma vista (y para que "Los míos" signifique algo).
    if (interaction.user.id !== invokerId) {
      return interaction.reply({
        embeds: [
          ui.infoEmbed(
            "Ese calendario no es tuyo",
            "Usa **/calendario** para abrir el tuyo y poder navegarlo."
          )
        ],
        flags: 64
      });
    }

    let dayIndex;
    let scope;

    if (action === "calendario_day") {
      scope = rest[0];
      dayIndex = Number(interaction.values?.[0] ?? 0);
    } else if (action === "calendario_scope") {
      dayIndex = Number(rest[0]);
      scope = rest[1];
    } else {
      return;
    }

    await interaction.deferUpdate();

    try {
      const payload = await render(interaction, { dayIndex, scope, invokerId });
      return interaction.editReply(payload);
    } catch (err) {
      console.error("[calendario] Error actualizando:", err.message);
      return interaction.followUp({
        embeds: [ui.errorEmbed("No pude actualizar el calendario", `\`${err.message}\``)],
        flags: 64
      });
    }
  }
};
