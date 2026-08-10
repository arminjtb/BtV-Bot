// scripts/resetCharacters.mjs
//
// Limpia el estado de personajes para poder seguir probando: cancela el evento activo (si hay)
// y libera a los personajes reclamados.
//
// Por default hace un reset "suave": el personaje reclamado vuelve a estar disponible
// (claimed: false) y se borra su registro de dueño (character-owned:*), pero el documento del
// personaje en sí (nombre, imagen, rol) NO se borra. Esto es a propósito: si se borrara el
// documento del personaje pero la obra ya quedó marcada como "catalogFetchedAt" en el cache,
// ensureCharacterCatalog nunca la vuelve a recatalogar (mira characters.js línea ~397) y esa
// obra se queda sin personajes para siempre — el mismo tipo de bug silencioso que ya nos mordió
// una vez con los tags. Por eso el borrado real del documento del personaje es opt-in con --hard.
//
// Uso:
//   node scripts/resetCharacters.mjs                 // reset suave (recomendado)
//   node scripts/resetCharacters.mjs --dry-run        // solo muestra qué haría, no toca nada
//   node scripts/resetCharacters.mjs --hard           // borra los documentos de personaje reclamados
//                                                      // de verdad, y resetea el cache de su obra
//                                                      // (catalogFetchedAt) para que se recatalogue
//   node scripts/resetCharacters.mjs --keep-roll-state // no resetea character-event:state
//                                                      // (por default SÍ se resetea, para poder
//                                                      // forzar otro sorteo hoy mismo)
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
    hard: argv.includes("--hard"),
    keepRollState: argv.includes("--keep-roll-state")
  };
}

async function main() {
  const { dryRun, hard, keepRollState } = parseArgs(process.argv.slice(2));

  if (!process.env.MONGODB_URI) {
    console.error("Falta MONGODB_URI en el entorno (.env).");
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db("nihongotracker").collection("btv");
  console.log(`Mongo conectado.${dryRun ? " (--dry-run: no se va a escribir nada)" : ""}`);

  // ---- 1. Evento(s) activo(s) ----
  const activeEvents = await db.find({ kind: "dailyCharacterEvent", status: "active" }).toArray();
  console.log(`\nEventos activos encontrados: ${activeEvents.length}`);
  for (const ev of activeEvents) {
    console.log(`  - ${ev.characterName} (${ev.workTitle}) · _id: ${ev._id}`);
  }

  // ---- 2. Personajes reclamados ----
  const claimedCharacters = await db.find({ kind: "character", claimed: true }).toArray();
  console.log(`\nPersonajes reclamados encontrados: ${claimedCharacters.length}`);
  for (const char of claimedCharacters) {
    console.log(`  - ${char.name} (${char.workType}:${char.workContentId}) · _id: ${char._id}`);
  }

  const ownershipDocs = await db.find({ kind: "characterOwned" }).toArray();
  console.log(`\nRegistros de dueño (character-owned) encontrados: ${ownershipDocs.length}`);

  if (dryRun) {
    console.log("\n--dry-run: nada se modificó. Corre sin esa bandera para aplicar los cambios.");
    await mongoClient.close();
    process.exit(0);
  }

  // ---- Aplicar ----
  if (activeEvents.length > 0) {
    const res = await db.deleteMany({ kind: "dailyCharacterEvent", status: "active" });
    console.log(`\nEventos activos borrados: ${res.deletedCount}`);
  }

  if (ownershipDocs.length > 0) {
    const res = await db.deleteMany({ kind: "characterOwned" });
    console.log(`Registros de dueño borrados: ${res.deletedCount}`);
  }

  if (claimedCharacters.length > 0) {
    if (hard) {
      const ids = claimedCharacters.map(c => c._id);
      const res = await db.deleteMany({ _id: { $in: ids } });
      console.log(`Personajes borrados (--hard): ${res.deletedCount}`);

      // Sin esto, la obra se queda marcada como ya catalogada y nunca vuelve a generar personajes.
      const workKeys = [...new Set(claimedCharacters.map(c => `${c.workType}:${c.workContentId}`))];
      for (const key of workKeys) {
        const [workType, workContentId] = key.split(":");
        await db.updateOne(
          { _id: `eligible-work:${workType}:${workContentId}` },
          { $set: { catalogFetchedAt: null, genres: [] } }
        );
      }
      console.log(`Cache de catálogo reseteado para ${workKeys.length} obra(s), se recatalogan solas en el próximo sorteo.`);
    } else {
      const res = await db.updateMany(
        { kind: "character", claimed: true },
        { $set: { claimed: false } }
      );
      console.log(`Personajes liberados (claimed: false): ${res.modifiedCount}`);
    }
  }

  if (!keepRollState) {
    await db.updateOne(
      { _id: "character-event:state" },
      { $set: { lastRolledDate: null } },
      { upsert: true }
    );
    console.log(`\ncharacter-event:state reseteado — se puede volver a sortear un evento hoy mismo.`);
  }

  console.log("\nListo.");
  await mongoClient.close();
  process.exit(0);
}

main().catch(async err => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
