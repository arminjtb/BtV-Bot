import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import characters from "../../lib/characters.js";

const PER_PAGE = 15;

const ROLE_LABELS = {
  main: "⭐ Personaje principal",
  side: "Personaje secundario"
};

function unitLabel(challenge) {
  switch (challenge.unit) {
    case "episodes": return `${challenge.amount} episodios`;
    case "pages":    return `${challenge.amount} páginas`;
    case "chars":    return `${challenge.amount.toLocaleString("es-MX")} caracteres`;
    case "minutes":  return `${challenge.amount} minutos`;
    default:         return `${challenge.amount}`;
  }
}

// Mismo formato que usa el anuncio del personaje (events/characterEvent.js), para que el texto
// del reto se lea igual en los dos lados.
function challengeSummary(event) {
  const typeLabel = characters.TYPE_LABELS[event.challenge.contentType] ?? event.challenge.contentType;
  const tagClause = event.challenge.tag === "general"
    ? ""
    : ` con el tag \`${event.challenge.tag}\``;

  return (
    `De **${event.workTitle}** · ${ROLE_LABELS[event.characterRole]}\n` +
    `**Reto:** el primero en loguear ${unitLabel(event.challenge)} de ${typeLabel}${tagClause} se lo gana.`
  );
}

function buildEmbed(event, works, page, totalPages) {
  const pageItems = works.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const description = works.length === 0
    ? "Nadie en el club ha logueado todavía ninguna obra que cuente para este reto."
    : pageItems
        .map(w => `${characters.TYPE_LABELS[w.type] ?? w.type} **${w.title}**`)
        .join("\n");

  return new EmbedBuilder()
    .setColor(event.characterRole === "main" ? 0xF59E0B : 0x8B5CF6)
    .setTitle(`Obras que cuentan para ganar a ${event.characterName}`)
    .setDescription(`${challengeSummary(event)}\n\n${description}`)
    .setThumbnail(event.characterImage || null)
    .setFooter({ text: `Página ${page} de ${totalPages} · ${works.length} obra${works.length === 1 ? "" : "s"}` });
}

function buildComponents(page, totalPages) {
  if (totalPages <= 1) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("obrasdelreto_page")
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
  const event = await characters.getActiveEvent(interaction.client.db);

  if (!event) {
    return interaction.editReply({
      content: "No hay ningún reto de personaje activo en este momento."
    });
  }

  const works = await characters.getWorksForChallenge(interaction.client.db, event.challenge);

  const totalPages = Math.max(1, Math.ceil(works.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return interaction.editReply({
    embeds: [buildEmbed(event, works, safePage, totalPages)],
    components: buildComponents(safePage, totalPages)
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("obras-del-reto")
    .setDescription("Lista, en orden alfabético, las obras que cuentan para el reto del personaje activo"),

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
