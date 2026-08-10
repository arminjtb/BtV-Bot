import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import characters from "../../lib/characters.js";

const PER_PAGE = 10;

const TYPE_LABELS = { anime: "🎌", manga: "📚", vn: "🎮" };

function buildEmbed(works, page, totalPages) {
  const pageItems = works.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const description = pageItems.length === 0
    ? "Todavía no hay ninguna obra elegible (necesita al menos 2 miembros del club habiéndola logueado)."
    : pageItems.map(w =>
        `${TYPE_LABELS[w.type] ?? ""} **${w.title}** — ${w.memberCount} miembros`
      ).join("\n");

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("Obras elegibles para personajes")
    .setDescription(description)
    .setFooter({ text: `Página ${page} de ${totalPages} · ${works.length} obras` });
}

function buildComponents(page, totalPages) {
  if (totalPages <= 1) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("obrasdisponibles_page")
        .setPlaceholder(`Página ${page} de ${totalPages}`)
        .addOptions(
          Array.from({ length: totalPages }, (_, i) => ({
            label: `Página ${i + 1}`,
            value: String(i + 1),
            default: page === i + 1
          }))
        )
    )
  ];
}

async function send(interaction, page) {
  await characters.ensureEligibleWorksFresh(interaction.client.db);

  const works = await interaction.client.db
    .find({ kind: "eligibleWork", memberCount: { $gte: 2 } })
    .sort({ memberCount: -1 })
    .toArray();

  const totalPages = Math.max(1, Math.ceil(works.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return interaction.editReply({
    embeds: [buildEmbed(works, safePage, totalPages)],
    components: buildComponents(safePage, totalPages)
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("obras-disponibles")
    .setDescription("Lista de obras que pueden producir personajes"),

  async execute(interaction) {
    await interaction.deferReply();
    await send(interaction, 1);
  },

  async handleSelect(interaction) {
    await interaction.deferUpdate();
    const page = parseInt(interaction.values[0], 10) || 1;
    await send(interaction, page);
  }
};
