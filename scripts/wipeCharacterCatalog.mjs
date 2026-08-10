// scripts/wipeCharacterCatalog.mjs
//
// Borra TODO el catálogo de personajes (documentos "character"), los que la gente ya se ganó
// (characterOwned) y todos los eventos (dailyCharacterEvent, sean activos/completados/expirados),
// y resetea el cache de catalogación de cada obra elegible (catalogFetchedAt) para que la próxima
// vez que se necesiten, se recataloguen desde cero — ya con la clave de personaje nueva que incluye
// la obra (character:${source}:${charId}:${workType}:${workContentId}), así que un personaje que
// aparece en más de una obra (p.ej. Rance en Rance VI y Rance VII) ya no se pisa entre obras.
//
// ADVERTENCIA: esto es destructivo y no distingue entre personajes de prueba y reclamados de verdad.
// Se pierde el historial de quién ganó qué. Pensado para usarse solo mientras se está probando el
// sistema, no en producción con ganadores reales que se quieran conservar.
//
// Uso:
//   node scripts/wipeCharacterCatalog.mjs --dry-run   // solo muestra qué borraría
//   node scripts/wipeCharacterCatalog.mjs --yes        // confirma y borra de verdad
//
// Requiere MONGODB_URI (.env en la raíz, igual que el bot).

import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    confirmed: argv.includes("--yes")
  };
}

async function main() {
  const { dryRun, confirmed } = parseArgs(process.argv.slice(2));

  if (!process.env.MONGODB_URI) {
    console.error("Falta MONGODB_URI en el entorno (.env).");
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db("nihongotracker").collection("btv");
  console.log(`Mongo conectado.${dryRun ? " (--dry-run: no se va a escribir nada)" : ""}`);

  const characters = await db.find({ kind: "character" }).toArray();
  const owned = await db.find({ kind: "characterOwned" }).toArray();
  const events = await db.find({ kind: "dailyCharacterEvent" }).toArray();
  const works = await db.find({ kind: "eligibleWork" }).toArray();

  console.log(`\nPersonajes (character): ${characters.length}`);
  console.log(`Reclamos (characterOwned): ${owned.length}`);
  console.log(`Eventos (dailyCharacterEvent, cualquier status): ${events.length}`);
  console.log(`Obras elegibles a recatalogar: ${works.length}`);

  if (dryRun) {
    console.log("\n--dry-run: nada se modificó. Corre con --yes para aplicar los cambios.");
    await mongoClient.close();
    process.exit(0);
  }

  if (!confirmed) {
    console.error("\nEsto borra TODO el catálogo de personajes y los reclamos, sin distinguir prueba de real.");
    console.error("Corre de nuevo con --yes si estás seguro (o --dry-run para solo ver los números).");
    await mongoClient.close();
    process.exit(1);
  }

  const charRes = await db.deleteMany({ kind: "character" });
  console.log(`\nPersonajes borrados: ${charRes.deletedCount}`);

  const ownedRes = await db.deleteMany({ kind: "characterOwned" });
  console.log(`Reclamos borrados: ${ownedRes.deletedCount}`);

  const eventsRes = await db.deleteMany({ kind: "dailyCharacterEvent" });
  console.log(`Eventos borrados: ${eventsRes.deletedCount}`);

  const worksRes = await db.updateMany(
    { kind: "eligibleWork" },
    { $set: { catalogFetchedAt: null, genres: [] } }
  );
  console.log(`Obras marcadas para recatalogar: ${worksRes.modifiedCount}`);

  await db.updateOne(
    { _id: "character-event:state" },
    { $set: { lastRolledDate: null } },
    { upsert: true }
  );
  console.log("character-event:state reseteado — se puede sortear un evento nuevo hoy mismo.");

  console.log("\nListo. La próxima vez que se necesite una obra, se recataloga sola con la clave nueva.");
  await mongoClient.close();
  process.exit(0);
}

main().catch(async err => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
