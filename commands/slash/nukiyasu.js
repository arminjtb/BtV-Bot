import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import {
  categoryLabel,
  getNukiyasuClient,
  isNukiyasuConfigured,
  isNukiyasuEnabled,
  NukiyasuError,
  seriesAutocompleteChoices
} from "../../lib/nukiyasuClient.js";
import * as store from "../../lib/nukiyasuStore.js";
import { buildCatalogEmbed, buildRecentChangesEmbed, buildSeriesEmbed, errorEmbed } from "../../lib/nukiyasuUi.js";
import { logInteractionError, respondAutocompleteSafely, respondSafely } from "../../lib/interactionResponse.js";

const PAGE_SIZE = 8;
const SEARCH_STATE_TTL_MS = 15 * 60 * 1000;
const searchStates = new Map();

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function disabledEmbed() {
  return errorEmbed(
    "Nukiyasu no está disponible",
    "La integración está desactivada o todavía no tiene configurada la cuenta de servicio."
  );
}

function componentsFor(page, pages, action) {
  if (pages <= 1) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nukiyasu:${action}:prev:${page}`)
      .setLabel("Anterior")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`nukiyasu:${action}:next:${page}`)
      .setLabel("Siguiente")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= pages)
  )];
}

function catalogEmbedItems(items, client) {
  return items.map(item => ({ ...item, url: client.seriesUrl(item._id) }));
}

async function catalogPage(interaction, { variant, page }) {
  const client = getNukiyasuClient();
  const result = await client.listSeries({ variant, page, limit: PAGE_SIZE, sort: "sortName" });
  const pages = Math.max(1, result.pages || 1);
  const safePage = Math.min(Math.max(1, page), pages);
  const pageItems = safePage === page ? result.data : (await client.listSeries({ variant, page: safePage, limit: PAGE_SIZE, sort: "sortName" })).data;
  return {
    embeds: [buildCatalogEmbed(catalogEmbedItems(pageItems, client), {
      title: `Catálogo de Nukiyasu · ${categoryLabel(variant === "all" ? "Todas las categorías" : variant)}`,
      page: safePage,
      pages,
      total: pages * PAGE_SIZE
    })],
    components: componentsFor(safePage, pages, `catalogo:${variant}`)
  };
}

function saveSearchState(query, variant) {
  const token = Math.random().toString(36).slice(2, 10);
  searchStates.set(token, { query, variant, expiresAt: Date.now() + SEARCH_STATE_TTL_MS });
  for (const [key, state] of searchStates) if (state.expiresAt < Date.now()) searchStates.delete(key);
  return token;
}

async function searchPage(interaction, { query, variant, page, token }) {
  const client = getNukiyasuClient();
  const result = await client.searchSeries(query, { variant, page, limit: PAGE_SIZE });
  const pages = Math.max(1, result.pages || 1);
  const safePage = Math.min(Math.max(1, page), pages);
  const pageItems = safePage === page ? result.data : (await client.searchSeries(query, { variant, page: safePage, limit: PAGE_SIZE })).data;
  return {
    embeds: [buildCatalogEmbed(catalogEmbedItems(pageItems, client), {
      title: `Resultados para «${query}»`,
      page: safePage,
      pages
    })],
    components: componentsFor(safePage, pages, `buscar:${token}`)
  };
}

async function executeCatalog(interaction) {
  await interaction.deferReply();
  const variant = interaction.options.getString("categoria") || "all";
  const page = interaction.options.getInteger("pagina") || 1;
  await interaction.editReply(await catalogPage(interaction, { variant, page }));
}

async function executeSearch(interaction) {
  const query = interaction.options.getString("texto").trim();
  const variant = interaction.options.getString("categoria") || "all";
  const token = saveSearchState(query, variant);
  await interaction.deferReply();
  await interaction.editReply(await searchPage(interaction, { query, variant, page: 1, token }));
}

async function executeSeries(interaction) {
  await interaction.deferReply();
  const selection = interaction.options.getString("titulo")?.trim();
  if (!selection) throw new NukiyasuError("Selecciona una obra desde las sugerencias.", { code: "input" });
  const client = getNukiyasuClient();
  const series = /^[a-f0-9]{24}$/i.test(selection)
    ? await client.getSeriesById(selection)
    : await resolveSeriesByTitle(client, selection);
  const books = await client.getBooksBySeries(series._id, { variant: series.variant });
  const cover = await client.downloadCover(series, "series").catch(error => {
    if (error.code === "auth" || error.code === "access") throw error;
    return null;
  });
  const payload = {
    embeds: [buildSeriesEmbed({ ...series, url: client.seriesUrl(series._id) }, books, { coverFilename: cover?.filename || null })]
  };
  if (cover) payload.files = [{ attachment: cover.attachment, name: cover.filename }];
  await interaction.editReply(payload);
}

async function resolveSeriesByTitle(client, title) {
  const result = await client.searchSeries(title, { variant: "all", page: 1, limit: 10 });
  if (result.data.length !== 1) {
    throw new NukiyasuError("Selecciona una obra de las sugerencias para consultar sus detalles.", { code: "input" });
  }
  return client.getSeriesById(result.data[0]._id);
}

async function executeRecent(interaction) {
  await interaction.deferReply();
  const limit = interaction.options.getInteger("limite") || 10;
  const changes = await store.getRecentChanges(interaction.client.db, limit);
  const client = getNukiyasuClient();
  const enriched = changes.map(change => ({
    ...change,
    series: { ...change.series, url: client.seriesUrl(change.seriesId) }
  }));
  await interaction.editReply({ embeds: [buildRecentChangesEmbed(enriched)] });
}

async function executeConfig(interaction) {
  if (!interaction.inGuild() || !isAdmin(interaction)) {
    return respondSafely(interaction, { content: "Necesitas el permiso **Gestionar servidor** para configurar Nukiyasu.", flags: 64 });
  }

  const channel = interaction.options.getChannel("canal");
  const enabled = interaction.options.getBoolean("activo");
  const current = await store.getGuildConfig(interaction.client.db, interaction.guildId);
  if (!channel && enabled === null) {
    const state = await store.getSyncState(interaction.client.db);
    return respondSafely(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("Configuración de Nukiyasu")
        .addFields(
          { name: "Estado global", value: isNukiyasuConfigured() ? "Configurado" : "Desactivado o incompleto", inline: true },
          { name: "Canal", value: current.channelId ? `<#${current.channelId}>` : "Sin configurar", inline: true },
          { name: "Avisos", value: current.enabled ? "Activados" : "Desactivados", inline: true },
          { name: "Línea base", value: state.baselineReady ? "Creada" : "Pendiente", inline: true },
          { name: "Última sincronización", value: state.lastSuccessfulSyncAt ? new Date(state.lastSuccessfulSyncAt).toLocaleString("es-ES") : "Nunca", inline: true }
        )],
      flags: 64
    });
  }

  const patch = {};
  if (channel) patch.channelId = channel.id;
  if (enabled !== null) patch.enabled = enabled;
  const next = { ...current, ...patch };
  if (next.enabled && !next.channelId) {
    return respondSafely(interaction, { content: "Primero configura un canal de notificaciones.", flags: 64 });
  }
  const saved = await store.setGuildConfig(interaction.client.db, interaction.guildId, patch);
  return respondSafely(interaction, {
    content: `Configuración guardada: ${saved.enabled ? "avisos activados" : "avisos desactivados"}${saved.channelId ? ` en <#${saved.channelId}>` : ""}.`,
    flags: 64
  });
}

function respondError(interaction, error) {
  let subcommand = "unknown";
  try {
    subcommand = interaction.options?.getSubcommand?.() || subcommand;
  } catch {
    // Discord puede no exponer las opciones cuando falla una interacción parcial.
  }
  logInteractionError(`nukiyasu:${subcommand}`, interaction, error);
  const message = error instanceof NukiyasuError
    ? error.message
    : "No pude completar la consulta a Nukiyasu.";
  const payload = { embeds: [errorEmbed("Error de Nukiyasu", message)], flags: 64 };
  return respondSafely(interaction, payload);
}

const command = {
  data: new SlashCommandBuilder()
    .setName("nukiyasu")
    .setDescription("Consulta el catálogo de Nukiyasu")
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName("catalogo")
      .setDescription("Muestra las obras disponibles")
      .addStringOption(option => option.setName("categoria").setDescription("Filtra por categoría").addChoices(
        { name: "Todas", value: "all" }, { name: "Manga", value: "manga" }, { name: "Novelas", value: "novela" },
        { name: "Doujinshi", value: "doujinshi" }, { name: "Artbooks", value: "artbook" }
      ))
      .addIntegerOption(option => option.setName("pagina").setDescription("Página del catálogo").setMinValue(1).setMaxValue(1000)))
    .addSubcommand(sub => sub
      .setName("buscar")
      .setDescription("Busca una obra por título o nombre alternativo")
      .addStringOption(option => option.setName("texto").setDescription("Título, nombre alternativo o texto japonés").setRequired(true))
      .addStringOption(option => option.setName("categoria").setDescription("Filtra por categoría").addChoices(
        { name: "Todas", value: "all" }, { name: "Manga", value: "manga" }, { name: "Novelas", value: "novela" },
        { name: "Doujinshi", value: "doujinshi" }, { name: "Artbooks", value: "artbook" }
      )))
    .addSubcommand(sub => sub
      .setName("obra")
      .setDescription("Muestra los detalles de una obra")
      .addStringOption(option => option.setName("titulo").setDescription("Título de la obra").setAutocomplete(true).setRequired(true)))
    .addSubcommand(sub => sub
      .setName("novedades")
      .setDescription("Muestra las incorporaciones detectadas localmente")
      .addIntegerOption(option => option.setName("limite").setDescription("Número de novedades").setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub => sub
      .setName("configurar")
      .setDescription("[Admin] Configura las notificaciones de Nukiyasu")
      .addChannelOption(option => option.setName("canal").setDescription("Canal de avisos").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addBooleanOption(option => option.setName("activo").setDescription("Activa o desactiva los avisos"))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "configurar") {
      try {
        return await executeConfig(interaction);
      } catch (error) {
        return respondError(interaction, error);
      }
    }
    if (!isNukiyasuEnabled() || !isNukiyasuConfigured()) return respondSafely(interaction, { embeds: [disabledEmbed()], flags: 64 });
    try {
      switch (subcommand) {
        case "catalogo": return executeCatalog(interaction);
        case "buscar": return executeSearch(interaction);
        case "obra": return executeSeries(interaction);
        case "novedades": return executeRecent(interaction);
        default: return respondSafely(interaction, { content: "Subcomando desconocido.", flags: 64 });
      }
    } catch (error) {
      return respondError(interaction, error);
    }
  },

  async autocomplete(interaction) {
    if (!isNukiyasuEnabled() || !isNukiyasuConfigured()) return respondAutocompleteSafely(interaction, []);
    const query = interaction.options.getString("titulo")?.trim() || "";
    if (!query) return respondAutocompleteSafely(interaction, []);

    try {
      const result = await getNukiyasuClient().searchSeries(query, { variant: "all", page: 1, limit: 25 });
      return respondAutocompleteSafely(interaction, seriesAutocompleteChoices(result.data));
    } catch (error) {
      logInteractionError("nukiyasu-autocomplete", interaction, error);
      return respondAutocompleteSafely(interaction, []);
    }
  },

  async handleButton(interaction) {
    const parts = interaction.customId.split(":");
    if (parts[1] === "catalogo") {
      const [variant, direction, currentPage] = [parts[2], parts[3], Number(parts[4])];
      await interaction.deferUpdate();
      const page = Math.max(1, currentPage + (direction === "next" ? 1 : -1));
      return interaction.editReply(await catalogPage(interaction, { variant, page }));
    }
    if (parts[1] === "buscar") {
      const state = searchStates.get(parts[2]);
      if (!state || state.expiresAt < Date.now()) {
        return respondSafely(interaction, { content: "Esta búsqueda ha caducado; ejecuta el comando de nuevo.", flags: 64 });
      }
      await interaction.deferUpdate();
      const currentPage = Number(parts[4]);
      const page = Math.max(1, currentPage + (parts[3] === "next" ? 1 : -1));
      return interaction.editReply(await searchPage(interaction, { ...state, page, token: parts[2] }));
    }
  }
};

export default command;
