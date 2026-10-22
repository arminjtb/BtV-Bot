import { categoryLabel } from "./nukiyasuClient.js";

function safe(value, fallback = "Sin datos", max = 1024) {
  if (value == null || value === "") return fallback;
  const text = String(value).replace(/@(?=[everyone|here])/gi, "@​");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function volumeNumber(book) {
  for (const field of ["volumeNumber", "volume", "bookNumber"]) {
    const value = book?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
    if (typeof value === "string" && /^\d+(?:[.,]\d+)?$/.test(value.trim())) return value.trim().replace(",", ".");
  }

  for (const value of [book?.visibleName, book?.sortName, book?.path, book?.thumbnailPath]) {
    if (!value) continue;
    const text = String(value);
    const match = text.match(/第\s*0*(\d+(?:[.,]\d+)?)\s*巻/u)
      || text.match(/(?:^|[^a-z])v(?:ol(?:ume)?\.?\s*)?0*(\d+(?:[.,]\d+)?)(?!\d)/iu)
      || text.match(/(?:^|[^0-9])V0*(\d+(?:[.,]\d+)?)(?!\d)/u)
      || text.match(/(?:^|[^a-z])0*(\d+(?:[.,]\d+)?)\s*巻/u);
    if (match) return match[1].replace(",", ".");
  }
  return null;
}

function formatVolumeNumbers(books) {
  const numbers = books.map(volumeNumber);
  if (!numbers.length || numbers.some(number => number == null)) return null;
  return [...new Set(numbers)].sort((a, b) => Number(a) - Number(b)).join(", ").replace(/, (?=[^,]*$)/, " y ");
}

function availableVolumeCount(series, books) {
  const count = Number(series?.bookCount);
  return Number.isFinite(count) && count > 0 ? count : books.length;
}

function volumeLabel(count) {
  return count === 1 ? "volumen" : "volúmenes";
}

export function buildPendingAnnouncementContent(pending) {
  const series = pending.series || {};
  const books = pending.books || [];
  const availableCount = availableVolumeCount(series, books);

  if (pending.type === "series") {
    return {
      title: `Nueva obra disponible: ${safe(series.visibleName, "Sin título")}`,
      description: `${categoryLabel(series.variant)} · ${availableCount} ${volumeLabel(availableCount)} disponible${availableCount === 1 ? "" : "s"}.`
    };
  }

  const numbers = formatVolumeNumbers(books);
  const count = books.length;
  const incorporation = count === 1
    ? (numbers ? `Volumen ${numbers} disponible.` : "Se incorporó un nuevo volumen.")
    : (numbers ? `Volúmenes incorporados: ${numbers}.` : `Se incorporaron ${count} nuevos volúmenes.`);
  return {
    title: `${count === 1 ? "Nuevo volumen" : "Nuevos volúmenes"}: ${safe(series.visibleName, "Sin título")}`,
    description: `${incorporation}\n\n${categoryLabel(series.variant)} · ${availableCount} ${volumeLabel(availableCount)} disponible${availableCount === 1 ? "" : "s"}.`
  };
}

export function discordCoverFilename(filename, variant) {
  if (!filename) return null;
  if (variant !== "doujinshi" || /^SPOILER_/i.test(filename)) return filename;
  return `SPOILER_${filename}`;
}
