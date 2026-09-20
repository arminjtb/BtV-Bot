import { setTimeout as sleep } from "node:timers/promises";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import torbox from "../lib/torbox.js";
import torboxDownloads from "../lib/torboxDownloads.js";

const POLL_MS = 7 * 1000;

// Cuántas veces reintentar generar el link de descarga después de que TorBox marca algo como
// "terminado", antes de darnos por vencidos. Con el poll cada 7s, más los reintentos inmediatos
// dentro de cada intento, esto cubre poco más de un minuto — de sobra para el retraso típico
// entre "download_finished" y que /requestdl funcione.
const LINK_MAX_ATTEMPTS = 8;

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

async function refreshJobMessage(client, job) {
  const channel = await client.channels.fetch(job.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = toEmbed(torboxDownloads.buildJobEmbedData(job));
  const components = [buildCancelRow(job._id)];
  const message = job.messageId ? await channel.messages.fetch(job.messageId).catch(() => null) : null;

  if (message) {
    await message.edit({ embeds: [embed], components }).catch(() => {});
  } else {
    // El mensaje original se borró a mano o algo falló al mandarlo — lo re-creamos.
    const sent = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (sent) await torboxDownloads.setMessageId(client.db, job._id, sent.id);
  }
}

function requestLink(job, remote) {
  const files = Array.isArray(remote.files) ? remote.files : [];
  if (job.type === "web") {
    return files.length > 1
      ? torbox.requestWebDownloadLink({ webId: remote.id, zip: true })
      : torbox.requestWebDownloadLink({ webId: remote.id, fileId: files[0]?.id });
  }
  return files.length > 1
    ? torbox.requestDownloadLink({ torrentId: remote.id, zip: true })
    : torbox.requestDownloadLink({ torrentId: remote.id, fileId: files[0]?.id });
}

// Pide una versión fresca del item individual en vez de confiar en el snapshot de /mylist que
// disparó el "terminado" — justo al terminar, la lista completa a veces todavía no trae los
// `files`, aunque el item individual ya los tenga.
async function fetchFreshRemote(job, fallback) {
  try {
    const fresh = job.type === "web"
      ? await torbox.getWebDownloadList({ id: fallback.id, bypassCache: true })
      : await torbox.getTorrentList({ id: fallback.id, bypassCache: true });
    return fresh || fallback;
  } catch {
    return fallback;
  }
}

async function finalizeJob(client, job, downloadUrl, remote) {
  const db = client.db;
  const channel = await client.channels.fetch(job.channelId).catch(() => null);

  // Borra el embed de "descargando/esperando link" — el canal solo debe mostrar descargas activas.
  if (channel && job.messageId) {
    const message = await channel.messages.fetch(job.messageId).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }

  const updatedJob = await torboxDownloads.updateJobFromRemote(db, job, remote);

  if (channel) {
    const embed = toEmbed(torboxDownloads.buildFinishedEmbedData(updatedJob, downloadUrl));
    await channel.send({ content: `<@${job.userId}>`, embeds: [embed] }).catch(() => {});
  }

  await torboxDownloads.markDone(db, job._id, { downloadUrl });
}

// El "terminado" de TorBox a veces llega un poco antes de que el link de descarga esté listo
// para generarse. En vez de rendirnos al primer fallo: dos intentos rápidos ahora mismo (con un
// respiro corto entre ellos) y, si sigue sin poder, seguimos reintentando en los siguientes polls
// (editando el embed para avisar) hasta LINK_MAX_ATTEMPTS antes de darnos por vencidos.
async function tryFinalizeJob(client, job, remote) {
  const attempt = (job.linkAttempts || 0) + 1;
  const fresh = await fetchFreshRemote(job, remote);

  let downloadUrl = null;
  for (let i = 0; i < 2 && !downloadUrl; i++) {
    try {
      downloadUrl = await requestLink(job, fresh);
    } catch (err) {
      if (i === 0) {
        await sleep(2000);
      } else {
        console.error("[torboxPoller] Error pidiendo link de descarga:", err.message);
      }
    }
  }

  if (downloadUrl) {
    await finalizeJob(client, job, downloadUrl, fresh);
    return;
  }

  if (attempt >= LINK_MAX_ATTEMPTS) {
    await finalizeJob(client, job, null, fresh);
    return;
  }

  await torboxDownloads.setLinkAttempts(client.db, job._id, attempt);

  const channel = await client.channels.fetch(job.channelId).catch(() => null);
  if (channel?.isTextBased() && job.messageId) {
    const message = await channel.messages.fetch(job.messageId).catch(() => null);
    if (message) {
      const embed = toEmbed(torboxDownloads.buildLinkPendingEmbedData(job, attempt, LINK_MAX_ATTEMPTS));
      await message.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
  }
}

async function pollJobs(client) {
  const db = client.db;
  if (!db || !torbox.isConfigured()) return;

  const jobs = await torboxDownloads.getActiveJobs(db);
  if (jobs.length === 0) return;

  const torrentJobs = jobs.filter(j => j.type !== "web");
  const webJobs = jobs.filter(j => j.type === "web");

  let torrentList = [];
  let webList = [];

  if (torrentJobs.length) {
    try {
      const list = await torbox.getTorrentList({ bypassCache: true });
      torrentList = Array.isArray(list) ? list : list ? [list] : [];
    } catch (err) {
      console.error("[torboxPoller] Error listando torrents:", err.message);
    }
  }

  if (webJobs.length) {
    try {
      const list = await torbox.getWebDownloadList({ bypassCache: true });
      webList = Array.isArray(list) ? list : list ? [list] : [];
    } catch (err) {
      console.error("[torboxPoller] Error listando descargas web:", err.message);
    }
  }

  for (const job of jobs) {
    if (job.state === "error") continue;

    const list = job.type === "web" ? webList : torrentList;
    const remote = torboxDownloads.matchRemote(job, list);
    if (!remote) continue; // todavía no aparece en /mylist (recién creado) — se resuelve solo

    if (torboxDownloads.isRemoteFinished(remote)) {
      await tryFinalizeJob(client, job, remote).catch(err =>
        console.error("[torboxPoller] Error finalizando job:", err.message)
      );
      continue;
    }

    const updatedJob = await torboxDownloads.updateJobFromRemote(db, job, remote);
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
