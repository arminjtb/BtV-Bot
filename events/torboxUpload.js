import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } from "discord.js";
import torbox from "../lib/torbox.js";
import torboxDownloads from "../lib/torboxDownloads.js";

const WARNING_TTL_MS = 7000;

function toEmbed(data) {
  const embed = new EmbedBuilder()
    .setColor(data.color)
    .setTitle(data.title)
    .setDescription(data.description)
    .setFooter({ text: data.footer })
    .setTimestamp();

  if (data.fields?.length) embed.addFields(data.fields);
  if (data.url) embed.setURL(data.url);
  return embed;
}

function buildCancelRow(jobId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`torboxCancel:${jobId}`)
      .setLabel("Cancelar")
      .setEmoji("🛑")
      .setStyle(ButtonStyle.Danger)
  );
}

// Manda un aviso corto y se autodestruye — el canal debe quedar limpio salvo por las descargas
// activas, así que ni los avisos de error se quedan pegados.
async function sendWarning(channel, content) {
  const msg = await channel.send({ content }).catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => {}), WARNING_TTL_MS);
}

export default {
  name: Events.MessageCreate,

  async execute(message, client) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channel.id !== process.env.TORBOX_CHANNEL_ID) return;

    const db = client.db;
    if (!db) return;

    if (!torbox.isConfigured()) {
      await message.delete().catch(() => {});
      await sendWarning(message.channel, "⚠️ TorBox no está configurado (`TORBOX_API_KEY` falta en el `.env`).");
      return;
    }

    // Aceptamos magnets Y links normales — no filtramos por host. Si TorBox no puede con el link
    // (torrent o webdl), el error de la API queda reflejado en el embed del job.
    const links = torbox.extractLinks(message.content);

    if (links.length === 0) {
      await message.delete().catch(() => {});
      await sendWarning(message.channel, `<@${message.author.id}> este canal solo acepta magnets o links de descarga.`);
      return;
    }

    await message.delete().catch(() => {});

    const username = message.member?.displayName || message.author.username;

    for (const { type, value } of links) {
      const { job, duplicate } = await torboxDownloads.startJob(db, {
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId: message.author.id,
        username,
        magnet: value,
        type
      });

      if (duplicate) {
        await sendWarning(message.channel, `<@${message.author.id}> eso ya se está descargando.`);
        continue;
      }

      const embed = toEmbed(torboxDownloads.buildJobEmbedData(job));
      const sent = await message.channel.send({
        embeds: [embed],
        components: [buildCancelRow(job._id)]
      }).catch(() => null);
      if (sent) await torboxDownloads.setMessageId(db, job._id, sent.id);
    }
  }
};
