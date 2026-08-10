import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

const ROLE_LABELS = { main: "⭐ Personaje principal", side: "🎭 Personaje secundario" };

const UNIT_TEXT = {
  episodes: n => `${n} episodios`,
  pages: n => `${n} páginas`,
  chars: n => `${n.toLocaleString("es-MX")} caracteres`,
  minutes: n => `${n} minutos`
};

const CONTENT_TYPE_LABELS = {
  anime: "🎌 Anime",
  manga: "📚 Manga",
  reading: "📖 Lectura",
  vn: "🎮 Novela Visual",
  game: "🕹️ Videojuego",
  movie: "🎬 Película",
  "tv show": "📺 Serie"
};

function formatChoiceName(name) {
  const value = String(name || "Desconocido").trim() || "Desconocido";
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("personaje")
    .setDescription("Ve el detalle de un personaje")
    .addStringOption(o =>
      o.setName("nombre")
        .setDescription("Busca el personaje por nombre")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused()?.toLowerCase() ?? "";

    const matches = await interaction.client.db
      .find({ kind: "character", name: { $regex: focused, $options: "i" } })
      .limit(25)
      .toArray();

    return interaction.respond(
      matches.map(c => ({
        name: formatChoiceName(`${c.name} (${c.workTitle})`),
        value: c._id
      }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply();
    const characterId = interaction.options.getString("nombre");

    const character = await interaction.client.db.findOne({ _id: characterId, kind: "character" });
    if (!character) {
      return interaction.editReply({ content: "No encontré ese personaje." });
    }

    const owned = character.claimed
      ? await interaction.client.db.findOne({ kind: "characterOwned", characterId: character._id })
      : null;

    const event = owned
      ? await interaction.client.db.findOne({ _id: owned.eventId })
      : await interaction.client.db.findOne({
          kind: "dailyCharacterEvent",
          characterId: character._id,
          status: "active"
        });

    const embed = new EmbedBuilder()
      .setColor(character.role === "main" ? 0xF59E0B : 0x8B5CF6)
      .setTitle(character.name)
      .setDescription(`*${character.workTitle}*\n${ROLE_LABELS[character.role] ?? character.role}`)
      .setImage(character.image || null);

    if (event) {
      const unitFn = UNIT_TEXT[event.challenge.unit] ?? (n => `${n}`);
      const typeLabel = CONTENT_TYPE_LABELS[event.challenge.contentType] ?? event.challenge.contentType;
      embed.addFields({
        name: "Reto con el que apareció",
        value: `${unitFn(event.challenge.amount)} de ${typeLabel} con el tag \`${event.challenge.tag}\``
      });
    }

    if (owned) {
      embed.addFields({
        name: "Dueño",
        value: `<@${owned.discordId}> · ganado <t:${Math.floor(new Date(owned.wonAt).getTime() / 1000)}:R>`
      });
    } else {
      embed.setFooter({ text: character.claimed ? "Sin dueño registrado." : "Sin reclamar todavía." });
    }

    return interaction.editReply({ embeds: [embed] });
  }
};
