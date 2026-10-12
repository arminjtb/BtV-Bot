import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import ntToggle from "../../lib/nihongoTrackerToggle.js";

function buildEmbed(enabled, changed) {
  return new EmbedBuilder()
    .setColor(enabled ? 0x57F287 : 0xED4245)
    .setTitle(enabled ? "🟢 NihongoTracker activado" : "🔴 NihongoTracker desactivado")
    .setDescription(
      (changed ? "" : "Sin cambios. ") +
      (enabled
        ? "Los comandos y procesos que usan la API están funcionando."
        : "Los comandos que usan la API están bloqueados y el espejo de logs del club está en pausa.\n" +
          "Bloqueados: " + [...ntToggle.API_COMMANDS].map(c => `\`/${c}\``).join(", ")) +
      "\n\n*Al reiniciar el bot vuelve a quedar desactivado.*"
    );
}

export default {
  data: new SlashCommandBuilder()
    .setName("nt-api")
    .setDescription("Activa o desactiva todo lo que usa la API de NihongoTracker (apagado por defecto)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("accion")
        .setDescription("Sin elegir nada, alterna entre activado y desactivado")
        .addChoices(
          { name: "Activar", value: "on" },
          { name: "Desactivar", value: "off" },
          { name: "Ver estado", value: "status" }
        )
    ),

  async execute(interaction) {
    const ownerId = process.env.OWNER_ID;
    const allowed = ownerId
      ? interaction.user.id === ownerId
      : interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

    if (!allowed) {
      return interaction.reply({ content: "No tienes permiso para usar este comando.", flags: 64 });
    }

    const action = interaction.options.getString("accion");
    const before = ntToggle.isEnabled();

    if (action === "on") ntToggle.setEnabled(true);
    else if (action === "off") ntToggle.setEnabled(false);
    else if (!action) ntToggle.toggle();

    const after = ntToggle.isEnabled();
    console.log(`[nt-api] ${interaction.user.tag}: ${before ? "ON" : "OFF"} -> ${after ? "ON" : "OFF"}`);

    return interaction.reply({ embeds: [buildEmbed(after, before !== after)], flags: 64 });
  }
};
