import { getNukiyasuClient, isNukiyasuConfigured, isNukiyasuEnabled, matureContentAllowed, NukiyasuError } from "../lib/nukiyasuClient.js";
import { rebuildNukiyasuBaseline, reconcileCatalog } from "../lib/nukiyasuChanges.js";
import * as store from "../lib/nukiyasuStore.js";
import { buildPendingAnnouncement, discordCoverFilename } from "../lib/nukiyasuUi.js";
import { connectNukiyasuSocket } from "../lib/nukiyasuSocket.js";

const POLL_MS = Math.max(60_000, Number(process.env.NUKIYASU_POLL_INTERVAL_MS) || 15 * 60 * 1000);
const MAX_NOTIFICATIONS = Math.max(1, Number(process.env.NUKIYASU_MAX_NOTIFICATIONS_PER_RUN) || 10);
const SEND_DELAY_MS = 750;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTemporary(error) {
  return error?.code === "connectivity" || error?.code === "http" || error?.code === "incomplete";
}

function deliveryErrorDetail(error) {
  const message = String(error?.message || error)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[database-url]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(password|passwd|secret|token|accessToken|refreshToken)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  return {
    code: error?.code || "unknown",
    message: message.slice(0, 300)
  };
}

async function deliverPending(client, nukiyasu) {
  const db = client.db;
  const guilds = await store.getConfiguredGuilds(db);
  if (!guilds.length) return 0;

  const pending = await store.getReadyPending(db, MAX_NOTIFICATIONS);
  let sent = 0;

  for (const item of pending) {
    if (sent >= MAX_NOTIFICATIONS) break;
    if (item.series?.isMature && !matureContentAllowed()) continue;
    for (const guildConfig of guilds) {
      if (sent >= MAX_NOTIFICATIONS) break;
      let claimed;
      try {
        claimed = await store.claimDelivery(db, item._id, guildConfig.guildId);
      } catch (error) {
        console.error("[nukiyasuNotifier] No pude reservar una entrega.", deliveryErrorDetail(error));
        continue;
      }
      if (!claimed) continue;

      try {
        const channel = await client.channels.fetch(guildConfig.channelId).catch(() => null);
        if (!channel?.isTextBased()) throw new Error("El canal configurado no está disponible.");

        const coverEntity = item.type === "series" ? item.series : item.books?.[0];
        let cover = null;
        try {
          cover = await nukiyasu.downloadCover(coverEntity, item.type === "series" ? "series" : "book");
        } catch (error) {
          if (error.code === "auth") throw error;
          console.warn(`[nukiyasuNotifier] Portada no disponible para ${item.seriesId}; continúo sin imagen.`);
        }
        const coverFilename = discordCoverFilename(cover?.filename, item.series?.variant);
        const payload = {
          embeds: [buildPendingAnnouncement({
            ...item,
            series: { ...item.series, url: nukiyasu.seriesUrl(item.seriesId) }
          }, { coverFilename })]
        };
        if (cover) payload.files = [{ attachment: cover.attachment, name: coverFilename }];

        await channel.send(payload);
        await store.markDeliverySent(db, item._id, guildConfig.guildId);
        sent++;
        await sleep(SEND_DELAY_MS);
      } catch (error) {
        try {
          await store.markDeliveryFailed(db, item._id, guildConfig.guildId, error);
        } catch (markError) {
          console.error("[nukiyasuNotifier] No pude registrar el fallo de entrega.", deliveryErrorDetail(markError));
        }
        console.error("[nukiyasuNotifier] No pude enviar una novedad.", deliveryErrorDetail(error));
      }
    }
  }

  return sent;
}

export async function runNukiyasuCycle(client, trigger = "poll") {
  if (!client.db || !isNukiyasuConfigured()) return { skipped: true, reason: "not-configured" };
  const nukiyasu = getNukiyasuClient();
  try {
    const rebuild = process.env.NUKIYASU_REBUILD_BASELINE_ONCE === "true";
    const result = rebuild
      ? await rebuildNukiyasuBaseline(nukiyasu, client.db, { trigger: "baseline-rebuild" })
      : await reconcileCatalog(nukiyasu, client.db, { trigger });
    if (rebuild) delete process.env.NUKIYASU_REBUILD_BASELINE_ONCE;
    const sent = result.baseline ? 0 : await deliverPending(client, nukiyasu);
    if (sent) console.log(`[nukiyasuNotifier] ${sent} novedad(es) enviada(s).`);
    return { ...result, sent };
  } catch (error) {
    const detail = error instanceof NukiyasuError ? `${error.code}: ${error.message}` : error.message;
    if (isTemporary(error)) console.warn(`[nukiyasuNotifier] Reintentará más tarde (${detail}).`);
    else console.error(`[nukiyasuNotifier] Error de integración (${detail}).`);
    return { skipped: true, error: error.code || "unknown" };
  }
}

export default {
  name: "clientReady",
  once: true,

  execute(client) {
    if (client.nukiyasuNotifier) return;
    if (!isNukiyasuEnabled()) {
      console.log("[nukiyasuNotifier] Desactivado (NUKIYASU_ENABLED no está activo).");
      return;
    }
    if (!isNukiyasuConfigured()) {
      console.warn("[nukiyasuNotifier] Activado pero sin URL o credenciales; completa la configuración para iniciar los avisos.");
      return;
    }

    let running = false;
    const run = async trigger => {
      if (running) return;
      running = true;
      try {
        await runNukiyasuCycle(client, trigger);
      } finally {
        running = false;
      }
    };

    client.nukiyasuNotifier = setInterval(() => run("poll"), POLL_MS);
    client.nukiyasuNotifier.unref?.();
    if (process.env.NUKIYASU_SOCKET_ENABLED !== "false") {
      client.nukiyasuSocket = connectNukiyasuSocket({
        baseUrl: getNukiyasuClient().siteUrl,
        onLibraryUpdate: () => run("socket"),
        onError: () => {}
      });
    }

    const startupTimer = setTimeout(() => run("startup"), 10_000);
    startupTimer.unref?.();
    console.log(`[nukiyasuNotifier] Iniciado (poll cada ${Math.round(POLL_MS / 60_000)} min).`);
  }
};
