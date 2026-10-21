import { EmbedBuilder } from "discord.js";
import { categoryLabel } from "./nukiyasuClient.js";
import { buildPendingAnnouncementContent } from "./nukiyasuPresentation.js";

export { discordCoverFilename } from "./nukiyasuPresentation.js";

const COLOR = 0x7C3AED;

function safe(value, fallback = "Sin datos", max = 1024) {
  if (value == null || value === "") return fallback;
  const text = String(value).replace(/@(?=[everyone|here])/gi, "@​");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildCatalogEmbed(items, { title = "Catálogo de Nukiyasu", page, pages, total } = {}) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(title);
  if (!items.length) embed.setDescription("No encontré obras disponibles con esos filtros.");
  else {
    embed.setDescription(items.map(item =>
      `${categoryLabel(item.variant)} · **${safe(item.visibleName, "Sin título", 180)}** — ${item.bookCount} volumen${item.bookCount === 1 ? "" : "es"}`
    ).join("\n"));
  }
  embed.setFooter({ text: `Página ${page} de ${pages}${total == null ? "" : ` · ${total} obras`}` });
  return embed;
}

export function buildSeriesEmbed(series, books, { coverFilename = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(safe(series.visibleName, "Obra"))
    .addFields(
      { name: "Categoría", value: categoryLabel(series.variant), inline: true },
      { name: "Volúmenes", value: String(books.length || series.bookCount || 0), inline: true },
      { name: "Estado", value: safe(series.status, "No indicado"), inline: true }
    );
  if (series.summary) embed.setDescription(safe(series.summary, "", 3500));
  if (series.authors?.length) embed.addFields({ name: "Autores", value: safe(series.authors.join(", ")) });
  if (books.length) {
    embed.addFields({
      name: "Volúmenes disponibles",
      value: safe(books.map(book => `• ${book.visibleName || book.sortName}`).join("\n"), "Sin datos", 1024)
    });
  }
  if (coverFilename) embed.setThumbnail(`attachment://${coverFilename}`);
  return embed;
}

export function buildPendingAnnouncement(pending, { coverFilename = null } = {}) {
  const content = buildPendingAnnouncementContent(pending);
  const embed = new EmbedBuilder().setColor(COLOR);
  embed.setTitle(content.title).setDescription(content.description);
  if (coverFilename) embed.setThumbnail(`attachment://${coverFilename}`);
  return embed;
}

export function buildRecentChangesEmbed(changes) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle("Novedades de Nukiyasu");
  if (!changes.length) return embed.setDescription("No hay incorporaciones registradas todavía.");
  embed.setDescription(changes.map(change => {
    const kind = change.type === "series" ? "Obra nueva" : "Volúmenes nuevos";
    return `• **${kind}**: ${safe(change.series?.visibleName, "Sin título", 180)} — ${(change.books || []).length} volumen${(change.books || []).length === 1 ? "" : "es"}`;
  }).join("\n"));
  return embed;
}

export function errorEmbed(title, message) {
  return new EmbedBuilder().setColor(0xED4245).setTitle(title).setDescription(safe(message, "Error desconocido", 3500));
}
