import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import characters from "../../lib/characters.js";

const ROLE_EMOJI = { main: "⭐", side: "🎭" };

function formatChoiceName(name) {
  const value = String(name || "Desconocido").trim() || "Desconocido";
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("personajes-obra")
    .setDescription("Ve todos los personajes catalogados de una obra")
    .addStringOption(o =>
      o.setName("obra")
        .setDescription("Busca la obra por nombre")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    // Nota: el autocomplete de Discord da ~3s de margen, así que aquí NO se puede llamar a
    // ensureEligibleWorksFresh (el refresh completo puede tardar minutos). Se apoya en el cache
    // que ya se refrescó desde /obras-disponibles o el evento diario.
    const focused = interaction.options.getFocused()?.toLowerCase() ?? "";

    const matches = await interaction.client.db
      .find({ kind: "eligibleWork", title: { $regex: focused, $options: "i" } })
      .limit(25)
      .toArray();

    return interaction.respond(
      matches.map(w => ({
        name: formatChoiceName(w.title),
        value: w._id
      }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply();
    const workId = interaction.options.getString("obra");

    const work = await interaction.client.db.findOne({ _id: workId, kind: "eligibleWork" });
    if (!work) {
      return interaction.editReply({ content: "No encontré esa obra en el catálogo elegible." });
    }

    const chars = await interaction.client.db
      .find({ kind: "character", workType: work.type, workContentId: work.contentId })
      .toArray();

    if (chars.length === 0) {
      return interaction.editReply({
        content: `Todavía no se ha generado el catálogo de personajes de **${work.title}**. Aparecerá automáticamente si sale en el evento diario.`
      });
    }

    const description = chars
      .map(c => `${ROLE_EMOJI[c.role] ?? "🎭"} **${c.name}** ${c.claimed ? "· reclamado" : "· disponible"}`)
      .slice(0, 25)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`Personajes de ${work.title}`)
      .setDescription(description)
      .setImage(work.image || null)
      .setFooter({ text: `${chars.length} personaje${chars.length === 1 ? "" : "s"} catalogado${chars.length === 1 ? "" : "s"}` });

    return interaction.editReply({ embeds: [embed] });
  }
};
