import { EmbedBuilder } from "discord.js";
import torbox from "../lib/torbox.js";
import torboxDownloads from "../lib/torboxDownloads.js";

const POLL_MS = 7 * 1000;

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

async function refreshJobMessage(client, job) {
  const channel = await client.channels.fetch(job.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = toEmbed(torboxDownloads.buildJobEmbedData(job));
  const message = job.messageId ? await channel.messages.fetch(job.messageId).catch(() => null) : null;

  if (message) {
    await message.edit({ embeds: [embed] }).catch(() => {});
  } else {
    // El mensaje original se borró a mano o algo falló al mandarlo — lo re-creamos.
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) await torboxDownloads.setMessageId(client.db, job._id, sent.id);
  }
}

async function finishJob(client, job, torrent) {
  const db = client.db;
  const channel = await client.channels.fetch(job.channelId).catch(() => null);

  // Borra el embed de "descargando" — el canal solo debe mostrar descargas activas.
  if (channel && job.messageId) {
    const message = await channel.messages.fetch(job.messageId).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }

  const updatedJob = await torboxDownloads.updateJobFromTorrent(db, job, torrent);

  let downloadUrl = null;
  try {
    const files = Array.isArray(torrent.files) ? torrent.files : [];
    downloadUrl = files.length > 1
      ? await torbox.requestDownloadLink({ torrentId: torrent.id, zip: true })
      : await torbox.requestDownloadLink({ torrentId: torrent.id, fileId: files[0]?.id });
  } catch (err) {
    console.error("[torboxPoller] Error pidiendo link de descarga:", err.message);
  }

  if (channel) {
    const embed = toEmbed(torboxDownloads.buildFinishedEmbedData(updatedJob, downloadUrl));
    await channel.send({ content: `<@${job.userId}>`, embeds: [embed] }).catch(() => {});
  }

  await torboxDownloads.markDone(db, job._id, { downloadUrl });
}

async function pollJobs(client) {
  const db = client.db;
  if (!db || !torbox.isConfigured()) return;

  const jobs = await torboxDownloads.getActiveJobs(db);
  if (jobs.length === 0) return;

  let list;
  try {
    list = await torbox.getTorrentList({ bypassCache: true });
    if (!Array.isArray(list)) list = list ? [list] : [];
  } catch (err) {
    console.error("[torboxPoller] Error listando torrents:", err.message);
    return;
  }

  for (const job of jobs) {
    if (job.state === "error") continue;

    const torrent = torboxDownloads.matchTorrent(job, list);
    if (!torrent) continue; // todavía no aparece en /mylist (recién creado) — se resuelve solo

    if (torboxDownloads.isTorrentFinished(torrent)) {
      await finishJob(client, job, torrent).catch(err =>
        console.error("[torboxPoller] Error finalizando job:", err.message)
      );
      continue;
    }

    const updatedJob = await torboxDownloads.updateJobFromTorrent(db, job, torrent);
    await refreshJobMessage(client, updatedJob).catch(err =>
      console.error("[torboxPoller] Error actualizando embed:", err.message)
    );
  }
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.torboxPoller) return;

    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await pollJobs(client);
      } catch (err) {
        console.error("[torboxPoller] Error:", err.message);
      } finally {
        running = false;
      }
    };

    client.torboxPoller = setInterval(run, POLL_MS);
    setTimeout(run, 5000);
    console.log("[torboxPoller] Started.");
  }
};
