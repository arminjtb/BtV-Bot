import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import coImmersion from "../../lib/coImmersion.js";

const TYPE_LABELS = {
  anime: "🎌 Anime",
  manga: "📚 Manga",
  reading: "📖 Lectura",
  vn: "🎮 Novela Visual",
  game: "🕹️ Videojuego",
  movie: "🎬 Película",
  "tv show": "📺 Serie",
  audio: "🎧 Audio"
};

const MAX_LISTED = 20;

function formatLine(group) {
  const label = TYPE_LABELS[group.type] ?? group.type;
  const verb = coImmersion.VERB_BY_TYPE[group.type] || "inmersando en esto";
  const names = group.usernames.map(u => `**${u}**`);

  return `${label} **${group.title}** — ${coImmersion.formatNameList(names)} están ${verb}.`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("inmersion-activa")
    .setDescription("Ve qué está leyendo o viendo la gente ahora mismo (mínimo 2 personas)")
    .addStringOption(o =>
      o.setName("tipo")
        .setDescription("Filtrar por tipo de contenido")
        .addChoices(
          { name: "🎌 Anime", value: "anime" },
          { name: "📚 Manga", value: "manga" },
          { name: "📖 Lectura", value: "reading" },
          { name: "🎮 Novela Visual", value: "vn" },
          { name: "🕹️ Videojuego", value: "game" },
          { name: "🎬 Película", value: "movie" },
          { name: "📺 Serie", value: "tv show" },
          { name: "🎧 Audio", value: "audio" }
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const type = interaction.options.getString("tipo");
    const groups = await coImmersion.getActiveImmersion(interaction.client.db, { type });

    if (groups.length === 0) {
      const typeLabel = type ? (TYPE_LABELS[type] ?? type) : null;
      return interaction.editReply({
        content: typeLabel
          ? `Nadie está inmersando ${typeLabel} ahora mismo (últimas 3 semanas, mínimo 2 personas).`
          : "Nadie está inmersando en grupo ahora mismo (últimas 3 semanas, mínimo 2 personas)."
      });
    }

    const shown = groups.slice(0, MAX_LISTED);
    const description = shown.map(formatLine).join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle("👀 Inmersión activa")
      .setDescription(description)
      .setFooter({
        text: groups.length > MAX_LISTED
          ? `Mostrando ${MAX_LISTED} de ${groups.length} · últimos 21 días · mínimo 2 personas`
          : "Últimos 21 días · mínimo 2 personas"
      });

    return interaction.editReply({ embeds: [embed] });
  }
};
