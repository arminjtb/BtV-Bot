import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} from "discord.js";

const PER_PAGE = 10;

const ROLE_EMOJI = { main: "⭐", side: "🎭" };

async function fetchOwnedCharacters(db, discordId) {
  const owned = await db.find({ kind: "characterOwned", discordId }).sort({ wonAt: -1 }).toArray();
  if (owned.length === 0) return [];

  const characterIds = owned.map(o => o.characterId);
  const characterDocs = await db.find({ _id: { $in: characterIds } }).toArray();
  const byId = new Map(characterDocs.map(c => [c._id, c]));

  return owned
    .map(o => ({ ...byId.get(o.characterId), wonAt: o.wonAt }))
    .filter(c => c._id);
}

function buildEmbed(targetUser, characterList, page, totalPages) {
  const pageItems = characterList.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const description = pageItems.length === 0
    ? "Todavía no tiene ningún personaje."
    : pageItems.map(c =>
        `${ROLE_EMOJI[c.role] ?? "🎭"} **${c.name}** — *${c.workTitle}*`
      ).join("\n");

  return new EmbedBuilder()
    .setColor(0x8B5CF6)
    .setAuthor({ name: `Personajes de ${targetUser.username}`, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
    .setDescription(description)
    .setFooter({ text: `Página ${page} de ${totalPages} · ${characterList.length} personaje${characterList.length === 1 ? "" : "s"}` });
}

function buildComponents(page, totalPages, targetUserId) {
  if (totalPages <= 1) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`mispersonajes_page:${targetUserId}`)
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

async function send(interaction, targetUser, page) {
  const characterList = await fetchOwnedCharacters(interaction.client.db, targetUser.id);
  const totalPages = Math.max(1, Math.ceil(characterList.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return interaction.editReply({
    embeds: [buildEmbed(targetUser, characterList, safePage, totalPages)],
    components: buildComponents(safePage, totalPages, targetUser.id)
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("mis-personajes")
    .setDescription("Ve los personajes que has ganado")
    .addUserOption(o =>
      o.setName("usuario")
        .setDescription("Ver los personajes de otro miembro (opcional)")
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("usuario") ?? interaction.user;
    await send(interaction, targetUser, 1);
  },

  async handleSelect(interaction) {
    await interaction.deferUpdate();
    const [, targetUserId] = interaction.customId.split(":");
    const page = parseInt(interaction.values[0], 10) || 1;
    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => interaction.user);
    await send(interaction, targetUser, page);
  }
};
