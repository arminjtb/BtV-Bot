import { EmbedBuilder } from "discord.js";
import readathon from "../lib/readathon.js";
import ntToggle from "../lib/nihongoTrackerToggle.js";

const POLL_MS = 60 * 1000;
const RANK_COLORS = [0xD4A72C, 0x94A3B8, 0xB7794A];

function toEmbed(event) {
  const data = readathon.buildEmbedData(event);
  return new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .setDescription(data.description)
    .addFields(data.fields)
    .setFooter({ text: data.footer })
    .setTimestamp(new Date(data.timestamp));
}

async function updateReadathonMessage(client, event) {
  if (!event.channelId || !event.messageId) return;

  const channel = await client.channels.fetch(event.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(event.messageId).catch(() => null);
  if (!message) return;

  await message.edit({ embeds: [toEmbed(event)] });
}

function formatHours(minutes) {
  return `${(minutes / 60).toFixed(1)} h`;
}

async function getAvatarUrl(client, contributor) {
  if (!contributor.discordId) return contributor.avatar || null;

  const user = await client.users.fetch(contributor.discordId).catch(() => null);
  return user?.displayAvatarURL({ size: 512 }) || contributor.avatar || null;
}

function buildStatsEmbed(event) {
  const data = readathon.buildStatsEmbedData(event);
  return new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .addFields(data.fields)
    .setFooter({ text: data.footer });
}

function buildTopTypeEmbed(event) {
  const data = readathon.buildTopTypeEmbedData(event);
  if (!data) return null;

  return new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .setDescription(data.description)
    .setFooter({ text: data.footer });
}

function buildTopMediaEmbed(event) {
  const data = readathon.buildTopMediaEmbedData(event);
  if (!data) return null;

  const embed = new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .setDescription(data.description)
    .setFooter({ text: data.footer });

  if (data.image) embed.setImage(data.image);
  return embed;
}

async function sendFinalResults(client, event) {
  if (!event.channelId || event.completionAnnounced) return;

  const channel = await client.channels.fetch(event.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const completed = event.status === "completed";
  const winners = event.totals?.contributors?.slice(0, 3) ?? [];
  const total = event.totals?.minutes ?? 0;
  const podium = winners.length === 0
    ? "No hubo aportaciones registradas."
    : winners.map((winner, index) => {
      const name = winner.discordId ? `<@${winner.discordId}>` : winner.username;
      return `${index + 1}. ${name} — ${formatHours(winner.minutes)}`;
    }).join("\n");

  const summary = new EmbedBuilder()
    .setColor(completed ? 0x2F855A : 0x64748B)
    .setTitle(completed ? "Lo logramos" : "Readathon finalizado")
    .setDescription(
      completed
        ? `La meta de ${formatHours(event.targetMinutes)} fue alcanzada con ${formatHours(total)}.`
        : `Se registraron ${formatHours(total)} de una meta de ${formatHours(event.targetMinutes)}.`
    )
    .addFields({ name: "Top 3", value: podium })
    .setFooter({ text: `Readathon ${event.date}` })
    .setTimestamp(new Date(event.updatedAt));

  // Resumen + estadísticas generales en un mismo mensaje.
  await channel.send({ embeds: [summary, buildStatsEmbed(event)] });

  // Un embed individual por cada podio, con avatar.
  for (const [index, winner] of winners.entries()) {
    const avatarUrl = await getAvatarUrl(client, winner);
    const name = winner.discordId ? `<@${winner.discordId}>` : winner.username;
    const winnerEmbed = new EmbedBuilder()
      .setColor(RANK_COLORS[index])
      .setTitle(`${index + 1}. ${winner.username}`)
      .setDescription(`${name}\n${formatHours(winner.minutes)} aportadas`)
      .setFooter({ text: `Readathon ${event.date} · Puesto ${index + 1}` });

    if (avatarUrl) winnerEmbed.setThumbnail(avatarUrl);
    await channel.send({ embeds: [winnerEmbed] });
  }

  // Medio más logueado + obra más logueada (con imagen), en un mismo mensaje.
  const extraEmbeds = [buildTopTypeEmbed(event), buildTopMediaEmbed(event)].filter(Boolean);
  if (extraEmbeds.length > 0) {
    await channel.send({ embeds: extraEmbeds });
  }

  await client.db.updateOne(
    { _id: event._id },
    { $set: { completionAnnounced: true, completionAnnouncedAt: new Date() } }
  );
}

async function syncReadathons(client) {
  if (!ntToggle.isEnabled()) return; // NihongoTracker desactivado: sin polling

  const events = await client.db.find({
    kind: "readathon",
    $or: [
      { status: { $in: ["scheduled", "active"] } },
      { status: { $in: ["completed", "finished"] }, completionAnnounced: { $ne: true } }
    ]
  }).toArray();

  for (const event of events) {
    try {
      const refreshed = await readathon.refreshReadathon(client.db, event.readathonId);
      await updateReadathonMessage(client, refreshed);
      if (["completed", "finished"].includes(refreshed.status)) {
        await sendFinalResults(client, refreshed);
      }
    } catch (err) {
      console.error(`[readathon] Failed to update ${event.readathonId}:`, err.response?.data || err.message);
    }
  }
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.readathonPoller) return;

    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await syncReadathons(client);
      } finally {
        running = false;
      }
    };

    client.readathonPoller = setInterval(run, POLL_MS);
    setTimeout(run, 15_000);
    console.log("[readathon] Poller started.");
  }
};
