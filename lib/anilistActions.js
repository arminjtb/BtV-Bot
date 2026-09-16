// Acciones que escriben en la lista de AniList del usuario a partir de una interacción de Discord
// (botón de un aviso o menú del /calendario). Vive en lib/ porque lo usan tanto
// events/anilistInteractions.js como commands/slash/calendario.js.
//
// ESM, como los dos consumidores.

import store from "./anilistStore.js";
import anilist from "./anilist.js";
import ui from "./anilistUi.js";

const STATUS_LABELS = {
  CURRENT: "viéndolo",
  PLANNING: "en planning",
  COMPLETED: "completado",
  DROPPED: "abandonado",
  PAUSED: "en pausa",
  REPEATING: "reviéndolo"
};

// Mantiene la cache local en sync tras escribir en AniList, para que el notificador empiece a
// mencionar a esta persona en el siguiente tick sin esperar a la sincronización de media hora.
async function patchCachedList(db, user, mediaId, status) {
  const id = Number(mediaId);
  const planning = new Set(user.planning || []);
  const current = new Set(user.current || []);

  planning.delete(id);
  current.delete(id);

  if (status === "PLANNING") planning.add(id);
  if (status === "CURRENT") current.add(id);

  await db.updateOne(
    { _id: `anilist:user:${user.discordId}` },
    { $set: { planning: [...planning], current: [...current] } }
  );
}

// Devuelve el usuario si puede escribir; si no, ya respondió a la interacción explicando qué falta.
export async function requireWriteAccess(interaction) {
  const user = await store.getUser(interaction.client.db, interaction.user.id);

  if (!store.hasWriteAccess(user)) {
    const payload = {
      embeds: [ui.buildNeedsAuthEmbed({ linked: Boolean(user?.anilistName) })],
      flags: 64
    };

    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);

    return null;
  }

  return user;
}

export async function setStatus(interaction, mediaId, targetStatus, { deferred = false } = {}) {
  const user = await requireWriteAccess(interaction);
  if (!user) return;

  if (!deferred && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const reply = payload =>
    interaction.deferred || interaction.replied
      ? interaction.followUp({ ...payload, flags: 64 })
      : interaction.reply({ ...payload, flags: 64 });

  const existing = await anilist
    .fetchListEntry(user.accessToken, user.anilistId, mediaId)
    .catch(() => null);

  if (existing?.status === targetStatus) {
    return reply({
      embeds: [
        ui.infoEmbed(
          "Ya lo tenías",
          `Ese anime ya está **${STATUS_LABELS[targetStatus]}** en tu lista de AniList.`
        )
      ]
    });
  }

  // No se pisa un estado "más avanzado" sin querer: si ya lo está viendo o lo completó, mandarlo
  // a planning sería un retroceso. El botón "Estoy viéndolo" sí puede sobrescribir planning.
  if (
    targetStatus === "PLANNING" &&
    existing &&
    ["CURRENT", "COMPLETED", "REPEATING"].includes(existing.status)
  ) {
    return reply({
      embeds: [
        ui.infoEmbed(
          "No lo moví",
          `Ya lo tienes **${STATUS_LABELS[existing.status] || existing.status}** en AniList. ` +
            "No lo paso a planning para no perder tu progreso."
        )
      ]
    });
  }

  try {
    const saved = await anilist.saveListEntry(user.accessToken, {
      mediaId: Number(mediaId),
      status: targetStatus
    });

    await patchCachedList(interaction.client.db, user, mediaId, targetStatus);

    const title =
      saved?.media?.title?.romaji || saved?.media?.title?.english || `Anime #${mediaId}`;

    return reply({
      embeds: [
        ui.okEmbed(
          targetStatus === "PLANNING" ? "➕ Añadido a planning" : "▶️ Marcado como viéndolo",
          `**${title}** ahora está **${STATUS_LABELS[targetStatus]}** en tu AniList.\n\n` +
            "Te avisaré en el canal cuando salga cada episodio."
        )
      ]
    });
  } catch (err) {
    console.error("[anilistActions] Error guardando entrada:", err.message);
    return reply({
      embeds: [
        ui.errorEmbed(
          "No pude actualizar tu lista",
          `AniList respondió: \`${err.message}\`\n\n` +
            "Si el error persiste, vuelve a autorizar con **/anilist autorizar**."
        )
      ]
    });
  }
}

export async function setProgress(interaction, mediaId, episode) {
  const user = await requireWriteAccess(interaction);
  if (!user) return;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const reply = payload =>
    interaction.deferred || interaction.replied
      ? interaction.followUp({ ...payload, flags: 64 })
      : interaction.reply({ ...payload, flags: 64 });

  const existing = await anilist
    .fetchListEntry(user.accessToken, user.anilistId, mediaId)
    .catch(() => null);

  if ((existing?.progress || 0) >= Number(episode)) {
    return reply({
      embeds: [
        ui.infoEmbed(
          "Ya estabas al día",
          `Tu progreso en AniList ya es **${existing.progress}**, igual o mayor que el episodio ${episode}.`
        )
      ]
    });
  }

  try {
    const saved = await anilist.saveListEntry(user.accessToken, {
      mediaId: Number(mediaId),
      status: existing?.status === "COMPLETED" ? undefined : "CURRENT",
      progress: Number(episode)
    });

    await patchCachedList(interaction.client.db, user, mediaId, "CURRENT");

    const title =
      saved?.media?.title?.romaji || saved?.media?.title?.english || `Anime #${mediaId}`;

    return reply({
      embeds: [
        ui.okEmbed("✅ Progreso actualizado", `**${title}** — episodio **${episode}** marcado como visto.`)
      ]
    });
  } catch (err) {
    console.error("[anilistActions] Error actualizando progreso:", err.message);
    return reply({
      embeds: [ui.errorEmbed("No pude actualizar tu progreso", `AniList respondió: \`${err.message}\``)]
    });
  }
}

export default { requireWriteAccess, setStatus, setProgress };
