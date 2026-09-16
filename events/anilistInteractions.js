// Handler propio de interacciones para todo lo que empieza por "anilist_" o "calendario_".
//
// Va en un archivo aparte en vez de tocar events/interactionCreate.js: el cargador registra un
// listener por archivo, igual que ya pasa con los tres archivos que escuchan "clientReady", así
// que los dos handlers conviven sin pisarse. El router existente ignora los customId que no
// conoce y no responde, así que no hay doble reply.

import actions from "../lib/anilistActions.js";
import ui from "../lib/anilistUi.js";

export default {
  name: "interactionCreate",

  async execute(interaction) {
    const customId = interaction.customId;
    if (!customId) return;

    const isAnilist = customId.startsWith("anilist_");
    const isCalendario = customId.startsWith("calendario_");
    if (!isAnilist && !isCalendario) return;

    try {
      if (isCalendario) {
        const command = interaction.client.commands.get("calendario");
        if (command?.handleComponent) return await command.handleComponent(interaction);
        return;
      }

      if (!interaction.isButton()) return;

      if (customId.startsWith("anilist_plan:")) {
        return await actions.setStatus(interaction, customId.split(":")[1], "PLANNING");
      }

      if (customId.startsWith("anilist_watching:")) {
        return await actions.setStatus(interaction, customId.split(":")[1], "CURRENT");
      }

      if (customId.startsWith("anilist_progress:")) {
        const [, mediaId, episode] = customId.split(":");
        return await actions.setProgress(interaction, mediaId, episode);
      }
    } catch (err) {
      console.error("[anilistInteractions] Error:", err);

      const payload = {
        embeds: [ui.errorEmbed("Algo salió mal", "Inténtalo de nuevo en un momento.")],
        flags: 64
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
};
