const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require("discord.js");
const axios = require("axios");
const ntToggle = require("../../lib/nihongoTrackerToggle.js");

const CLUB_URL = "https://nihongotracker.app/clubs/6951b8e3319c4aea0d5d2b2d";

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID  = "6951b8e3319c4aea0d5d2b2d";
const POLL_MS  = 5 * 60 * 1000; // 5 minutos

// ─── Colores por status ───────────────────────────────────────────────────────
const STATUS_COLORS = {
  setup:        0xF59E0B,
  voting:       0x3B82F6,
  voting_open:  0x3B82F6,
  consumption:  0x10B981,
  finished:     0x6B7280,
};

const STATUS_LABELS = {
  setup:        "⚙️ En configuración",
  voting:       "🗳️ Votación abierta",
  voting_open:  "🗳️ Votación abierta",
  consumption:  "📺 En consumo",
  finished:     "✅ Finalizada",
};

const MEDIA_LABELS = {
  anime:      "🎌 Anime",
  manga:      "📚 Manga",
  reading:    "📖 Reading",
  vn:         "🎮 Visual Novel",
  video_game: "🕹️ Video Game",
  movie:      "🎬 Movie",
  tv_show:    "📺 TV Show",
  audio:      "🎧 Audio",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(iso) {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

function buildVotingEmbed(voting) {
  const color  = STATUS_COLORS[voting.status] ?? 0x5865F2;
  const status = STATUS_LABELS[voting.status] ?? voting.status;
  const type   = MEDIA_LABELS[voting.mediaType] ?? voting.mediaType;

  // ── Ordenar candidatos por votos ──────────────────────────────────────────
  const sorted = [...voting.candidates].sort(
    (a, b) => (b.votes?.length ?? 0) - (a.votes?.length ?? 0)
  );

  const totalVotes = sorted.reduce((s, c) => s + (c.votes?.length ?? 0), 0);

  // ── Barra de progreso ─────────────────────────────────────────────────────
  function bar(count) {
    if (totalVotes === 0) return "░░░░░░░░░░ 0%";
    const pct  = count / totalVotes;
    const fill = Math.round(pct * 10);
    return `${"█".repeat(fill)}${"░".repeat(10 - fill)} ${Math.round(pct * 100)}%`;
  }

  const candidateFields = sorted.map((c, i) => {
    const medal = i === 0 && totalVotes > 0 ? "🥇 " : `${i + 1}. `;
    const votes = c.votes?.length ?? 0;
    return {
      name:   `${medal}${c.title}`,
      value:  `${bar(votes)} — **${votes}** voto${votes !== 1 ? "s" : ""}`,
      inline: false,
    };
  });

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🗳️ ${voting.title}`)
    .setDescription(
      [
        voting.description ? `*${voting.description}*` : null,
        ``,
        `**Tipo:** ${type}`,
        `**Estado:** ${status}`,
        `**Inicio votación:** ${formatDate(voting.votingStartDate)}`,
        `**Cierre votación:** ${formatDate(voting.votingEndDate)}`,
        `**Consumo:** ${formatDate(voting.consumptionStartDate)} → ${formatDate(voting.consumptionEndDate)}`,
        ``,
        `**Total votos: ${totalVotes}**`,
      ]
        .filter(l => l !== null)
        .join("\n")
    )
    .addFields(
      candidateFields.length > 0
        ? candidateFields
        : [{ name: "Sin candidatos aún", value: "—" }]
    )
    .setFooter({ text: `ID: ${voting._id} • Vota en: ${CLUB_URL}` })
    .setTimestamp();

  return embed;
}

function refreshButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("voting_refresh")
      .setLabel("🔄 Actualizar")
      .setStyle(ButtonStyle.Secondary)
  );
}

// ─── Fetch votings ────────────────────────────────────────────────────────────
async function fetchVotings() {
  const { data } = await axios.get(`${API_BASE}/clubs/${CLUB_ID}/votings`);
  const list = data?.votings ?? data ?? [];
  return list.filter(v => v.isActive && v.status !== "setup");
}

// ─── Sync mensajes en el canal ────────────────────────────────────────────────
async function syncMessages(channel, votingMessages) {
  // NihongoTracker desactivado: el poller sigue vivo pero no llama a la API.
  if (!ntToggle.isEnabled()) return;

  let votings;
  try {
    votings = await fetchVotings();
  } catch (err) {
    console.error("[voting] Error fetching:", err.message);
    return;
  }

  const row = refreshButton();

  for (const voting of votings) {
    const embed    = buildVotingEmbed(voting);
    const existing = votingMessages.get(voting._id);

    if (existing) {
      try {
        await existing.edit({ embeds: [embed], components: [row] });
      } catch {
        // Mensaje borrado — lo re-enviamos
        const msg = await channel.send({ embeds: [embed], components: [row] });
        votingMessages.set(voting._id, msg);
      }
    } else {
      const msg = await channel.send({ embeds: [embed], components: [row] });
      votingMessages.set(voting._id, msg);
    }
  }

  // Borra embeds de votaciones que ya no están activas
  for (const [id, msg] of votingMessages) {
    if (!votings.find(v => v._id === id)) {
      try { await msg.delete(); } catch {}
      votingMessages.delete(id);
    }
  }
}

// ─── Poller ───────────────────────────────────────────────────────────────────
function startPoller(client, channel, votingMessages) {
  if (client.votingPoller?.interval) {
    clearInterval(client.votingPoller.interval);
  }

  const interval = setInterval(
    () => syncMessages(channel, votingMessages),
    POLL_MS
  );

  client.votingPoller = { channelId: channel.id, votingMessages, interval };
}

// ─── Slash Command ────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName("voting")
    .setDescription("Muestra y mantiene actualizadas las votaciones activas del club")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const channel        = interaction.channel;
    const votingMessages = new Map(); // votingId → Message

    await syncMessages(channel, votingMessages);
    startPoller(interaction.client, channel, votingMessages);

    return interaction.editReply({
      content: `✅ Votaciones publicadas en ${channel}. Se actualizarán automáticamente cada 5 minutos.`,
    });
  },

  // ─── Botón de refresh ───────────────────────────────────────────────────────
  // En tu interactionCreate handler agrega:
  //
  //   if (interaction.isButton() && interaction.customId === "voting_refresh") {
  //     await interaction.client.commands.get("voting").handleRefresh(interaction);
  //   }
  //
  async handleRefresh(interaction) {
    await interaction.deferUpdate();

    const poller = interaction.client.votingPoller;
    if (!poller) return;

    await syncMessages(
      await interaction.client.channels.fetch(poller.channelId),
      poller.votingMessages
    );
  },
};