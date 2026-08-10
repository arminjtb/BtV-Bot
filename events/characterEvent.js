import { EmbedBuilder } from "discord.js";
import characters from "../lib/characters.js";

const POLL_MS = 60 * 1000;
const ANNOUNCE_CHANNEL_ID = "1364570564320296971";

const ROLE_LABELS = {
  main: "⭐ Personaje principal",
  side: "Personaje secundario"
};

function unitLabel(challenge) {
  switch (challenge.unit) {
    case "episodes": return `${challenge.amount} episodios`;
    case "pages":    return `${challenge.amount} páginas`;
    case "chars":    return `${challenge.amount.toLocaleString("es-MX")} caracteres`;
    case "minutes":  return `${challenge.amount} minutos`;
    default:         return `${challenge.amount}`;
  }
}

export function buildEventEmbed(event) {
  const typeLabel = characters.TYPE_LABELS[event.challenge.contentType] ?? event.challenge.contentType;
  const tagClause = event.challenge.tag === "general"
    ? "" // "general" es un valor interno que significa "sin tag requerido", no se le muestra al usuario
    : ` con el tag \`${event.challenge.tag}\``;

  return new EmbedBuilder()
    .setColor(event.characterRole === "main" ? 0xF59E0B : 0x8B5CF6)
    .setTitle(`✨ ¡Ha aparecido ${event.characterName}!`)
    .setDescription(
      `De **${event.workTitle}**\n${ROLE_LABELS[event.characterRole]}\n\n` +
      `**Reto:** el primero en loguear ${unitLabel(event.challenge)} de ${typeLabel}${tagClause} se lo gana.\n\n` +
      `Termina <t:${Math.floor(new Date(event.deadline).getTime() / 1000)}:R>.`
    )
    .setImage(event.characterImage || null)
    .setFooter({ text: "Solo cuentan logs públicos, desde ahora." })
    .setTimestamp();
}

function buildWinnerEmbed(event, winner) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`🏆 ¡${event.characterName} fue reclamado!`)
    .setDescription(`<@${winner.discordId}> completó el reto y se ganó a **${event.characterName}** de *${event.workTitle}*.`)
    .setThumbnail(event.characterImage || null)
    .setTimestamp();
}

function buildExpiredEmbed(event) {
  return new EmbedBuilder()
    .setColor(0x6B7280)
    .setTitle(`💨 ${event.characterName} se fue sin reclamar`)
    .setDescription(`Nadie completó el reto a tiempo. Quizás vuelva a aparecer otro día.`)
    .setThumbnail(event.characterImage || null)
    .setTimestamp();
}

async function postNewEvent(client, event) {
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`[characterEvent] Canal ${ANNOUNCE_CHANNEL_ID} no encontrado o no es de texto.`);
    return;
  }

  const message = await channel.send({ embeds: [buildEventEmbed(event)] });
  await characters.setEventMessage(client.db, event._id, channel.id, message.id);
}

async function announceResult(client, event, embed) {
  if (!event.channelId) return;
  const channel = await client.channels.fetch(event.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [embed] });
}

async function tick(client) {
  const db = client.db;
  if (!db) return;

  const active = await characters.getActiveEvent(db);

  if (active) {
    if (new Date() >= new Date(active.deadline)) {
      await characters.expireEvent(db, active);
      await announceResult(client, active, buildExpiredEmbed(active));
      return;
    }

    const winner = await characters.checkEventProgress(db, active);
    if (winner) {
      await characters.completeEvent(db, active, winner);
      await announceResult(client, active, buildWinnerEmbed(active, winner));
    }
    return;
  }

  const newEvent = await characters.rollDailyEvent(db);
  if (newEvent) {
    await postNewEvent(client, newEvent);
  }
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.characterEventInterval) return;

    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await tick(client);
      } catch (err) {
        console.error("[characterEvent] Error:", err.response?.data || err.message);
      } finally {
        running = false;
      }
    };

    client.characterEventInterval = setInterval(run, POLL_MS);
    setTimeout(run, 20 * 1000);
    console.log("[characterEvent] Started.");
  }
};
