import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffCatalogs, mergeUniqueBooks } from "../lib/nukiyasuDetector.js";
import { rebuildNukiyasuBaseline, reconcileCatalog } from "../lib/nukiyasuChanges.js";
import { claimDelivery, getRecentChanges, getSyncState, markDeliveryFailed, markDeliverySent, readActiveSnapshot, setGuildConfig } from "../lib/nukiyasuStore.js";
import { createFetchHttp, NukiyasuClient, seriesAutocompleteChoices } from "../lib/nukiyasuClient.js";
import { connectNukiyasuSocket } from "../lib/nukiyasuSocket.js";
import { respondAutocompleteSafely, respondSafely } from "../lib/interactionResponse.js";
import { buildPendingAnnouncementContent, discordCoverFilename } from "../lib/nukiyasuPresentation.js";

function getValue(document, key) {
  return key.split(".").reduce((value, part) => value?.[part], document);
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = getValue(document, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$ne" in expected && actual === expected.$ne) return false;
      if ("$in" in expected && !expected.$in.includes(actual)) return false;
      if ("$lte" in expected && !(actual <= expected.$lte)) return false;
      if ("$lt" in expected && !(actual < expected.$lt)) return false;
      return true;
    }
    return actual === expected;
  });
}

function applyUpdate(document, update, isInsert = false) {
  const result = { ...document };
  for (const [key, value] of Object.entries(update.$set || {})) result[key] = value;
  if (isInsert) for (const [key, value] of Object.entries(update.$setOnInsert || {})) result[key] = value;
  for (const [key, value] of Object.entries(update.$inc || {})) result[key] = (result[key] || 0) + value;
  for (const key of Object.keys(update.$unset || {})) delete result[key];
  return result;
}

class FakeCollection {
  constructor() {
    this.documents = new Map();
  }

  async findOne(query) {
    return [...this.documents.values()].find(document => matches(document, query)) || null;
  }

  find(query) {
    let values = [...this.documents.values()].filter(document => matches(document, query));
    const cursor = {
      sort: ordering => {
        const [[field, direction]] = Object.entries(ordering);
        values.sort((a, b) => (getValue(a, field) > getValue(b, field) ? direction : -direction));
        return cursor;
      },
      limit: count => {
        values = values.slice(0, count);
        return cursor;
      },
      toArray: async () => values
    };
    return cursor;
  }

  async updateOne(query, update, { upsert = false } = {}) {
    const found = await this.findOne(query);
    if (found) {
      this.documents.set(found._id, applyUpdate(found, update));
      return;
    }
    if (!upsert) return;
    const base = { ...(query._id ? { _id: query._id } : {}), ...update.$setOnInsert };
    const created = applyUpdate(base, update, true);
    this.documents.set(created._id, created);
  }

  async updateMany(query, update) {
    for (const document of [...this.documents.values()]) {
      if (matches(document, query)) this.documents.set(document._id, applyUpdate(document, update));
    }
  }

  async bulkWrite(operations) {
    for (const operation of operations) {
      const replacement = operation.replaceOne.replacement;
      this.documents.set(replacement._id, replacement);
    }
  }

  async deleteMany(query) {
    for (const document of [...this.documents.values()]) if (matches(document, query)) this.documents.delete(document._id);
  }
}

function series(id, variant = "manga") {
  return { _id: id, variant, visibleName: `Serie ${id}`, sortName: `Serie ${id}`, bookCount: 2, missing: false, isMature: false };
}

function book(id, serieId) {
  return { _id: id, serie: serieId, variant: "manga", visibleName: `Tomo ${id}`, sortName: `Tomo ${id}`, missing: false };
}

test("diffCatalogs identifica series y volúmenes por _id", () => {
  const previous = { series: [series("a")], books: [book("a-1", "a")] };
  const current = { series: [series("a"), series("b")], books: [book("a-1", "a"), book("a-2", "a"), book("b-1", "b")] };
  const diff = diffCatalogs(previous, current);
  assert.deepEqual(diff.newSeries.map(item => item._id), ["b"]);
  assert.deepEqual(diff.newBooks.map(item => item._id), ["a-2", "b-1"]);
});

test("mergeUniqueBooks evita duplicados y conserva una lista estable", () => {
  const merged = mergeUniqueBooks([book("2", "a")], [book("1", "a"), book("2", "a")]);
  assert.deepEqual(merged.map(item => item._id), ["1", "2"]);
});

test("la primera reconciliación sólo crea la línea base", async () => {
  const db = new FakeCollection();
  const client = { fetchCatalog: async () => ({ series: [series("a")], books: [book("a-1", "a")] }) };
  const result = await reconcileCatalog(client, db, { trigger: "test" });
  assert.equal(result.baseline, true);
  assert.equal((await db.find({ kind: "nukiyasuPending" }).toArray()).length, 0);
  assert.equal((await getSyncState(db)).baselineReady, true);
});

test("la reconstrucción de línea base completa no crea avisos históricos", async () => {
  const db = new FakeCollection();
  const client = { fetchCatalog: async () => ({
    series: [series("a")],
    books: Array.from({ length: 146 }, (_, index) => book(`a-${index + 1}`, "a"))
  }) };
  const result = await rebuildNukiyasuBaseline(client, db);
  assert.equal(result.rebuilt, true);
  assert.equal((await readActiveSnapshot(db)).books.length, 146);
  assert.equal((await db.find({ kind: "nukiyasuPending" }).toArray()).length, 0);
});

test("una serie que llega por fases comparte una única novedad pendiente", async () => {
  process.env.NUKIYASU_STABILIZATION_MS = "600000";
  process.env.NUKIYASU_MAX_STABILIZATION_MS = "3600000";
  const db = new FakeCollection();
  let catalog = { series: [series("base")], books: [book("base-1", "base")] };
  const client = { fetchCatalog: async () => catalog };
  await reconcileCatalog(client, db, { trigger: "test" });

  catalog = { series: [series("base"), series("new")], books: [book("base-1", "base"), book("new-1", "new")] };
  await reconcileCatalog(client, db, { trigger: "socket" });
  catalog = { series: [series("base"), series("new")], books: [book("base-1", "base"), book("new-1", "new"), book("new-2", "new")] };
  await reconcileCatalog(client, db, { trigger: "poll" });

  const pending = await db.find({ kind: "nukiyasuPending", seriesId: "new" }).toArray();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].books.map(item => item._id), ["new-1", "new-2"]);
  assert.equal(pending[0].status, "pending");
});

test("una importación de 20 volúmenes queda en un único anuncio pendiente", async () => {
  const db = new FakeCollection();
  const baseBooks = [book("base-1", "base")];
  const importedBooks = Array.from({ length: 20 }, (_, index) => book(`new-${index + 1}`, "new"));
  let catalog = { series: [series("base")], books: baseBooks };
  const client = { fetchCatalog: async () => catalog };
  await reconcileCatalog(client, db, { trigger: "test" });
  catalog = { series: [series("base"), series("new")], books: [...baseBooks, ...importedBooks] };
  await reconcileCatalog(client, db, { trigger: "socket" });
  const pending = await db.find({ kind: "nukiyasuPending", seriesId: "new" }).toArray();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].books.length, 20);
});

test("una reconciliación fallida conserva el snapshot activo", async () => {
  const db = new FakeCollection();
  let failed = false;
  const client = {
    fetchCatalog: async () => {
      if (failed) throw Object.assign(new Error("timeout"), { code: "connectivity" });
      return { series: [series("a")], books: [book("a-1", "a")] };
    }
  };
  await reconcileCatalog(client, db, { trigger: "test" });
  const before = (await getSyncState(db)).activeSnapshotVersion;
  failed = true;
  await assert.rejects(() => reconcileCatalog(client, db, { trigger: "poll" }));
  const after = (await getSyncState(db)).activeSnapshotVersion;
  assert.equal(after, before);
  assert.equal((await readActiveSnapshot(db)).series[0]._id, "a");
});

test("un catálogo incompleto no reemplaza una línea base válida", async () => {
  const db = new FakeCollection();
  const complete = { series: [series("stable")], books: [book("stable-1", "stable")] };
  let incomplete = false;
  const client = {
    fetchCatalog: async () => {
      if (incomplete) throw Object.assign(new Error("página repetida"), { code: "incomplete" });
      return complete;
    }
  };
  await reconcileCatalog(client, db, { trigger: "test" });
  const before = (await getSyncState(db)).activeSnapshotVersion;
  incomplete = true;
  await assert.rejects(() => reconcileCatalog(client, db, { trigger: "repeated-page" }), error => error.code === "incomplete");
  assert.equal((await getSyncState(db)).activeSnapshotVersion, before);
  assert.deepEqual((await readActiveSnapshot(db)).books.map(item => item._id), ["stable-1"]);
});

test("un fallo transitorio de sincronización permite reintentar sin detener el bot", async () => {
  const db = new FakeCollection();
  let attempts = 0;
  const client = {
    fetchCatalog: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("timeout"), { code: "connectivity" });
      return { series: [series("retry")], books: [book("retry-1", "retry")] };
    }
  };
  await assert.rejects(() => reconcileCatalog(client, db, { trigger: "poll" }));
  const result = await reconcileCatalog(client, db, { trigger: "poll-retry" });
  assert.equal(result.baseline, true);
  assert.equal(attempts, 2);
});

test("el cliente autentica, busca texto japonés y pagina el catálogo", async () => {
  delete process.env.NUKIYASU_ALLOW_MATURE;
  const calls = [];
  const http = {
    request: async request => {
      calls.push(request);
      if (request.url === "/api/auth/login") {
        return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      }
      if (request.url === "/api/series/all") {
        return { data: { data: [
          { _id: "1", variant: "manga", visibleName: "ぼっち・ざ・ろっく！", bookCount: 1, missing: false },
          { _id: "mature", variant: "doujinshi", visibleName: "Privada", bookCount: 1, missing: false, isMature: true }
        ], pages: 1 } };
      }
      throw new Error(`Unexpected request ${request.url}`);
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  const result = await client.searchSeries("ぼっち・ざ・ろっく！", { limit: 10 });
  assert.equal(result.data[0].visibleName, "ぼっち・ざ・ろっく！");
  assert.equal(result.data.length, 1);
  assert.equal(calls.at(-1).params.name, "ぼっち・ざ・ろっく！");
  assert.equal(calls.at(-1).headers.Authorization, "Bearer access-1");
  assert.deepEqual(seriesAutocompleteChoices(result.data), [{
    name: "ぼっち・ざ・ろっく！ · Manga",
    value: "1"
  }]);
});

test("una respuesta HTTP 400 al consultar una obra se convierte en error controlado", async () => {
  const http = {
    request: async request => {
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      throw Object.assign(new Error("Bad Request"), { response: { status: 400 } });
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  await assert.rejects(() => client.getSeriesById("123"), error => error.code === "http" && error.status === 400);
});

test("el transporte HTTP conserva los parámetros de búsqueda y paginación", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return {
      ok: true,
      headers: { entries: () => [] },
      text: async () => "{}"
    };
  };
  try {
    const http = createFetchHttp("http://nukiyasu", 1000);
    await http.request({ url: "/api/series/all", params: { name: "ぼっち・ざ・ろっく！", page: 2, limit: 10 } });
    assert.equal(requestedUrl, "http://nukiyasu/api/series/all?name=%E3%81%BC%E3%81%A3%E3%81%A1%E3%83%BB%E3%81%96%E3%83%BB%E3%82%8D%E3%81%A3%E3%81%8F%EF%BC%81&page=2&limit=10");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchAllPages recorre todas las páginas y no acepta una respuesta incompleta", async () => {
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http: { request: async () => ({ data: {} }) } });
  const pages = await client.fetchAllPages(async page => ({
    data: page === 1 ? Array.from({ length: 100 }, (_, index) => index) : [100],
    pages: 2
  }));
  assert.equal(pages.length, 101);
  await assert.rejects(() => client.fetchAllPages(async () => null), error => error.code === "incomplete");
});

test("fetchCatalog no se detiene en los primeros 100 volúmenes del endpoint en array", async () => {
  const books = Array.from({ length: 146 }, (_, index) => ({ ...book(`book-${index + 1}`, "series-1") }));
  const http = {
    request: async request => {
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      if (request.url === "/api/series/all") return { data: { data: [series("series-1")], pages: 1 } };
      if (request.url === "/api/books/all") {
        const page = Number(request.params.page);
        return { data: page === 1 ? books.slice(0, 100) : books.slice(100) };
      }
      throw new Error(`Unexpected request ${request.url}`);
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  const catalog = await client.fetchCatalog();
  assert.equal(catalog.books.length, 146);
  assert.equal(catalog.counts.books.received, 146);
  assert.equal(catalog.counts.books.visible, 146);
});

test("la paginación de series supera 500 registros y cuenta los filtros", async () => {
  delete process.env.NUKIYASU_ALLOW_MATURE;
  const rawSeries = Array.from({ length: 503 }, (_, index) => ({
    ...series(`series-${index + 1}`),
    missing: index === 0,
    bookCount: index === 1 ? 0 : 2,
    isMature: index === 2
  }));
  const calls = [];
  const http = {
    request: async request => {
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      if (request.url !== "/api/series/all") throw new Error(`Unexpected request ${request.url}`);
      calls.push(request.params);
      const page = Number(request.params.page);
      const limit = Number(request.params.limit);
      return { data: rawSeries.slice((page - 1) * limit, page * limit), pages: Math.ceil(rawSeries.length / limit) };
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  const result = await client.fetchAllPages(page => client.listSeries({ variant: "all", page, limit: 100 }), { limit: 100 });
  assert.equal(result.length, 500);
  assert.deepEqual(result.stats, { pages: 6, received: 503, valid: 501, excluded: 2, policyExcluded: 1, visible: 500 });
  assert.deepEqual(calls.map(call => Number(call.page)), [1, 2, 3, 4, 5, 6]);
  assert.ok(calls.every(call => Number(call.limit) === 100));
});

test("la paginación de volúmenes supera 500 registros antes y después de filtrar", async () => {
  const rawBooks = Array.from({ length: 503 }, (_, index) => ({
    ...book(`large-${index + 1}`, "series-1"),
    missing: index % 10 === 0
  }));
  const http = {
    request: async request => {
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      if (request.url !== "/api/books/all") throw new Error(`Unexpected request ${request.url}`);
      const page = Number(request.params.page);
      const limit = Number(request.params.limit);
      return { data: rawBooks.slice((page - 1) * limit, page * limit) };
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  const result = await client.fetchAllPages(page => client.listBooks({ variant: "all", page, limit: 100 }), { limit: 100 });
  assert.equal(result.length, 452);
  assert.equal(result.stats.received, 503);
  assert.equal(result.stats.valid, 452);
  assert.equal(result.stats.excluded, 51);
  assert.equal(result.stats.visible, 452);
});

test("una página repetida o vacía antes del final invalida la descarga", async () => {
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http: { request: async () => ({ data: {} }) } });
  await assert.rejects(
    () => client.fetchAllPages(async () => ({ data: [{ _id: "same" }], rawCount: 1, pageSignature: "same" }), { limit: 1, maxPages: 3 }),
    error => error.code === "incomplete" && /repitió la página/.test(error.message)
  );
  await assert.rejects(
    () => client.fetchAllPages(async page => ({ data: page === 1 ? [{ _id: "one" }] : [], rawCount: page === 1 ? 1 : 0, pages: 3 }), { limit: 1 }),
    error => error.code === "incomplete" && /página vacía/.test(error.message)
  );
  const exactMultiple = await client.fetchAllPages(async page => ({
    data: page < 3 ? Array.from({ length: 100 }, (_, index) => ({ _id: `${page}-${index}` })) : [],
    rawCount: page < 3 ? 100 : 0
  }), { limit: 100 });
  assert.equal(exactMultiple.length, 200);
});

test("el cliente renueva un JWT caducado y descarga portadas autenticadas", async () => {
  const calls = [];
  const http = {
    request: async request => {
      calls.push(request);
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      if (request.url === "/api/auth/refresh") return { data: { uuid: "uuid-1", accessToken: "access-2", refreshToken: "refresh-2" } };
      return { data: Buffer.from("cover-bytes"), headers: { "content-type": "image/png" } };
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  const coverEntity = { _id: "1", variant: "manga", thumbnailPath: "cover.png" };
  const first = await client.downloadCover(coverEntity, "series");
  client.accessTokenExpiresAt = 0;
  const second = await client.downloadCover(coverEntity, "series");
  assert.equal(first.filename, "nukiyasu-series-1.png");
  assert.equal(second.attachment.toString(), "cover-bytes");
  assert.equal(calls.filter(request => request.url === "/api/auth/refresh").length, 1);
  assert.equal(calls.at(-1).headers.Authorization, "Bearer access-2");
});

test("el cliente rechaza una obra madura cuando la política está desactivada", async () => {
  delete process.env.NUKIYASU_ALLOW_MATURE;
  const http = {
    request: async request => {
      if (request.url === "/api/auth/login") return { data: { uuid: "uuid-1", accessToken: "access-1", refreshToken: "refresh-1" } };
      return { data: { _id: "mature", variant: "doujinshi", visibleName: "Privada", bookCount: 1, missing: false, isMature: true } };
    }
  };
  const client = new NukiyasuClient({ baseUrl: "http://nukiyasu", username: "bot", password: "secret", http });
  await assert.rejects(() => client.getSeriesById("mature"), error => error.code === "access");
});

test("el listener Socket.IO reacciona a LIBRARY_UPDATE y responde al ping", () => {
  const OriginalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }
    emit(name, data) {
      this.listeners.get(name)?.(data);
    }
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.emit("close", {});
    }
  }
  const received = [];
  globalThis.WebSocket = FakeWebSocket;
  try {
    const connection = connectNukiyasuSocket({
      baseUrl: "http://nukiyasu",
      onLibraryUpdate: payload => received.push(payload)
    });
    const socket = FakeWebSocket.instances[0];
    socket.emit("message", { data: "0{\"sid\":\"socket-1\"}" });
    socket.emit("message", { data: "2" });
    socket.emit("message", { data: "42/ws,[\"notification\",{\"action\":\"LIBRARY_UPDATE\"}]" });
    assert.equal(socket.sent[0], "40/ws,");
    assert.equal(socket.sent[1], "3");
    assert.equal(received.length, 1);
    connection.close();
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test("las respuestas de interacción respetan deferred, replied y reply", async () => {
  const calls = [];
  const deferred = {
    deferred: true,
    replied: false,
    editReply: async payload => calls.push(["editReply", payload]),
    reply: async () => calls.push(["unexpected-reply"]),
    followUp: async () => calls.push(["unexpected-followUp"])
  };
  const replied = {
    deferred: false,
    replied: true,
    editReply: async () => calls.push(["unexpected-edit"]),
    reply: async () => calls.push(["unexpected-reply"]),
    followUp: async payload => calls.push(["followUp", payload])
  };
  const fresh = {
    deferred: false,
    replied: false,
    reply: async payload => calls.push(["reply", payload]),
    editReply: async () => calls.push(["unexpected-edit"]),
    followUp: async () => calls.push(["unexpected-followUp"])
  };
  await respondSafely(deferred, { content: "a" });
  await respondSafely(replied, { content: "b" });
  await respondSafely(fresh, { content: "c" });
  assert.deepEqual(calls.map(([method]) => method), ["editReply", "followUp", "reply"]);
});

test("un fallo al responder autocomplete no se propaga al proceso", async () => {
  let attempted = false;
  await respondAutocompleteSafely({
    commandName: "nukiyasu",
    respond: async () => {
      attempted = true;
      throw new Error("interaction expired");
    }
  }, []);
  assert.equal(attempted, true);
});

test("un fallo de Discord al responder una interacción queda absorbido", async () => {
  await respondSafely({
    deferred: true,
    replied: false,
    editReply: async () => { throw new Error("Discord unavailable"); },
    reply: async () => { throw new Error("unexpected"); },
    followUp: async () => { throw new Error("unexpected"); }
  }, { content: "error" });
});

test("configuración y novedades sin historial tienen estados seguros", async () => {
  const db = new FakeCollection();
  assert.deepEqual(await getRecentChanges(db, 10), []);
  const saved = await setGuildConfig(db, "guild-1", { channelId: "channel-1", enabled: true });
  assert.equal(saved.channelId, "channel-1");
  assert.equal(saved.enabled, true);
});

test("las entregas conservan intentos, permiten reintentos y evitan duplicados sent", async () => {
  const db = new FakeCollection();
  const now = new Date("2026-01-01T00:00:00.000Z");

  assert.equal(await claimDelivery(db, "pending-1", "guild-1", now), true);
  let delivery = await db.findOne({ _id: "nukiyasu:delivery:pending-1:guild-1" });
  assert.equal(delivery.status, "sending");
  assert.equal(delivery.attempts, 1);
  assert.equal(await claimDelivery(db, "pending-1", "guild-1", now), false);

  await markDeliverySent(db, "pending-1", "guild-1");
  delivery = await db.findOne({ _id: "nukiyasu:delivery:pending-1:guild-1" });
  assert.equal(delivery.status, "sent");
  assert.equal(await claimDelivery(db, "pending-1", "guild-1", new Date(now.getTime() + 5 * 60_000)), false);

  assert.equal(await claimDelivery(db, "pending-2", "guild-1", now), true);
  await markDeliveryFailed(db, "pending-2", "guild-1", new Error("Discord temporal"));
  delivery = await db.findOne({ _id: "nukiyasu:delivery:pending-2:guild-1" });
  assert.equal(delivery.status, "pending");
  assert.match(delivery.lastError, /Discord temporal/);
  assert.equal(await claimDelivery(db, "pending-2", "guild-1", new Date(Date.now() + 61_000)), true);
  delivery = await db.findOne({ _id: "nukiyasu:delivery:pending-2:guild-1" });
  assert.equal(delivery.status, "sending");
  assert.equal(delivery.attempts, 2);
});

test("las obras nuevas muestran disponibilidad sin enumerar volúmenes", () => {
  const content = buildPendingAnnouncementContent({
    type: "series",
    series: { visibleName: "みつどもえ", variant: "manga", bookCount: 20 },
    books: Array.from({ length: 20 }, (_, index) => ({ visibleName: `mitsudomoeV${String(index + 1).padStart(2, "0")}` }))
  });
  assert.equal(content.title, "Nueva obra disponible: みつどもえ");
  assert.equal(content.description, "Manga · 20 volúmenes disponibles.");
});

test("los volúmenes nuevos muestran sus números solo cuando son fiables", () => {
  const plural = buildPendingAnnouncementContent({
    type: "volumes",
    series: { visibleName: "ラブひな", variant: "manga", bookCount: 9 },
    books: [{ visibleName: "lovehinaV08" }, { visibleName: "lovehinaV09" }]
  });
  assert.equal(plural.title, "Nuevos volúmenes: ラブひな");
  assert.match(plural.description, /Volúmenes incorporados: 8 y 9\./);
  assert.match(plural.description, /Manga · 9 volúmenes disponibles\./);

  const single = buildPendingAnnouncementContent({
    type: "volumes",
    series: { visibleName: "ラブひな", variant: "manga", bookCount: 9 },
    books: [{ visibleName: "lovehinaV08" }]
  });
  assert.equal(single.title, "Nuevo volumen: ラブひな");
  assert.match(single.description, /Volumen 8 disponible\./);

  const unknown = buildPendingAnnouncementContent({
    type: "volumes",
    series: { visibleName: "Obra", variant: "novela", bookCount: 4 },
    books: [{ visibleName: "edición especial" }]
  });
  assert.match(unknown.description, /Se incorporó un nuevo volumen\./);
  assert.doesNotMatch(unknown.description, /Volumen undefined/);
});

test("las portadas de doujinshi se envían como spoiler", () => {
  assert.equal(discordCoverFilename("nukiyasu-series-1.jpg", "doujinshi"), "SPOILER_nukiyasu-series-1.jpg");
  assert.equal(discordCoverFilename("nukiyasu-series-1.jpg", "manga"), "nukiyasu-series-1.jpg");
});

test("el subcomando configurar no aplica permisos sobre un builder de subcomando", async () => {
  const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../commands/slash/nukiyasu.js");
  const source = await fs.readFile(filePath, "utf8");

  assert.equal(source.includes(".setDefaultMemberPermissions("), false);
  assert.equal(source.includes('setName("id")'), false);
  assert.match(source, /setName\("titulo"\)/);
  assert.match(source, /async autocomplete\(interaction\)/);
  assert.match(source, /async function executeConfig\(interaction\)/);
  assert.match(source, /if \(!interaction\.inGuild\(\) \|\| !isAdmin\(interaction\)\)/);
  const uiSource = await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/nukiyasuUi.js"), "utf8");
  assert.equal(uiSource.includes(".setURL("), false);
  assert.equal(uiSource.includes("]("), false);
});
