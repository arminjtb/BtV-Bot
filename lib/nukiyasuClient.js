import { randomUUID } from "node:crypto";

const ACCESS_TOKEN_LIFETIME_MS = 50 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const IMAGE_VARIANTS = new Set(["manga", "doujinshi", "artbook"]);

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function stringId(value) {
  return value == null ? null : String(value);
}

function cleanBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function trimText(value, max = 4000) {
  if (value == null) return "";
  const text = String(value).replace(/@(?=[everyone|here])/gi, "@​");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class NukiyasuError extends Error {
  constructor(message, { code = "unknown", status = null, cause = null } = {}) {
    super(message);
    this.name = "NukiyasuError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export function isNukiyasuEnabled() {
  return envBoolean("NUKIYASU_ENABLED", false);
}

export function isNukiyasuConfigured() {
  return isNukiyasuEnabled() && Boolean(
    process.env.NUKIYASU_URL &&
    process.env.NUKIYASU_USERNAME &&
    process.env.NUKIYASU_PASSWORD
  );
}

export function matureContentAllowed() {
  return envBoolean("NUKIYASU_ALLOW_MATURE", false);
}

export function categoryLabel(variant) {
  return {
    manga: "Manga",
    novela: "Novela",
    doujinshi: "Doujinshi",
    artbook: "Artbook"
  }[variant] || variant || "Desconocida";
}

export function seriesAutocompleteChoices(items, limit = 25) {
  return items
    .filter(item => item?._id && item.visibleName)
    .slice(0, limit)
    .map(item => ({
      name: `${item.visibleName} · ${categoryLabel(item.variant)}`.slice(0, 100),
      value: String(item._id).slice(0, 100)
    }));
}

function pageSignature(items) {
  return items.map(item => String(item?._id ?? JSON.stringify(item))).join("\u001f");
}

function parsePage(body) {
  if (Array.isArray(body)) return { data: body, pages: null, rawCount: body.length, pageSignature: pageSignature(body) };
  if (!body || !Array.isArray(body.data)) {
    throw new NukiyasuError("Nukiyasu devolvió una respuesta de catálogo inválida.", { code: "data" });
  }
  return {
    data: body.data,
    pages: Number.isFinite(Number(body.pages)) ? Number(body.pages) : null,
    rawCount: body.data.length,
    pageSignature: pageSignature(body.data)
  };
}

function normalizeSeries(series) {
  if (!series?._id) return null;
  return {
    ...series,
    _id: stringId(series._id),
    variant: String(series.variant || ""),
    visibleName: trimText(series.visibleName || series.sortName || series.path, 300),
    sortName: trimText(series.sortName || series.visibleName || series.path, 300),
    alternativeNames: Array.isArray(series.alternativeNames) ? series.alternativeNames.map(String) : [],
    authors: Array.isArray(series.authors) ? series.authors.map(String) : [],
    genres: Array.isArray(series.genres) ? series.genres.map(String) : [],
    bookCount: Number(series.bookCount || 0),
    isMature: Boolean(series.isMature),
    missing: Boolean(series.missing)
  };
}

function normalizeBook(book) {
  if (!book?._id) return null;
  return {
    ...book,
    _id: stringId(book._id),
    serie: stringId(book.serie),
    variant: String(book.variant || ""),
    visibleName: trimText(book.visibleName || book.sortName || book.path, 300),
    sortName: trimText(book.sortName || book.visibleName || book.path, 300),
    missing: Boolean(book.missing)
  };
}

function isAvailableSeries(series) {
  return series && !series.missing && series.bookCount > 0;
}

function isAvailableBook(book) {
  return book && !book.missing;
}

function libraryFolder(variant) {
  return {
    manga: "mangas",
    novela: "novelas",
    doujinshi: "doujinshi",
    artbook: "artbooks"
  }[variant] || variant;
}

export function createFetchHttp(baseUrl, timeoutMs) {
  return {
    async request({ method = "GET", url, data, params, headers = {}, responseType }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      }
      const requestUrl = query.toString() ? `${url}?${query}` : url;
      try {
        const response = await fetch(`${baseUrl}${requestUrl}`, {
          method,
          headers: { ...(data ? { "Content-Type": "application/json" } : {}), ...headers },
          body: data == null ? undefined : JSON.stringify(data),
          signal: controller.signal
        });
        const responseHeaders = Object.fromEntries(response.headers.entries());
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.response = { status: response.status };
          throw error;
        }
        const body = responseType === "arraybuffer"
          ? Buffer.from(await response.arrayBuffer())
          : await response.text();
        return {
          data: responseType === "arraybuffer" ? body : (body ? JSON.parse(body) : null),
          headers: responseHeaders
        };
      } catch (error) {
        if (error.name === "AbortError") error.code = "ETIMEDOUT";
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

export class NukiyasuClient {
  constructor({
    baseUrl = process.env.NUKIYASU_URL,
    username = process.env.NUKIYASU_USERNAME,
    password = process.env.NUKIYASU_PASSWORD,
    timeoutMs = Number(process.env.NUKIYASU_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    http = null
  } = {}) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.http = http || createFetchHttp(this.baseUrl, timeoutMs);
    this.accessToken = null;
    this.refreshToken = null;
    this.uuid = null;
    this.accessTokenExpiresAt = 0;
    this.loginPromise = null;
    this.refreshPromise = null;
  }

  get siteUrl() {
    return this.baseUrl;
  }

  async login() {
    if (!this.username || !this.password || !this.baseUrl) {
      throw new NukiyasuError("Falta configurar la cuenta de Nukiyasu.", { code: "configuration" });
    }

    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      try {
        const uuid = randomUUID();
        const response = await this.http.request({
          method: "POST",
          url: "/api/auth/login",
          data: { usernameOrEmail: this.username, password: this.password, uuid },
          headers: { "X-Token-Transport": "body" },
          timeout: this.timeoutMs
        });
        const body = response.data || {};
        if (!body.accessToken || !body.refreshToken) {
          throw new NukiyasuError("Nukiyasu no devolvió tokens de acceso.", { code: "auth" });
        }
        this.uuid = body.uuid || uuid;
        this.accessToken = body.accessToken;
        this.refreshToken = body.refreshToken;
        this.accessTokenExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_MS;
        return body.user || null;
      } catch (error) {
        if (error instanceof NukiyasuError) throw error;
        throw this.toError(error, "No se pudo autenticar en Nukiyasu.");
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  async refresh() {
    if (!this.refreshToken || !this.uuid) return this.login();
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const response = await this.http.request({
          method: "POST",
          url: "/api/auth/refresh",
          data: { uuid: this.uuid },
          headers: { Authorization: `Bearer ${this.refreshToken}`, "X-Token-Transport": "body" },
          timeout: this.timeoutMs
        });
        const body = response.data || {};
        if (!body.accessToken || !body.refreshToken) {
          throw new NukiyasuError("Nukiyasu no devolvió tokens renovados.", { code: "auth" });
        }
        this.accessToken = body.accessToken;
        this.refreshToken = body.refreshToken;
        this.accessTokenExpiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_MS;
      } catch (error) {
        this.accessToken = null;
        this.refreshToken = null;
        this.accessTokenExpiresAt = 0;
        if (error instanceof NukiyasuError) throw error;
        throw this.toError(error, "No se pudo renovar la sesión de Nukiyasu.");
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  async ensureToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return;
    if (this.refreshToken) {
      await this.refresh();
    } else {
      await this.login();
    }
  }

  toError(error, fallback) {
    const status = error?.response?.status || null;
    if (status === 401 || status === 403) {
      return new NukiyasuError(status === 401 ? "La sesión de Nukiyasu no es válida." : "La cuenta de Nukiyasu no tiene acceso a este contenido.", {
        code: status === 401 ? "auth" : "access",
        status,
        cause: error
      });
    }
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || !error?.response) {
      return new NukiyasuError(fallback, { code: "connectivity", status, cause: error });
    }
    return new NukiyasuError(`${fallback} (${status || "error HTTP"}).`, { code: "http", status, cause: error });
  }

  async request(path, { method = "GET", data, params, responseType, retryAuth = true, returnResponse = false } = {}) {
    await this.ensureToken();
    try {
      const response = await this.http.request({
        method,
        url: `/api${path}`,
        data,
        params,
        responseType,
        timeout: this.timeoutMs,
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      return returnResponse ? response : response.data;
    } catch (error) {
      if (retryAuth && error?.response?.status === 401) {
        await this.refresh();
        return this.request(path, { method, data, params, responseType, retryAuth: false, returnResponse });
      }
      throw this.toError(error, `Error consultando Nukiyasu en ${path}`);
    }
  }

  async listSeries({ variant = "all", page = 1, limit = 100, ...filters } = {}) {
    const body = await this.request(`/series/${encodeURIComponent(variant)}`, {
      params: { page, limit, ...filters }
    });
    const result = parsePage(body);
    const normalized = result.data.map(normalizeSeries).filter(Boolean);
    const available = normalized.filter(isAvailableSeries);
    const visible = available.filter(item => matureContentAllowed() || !item.isMature);
    return {
      ...result,
      data: visible,
      counts: {
        received: result.rawCount,
        valid: available.length,
        excluded: result.rawCount - available.length,
        policyExcluded: available.length - visible.length,
        visible: visible.length
      }
    };
  }

  async listBooks({ variant = "all", page = 1, limit = 100, ...filters } = {}) {
    const body = await this.request(`/books/${encodeURIComponent(variant)}`, {
      params: { page, limit, ...filters }
    });
    const result = parsePage(body);
    const normalized = result.data.map(normalizeBook).filter(Boolean);
    const available = normalized.filter(isAvailableBook);
    return {
      ...result,
      data: available,
      counts: {
        received: result.rawCount,
        valid: available.length,
        excluded: result.rawCount - available.length,
        policyExcluded: 0,
        visible: available.length
      }
    };
  }

  async fetchAllPages(loader, {
    limit = 100,
    maxPages = Number(process.env.NUKIYASU_MAX_PAGES) || 1000
  } = {}) {
    const all = [];
    const seenPages = new Set();
    const stats = { pages: 0, received: 0, valid: 0, excluded: 0, policyExcluded: 0, visible: 0 };
    let page = 1;
    let expectedPages = null;
    while (page <= maxPages) {
      const result = await loader(page);
      if (!result || !Array.isArray(result.data)) {
        throw new NukiyasuError("Respuesta paginada incompleta de Nukiyasu.", { code: "incomplete" });
      }
      const rawCount = Number.isInteger(result.rawCount) ? result.rawCount : result.data.length;
      const signature = result.pageSignature || (rawCount ? pageSignature(result.data) : null);
      if (signature && seenPages.has(signature)) {
        throw new NukiyasuError(`Nukiyasu repitió la página ${page}; se descarta la sincronización incompleta.`, { code: "incomplete" });
      }
      if (signature) seenPages.add(signature);

      all.push(...result.data);
      stats.pages++;
      stats.received += rawCount;
      stats.valid += result.counts?.valid ?? result.data.length;
      stats.excluded += result.counts?.excluded ?? Math.max(0, rawCount - result.data.length);
      stats.policyExcluded += result.counts?.policyExcluded ?? 0;
      stats.visible += result.counts?.visible ?? result.data.length;
      expectedPages = result.pages || expectedPages;
      if (rawCount === 0 && expectedPages != null && page < expectedPages) {
        throw new NukiyasuError(`Nukiyasu devolvió una página vacía antes de completar el catálogo (página ${page}).`, { code: "incomplete" });
      }
      if (expectedPages != null && page >= expectedPages) break;
      if (rawCount === 0 || (expectedPages == null && rawCount < limit)) break;
      page += 1;
    }
    if (page > maxPages) {
      throw new NukiyasuError("El catálogo de Nukiyasu superó el máximo de páginas permitido.", { code: "incomplete" });
    }
    Object.defineProperty(all, "stats", { value: stats, enumerable: false });
    return all;
  }

  async searchSeries(name, { variant = "all", page = 1, limit = 10 } = {}) {
    return this.listSeries({ variant, page, limit, name });
  }

  async getSeriesById(id) {
    const body = await this.request(`/series/serie/${encodeURIComponent(id)}`);
    const series = normalizeSeries(body?.serieData || body?.data || body);
    if (!series || !isAvailableSeries(series) || (series.isMature && !matureContentAllowed())) {
      throw new NukiyasuError("La obra no está disponible para la cuenta configurada.", { code: "access", status: 404 });
    }
    return series;
  }

  async getBooksBySeries(id, { variant = "all" } = {}) {
    const body = await this.request(`/books/${encodeURIComponent(variant)}`, {
      params: { serie: id, sort: "sortName" }
    });
    const data = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(data)) throw new NukiyasuError("Nukiyasu devolvió volúmenes inválidos.", { code: "data" });
    return data.map(normalizeBook).filter(Boolean).filter(isAvailableBook);
  }

  async getBookById(id) {
    const body = await this.request(`/books/book/${encodeURIComponent(id)}`);
    const book = normalizeBook(body?.bookData || body?.book || body?.data || body);
    if (!book || !isAvailableBook(book)) throw new NukiyasuError("El volumen no está disponible.", { code: "access", status: 404 });
    return book;
  }

  async fetchCatalog() {
    const pageLimit = 100;
    const series = await this.fetchAllPages(
      page => this.listSeries({ variant: "all", page, limit: pageLimit }),
      { limit: pageLimit }
    );
    const visibleSeries = series.filter(seriesItem => !seriesItem.isMature || matureContentAllowed());
    const allowedSeries = new Set(visibleSeries.map(item => item._id));
    const books = await this.fetchAllPages(
      page => this.listBooks({ variant: "all", page, limit: pageLimit }),
      { limit: pageLimit }
    );
    const visibleBooks = books.filter(book => allowedSeries.has(book.serie));
    const counts = {
      series: { ...series.stats, visible: visibleSeries.length },
      books: {
        ...books.stats,
        excludedBySeries: books.length - visibleBooks.length,
        visible: visibleBooks.length
      }
    };
    console.log(`[nukiyasu] Catálogo paginado: series recibidas=${counts.series.received}, válidas=${counts.series.valid}, excluidas=${counts.series.excluded + counts.series.policyExcluded}, visibles=${counts.series.visible}; volúmenes recibidos=${counts.books.received}, válidos=${counts.books.valid}, excluidos=${counts.books.excluded + counts.books.excludedBySeries}, visibles=${counts.books.visible}.`);
    return { series: visibleSeries, books: visibleBooks, counts, fetchedAt: new Date() };
  }

  seriesUrl(id) {
    const url = new URL(this.siteUrl);
    url.username = "";
    url.password = "";
    return `${url.toString().replace(/\/$/, "")}/app/series/${encodeURIComponent(id)}`;
  }

  coverPath(entity, type = "series") {
    if (!entity?.thumbnailPath) return null;
    if (type === "series") {
      const folder = libraryFolder(entity.variant);
      return `/static/${folder}/${entity.thumbnailPath}`;
    }
    const folder = libraryFolder(entity.variant);
    if (entity.mokured || entity.format === "mokuro") {
      return `/static/novelas/${encodeURIComponent(entity.seriePath)}/${encodeURIComponent(entity.imagesFolder)}/${encodeURIComponent(entity.thumbnailPath)}`;
    }
    if (IMAGE_VARIANTS.has(entity.variant)) {
      return `/static/${folder}/${encodeURIComponent(entity.seriePath)}/${encodeURIComponent(entity.imagesFolder)}/${encodeURIComponent(entity.thumbnailPath)}`;
    }
    return `/static/novelas/${encodeURIComponent(entity.seriePath)}/${encodeURIComponent(entity.thumbnailPath)}`;
  }

  async downloadCover(entity, type = "series") {
    const relative = this.coverPath(entity, type);
    if (!relative) return null;
    try {
      const response = await this.request(relative, { responseType: "arraybuffer", returnResponse: true });
      const data = response.data;
      const contentType = response.headers?.["content-type"] || "image/jpeg";
      const extension = String(contentType).split("/")[1]?.split(";")[0] || "jpg";
      return {
        attachment: Buffer.from(data),
        filename: `nukiyasu-${type}-${entity._id}.${extension}`,
        contentType
      };
    } catch (error) {
      if (error.code === "auth" || error.code === "access") throw error;
      return null;
    }
  }
}

let sharedClient;

export function getNukiyasuClient() {
  sharedClient ||= new NukiyasuClient();
  return sharedClient;
}

export function resetNukiyasuClient() {
  sharedClient = null;
}
