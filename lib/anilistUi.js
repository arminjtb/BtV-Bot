// Embeds y botones compartidos por el notificador (events/anilistNotifier.js), el handler de
// botones (events/anilistInteractions.js) y los comandos. A diferencia del resto de lib/, este
// archivo sí importa discord.js: los tres consumidores son ESM y el alternativo era duplicar el
// mismo embed en tres sitios.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import anilist from "./anilist.js";

const COLOR_PREMIERE = 0xF9A825;
const COLOR_EPISODE = 0x02A9FF; // azul de AniList
const COLOR_OK = 0x57F287;
const COLOR_ERROR = 0xED4245;
const COLOR_INFO = 0x5865F2;

// AniList devuelve el color dominante del cover como "#rrggbb"; queda mejor que un color fijo.
function mediaColor(media, fallback) {
  const hex = media?.coverImage?.color;
  if (typeof hex === "string" && /^#?[0-9a-f]{6}$/i.test(hex)) {
    return parseInt(hex.replace("#", ""), 16);
  }
  return fallback;
}

function streamingLinks(media, max = 3) {
  const links = (media?.externalLinks || [])
    .filter(link => link.type === "STREAMING" && link.url && link.site)
    .slice(0, max);

  if (!links.length) return null;
  return links.map(link => `[${link.site}](${link.url})`).join(" · ");
}

// Embed principal de un aviso de emisión. `interested` son los ids de Discord que lo tienen en
// lista (sirve para el pie del embed; el ping va en el content del mensaje).
export function buildAiringEmbed(media, { episode, airingAt, isPremiere, interested = [] } = {}) {
  const title = anilist.pickTitle(media);
  const alt = anilist.altTitle(media);
  const totalEpisodes = media?.episodes ? `/${media.episodes}` : "";

  const header = isPremiere
    ? "🎬 **ESTRENO**"
    : `📺 **Episodio ${episode}${totalEpisodes}**`;

  const descriptionParts = [header];
  if (alt) descriptionParts.push(`*${alt}*`);

  const synopsis = anilist.cleanDescription(media?.description, isPremiere ? 500 : 260);
  if (synopsis) descriptionParts.push("", synopsis);

  const embed = new EmbedBuilder()
    .setColor(mediaColor(media, isPremiere ? COLOR_PREMIERE : COLOR_EPISODE))
    .setTitle(title.slice(0, 250))
    .setURL(media?.siteUrl || null)
    .setDescription(descriptionParts.join("\n").slice(0, 4000))
    .setThumbnail(media?.coverImage?.extraLarge || media?.coverImage?.large || null);

  if (isPremiere && media?.bannerImage) embed.setImage(media.bannerImage);

  const fields = [];

  if (airingAt) {
    fields.push({
      name: "Salió",
      value: `<t:${airingAt}:R>`,
      inline: true
    });
  }

  fields.push({
    name: "Formato",
    value: `${anilist.formatLabel(media?.format)}${media?.episodes ? ` · ${media.episodes} eps` : ""}`,
    inline: true
  });

  if (media?.averageScore) {
    fields.push({ name: "Puntuación", value: `⭐ ${media.averageScore}/100`, inline: true });
  }

  const studios = (media?.studios?.nodes || []).map(node => node.name).filter(Boolean);
  if (studios.length) {
    fields.push({ name: "Estudio", value: studios.slice(0, 2).join(", "), inline: true });
  }

  if (media?.genres?.length) {
    fields.push({ name: "Géneros", value: media.genres.slice(0, 4).join(" · "), inline: true });
  }

  const streaming = streamingLinks(media);
  if (streaming) fields.push({ name: "Dónde verlo", value: streaming, inline: false });

  embed.addFields(fields);

  embed.setFooter({
    text: interested.length
      ? `${interested.length} miembro${interested.length === 1 ? "" : "s"} del club lo tiene${interested.length === 1 ? "" : "n"} en su lista`
      : "Nadie del club lo tiene en su lista todavía — dale a ➕ si te interesa"
  });

  return embed;
}

// Fila de botones que acompaña a cada aviso. El customId lleva el mediaId (y el episodio para
// "marcar visto"), así los botones siguen funcionando aunque el bot se reinicie.
export function buildAiringButtons(mediaId, { episode = null, siteUrl = null } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`anilist_plan:${mediaId}`)
      .setLabel("Añadir a planning")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`anilist_watching:${mediaId}`)
      .setLabel("Estoy viéndolo")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Primary)
  );

  if (episode) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`anilist_progress:${mediaId}:${episode}`)
        .setLabel(`Visto ep. ${episode}`)
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (siteUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel("AniList").setURL(siteUrl).setStyle(ButtonStyle.Link)
    );
  }

  return row;
}

// Embed que se le enseña a quien pulsa un botón sin haber autorizado todavía.
export function buildNeedsAuthEmbed({ linked }) {
  return new EmbedBuilder()
    .setColor(COLOR_ERROR)
    .setTitle("🔗 Falta autorizar tu cuenta de AniList")
    .setDescription(
      linked
        ? "Tu cuenta está vinculada para **leer** tu lista, pero para que el bot pueda **escribir** " +
          "en ella (añadir a planning, marcar episodios) hace falta autorizarlo.\n\n" +
          "Usa **/anilist autorizar** — son dos clics y te llega por DM."
        : "Todavía no has vinculado tu cuenta.\n\n" +
          "Usa **/anilist vincular** con tu nombre de AniList para recibir avisos, y " +
          "**/anilist autorizar** si además quieres usar estos botones."
    );
}

export function okEmbed(title, description) {
  return new EmbedBuilder().setColor(COLOR_OK).setTitle(title).setDescription(description);
}

export function errorEmbed(title, description) {
  return new EmbedBuilder().setColor(COLOR_ERROR).setTitle(title).setDescription(description);
}

export function infoEmbed(title, description) {
  return new EmbedBuilder().setColor(COLOR_INFO).setTitle(title).setDescription(description);
}

export default {
  buildAiringEmbed,
  buildAiringButtons,
  buildNeedsAuthEmbed,
  okEmbed,
  errorEmbed,
  infoEmbed
};
