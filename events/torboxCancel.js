import { Events, PermissionsBitField } from "discord.js";
import torboxDownloads from "../lib/torboxDownloads.js";

const PREFIX = "torboxCancel:";

export default {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(PREFIX)) return;

    const db = interaction.client.db;
    if (!db) return;

    const jobId = interaction.customId.slice(PREFIX.length);
    const job = await db.findOne({ _id: jobId, kind: "torboxJob" });

    if (!job || job.done) {
      await interaction.reply({ content: "Esa descarga ya no está activa.", ephemeral: true }).catch(() => {});
      return;
    }

    const isOwner = job.userId === interaction.user.id;
    const canManage = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages);

    if (!isOwner && !canManage) {
      await interaction.reply({
        content: "Solo quien la subió (o un mod) puede cancelarla.",
        ephemeral: true
      }).catch(() => {});
      return;
    }

    await interaction.deferUpdate().catch(() => {});

    try {
      await torboxDownloads.cancelJob(db, job);
    } catch (err) {
      console.error("[torboxCancel] Error cancelando en TorBox:", err.message);
      await interaction.followUp({
        content: `⚠️ No se pudo cancelar en TorBox: ${err.message}`,
        ephemeral: true
      }).catch(() => {});
      return;
    }

    // Job cancelado sin problema — el canal solo debe mostrar descargas activas.
    if (interaction.message?.deletable) {
      await interaction.message.delete().catch(() => {});
    }
  }
};
