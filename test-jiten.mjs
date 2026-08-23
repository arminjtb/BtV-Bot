// Prueba lib/jiten.js solo (sin Discord, sin Mongo real). Corre:
//
//   node test-jiten.mjs
//
// (si tu instancia de Jiten no es https://api.jiten.moe, usá JITEN_API_BASE=https://tu-dominio)

import jiten from "./lib/jiten.js";

// AniList id de algo que sepas que está en Jiten. Re:Zero = 21355 (ya confirmado que resuelve a
// deckId 30688 en la instancia pública).
const ANILIST_TEST_ID = 21355;

// Fake db en memoria, mismo shape mínimo que espera jiten.js: findOne / updateOne con upsert.
function makeFakeDb() {
  const store = new Map();
  return {
    async findOne(query) {
      return store.get(query._id) || null;
    },
    async updateOne(query, update) {
      const existing = store.get(query._id) || {};
      store.set(query._id, { ...existing, ...update.$set });
    }
  };
}

async function main() {
  console.log("=== 1) Listando decks de Jiten (Anime / género Comedy, id=3) ===");
  const decks = await jiten.listDecksForJitenFilter(1, { kind: "genre", id: "3" }, { limit: 5 });
  console.log(`${decks.length} decks recibidos:`, decks);

  console.log("\n=== 2) Resolviendo AniList id", ANILIST_TEST_ID, "a un deck de Jiten y trayendo género/tags ===");
  const db = makeFakeDb();
  const matches = await jiten.logMatchesChallengeFilter(db, "anime", ANILIST_TEST_ID, {
    kind: "genre",
    id: "3" // Comedy
  });
  console.log("¿Matchea género Comedy? (true/false/null=no se pudo verificar):", matches);
  console.log("Info cacheada:", await db.findOne({ _id: `jiten-deck:anime:${ANILIST_TEST_ID}` }));

  console.log("\nListo. Si viste warnings/errors de [jiten] arriba, mándamelos junto con esto.");
}

main().catch(err => {
  console.error("Error corriendo la prueba:", err);
  process.exit(1);
});
