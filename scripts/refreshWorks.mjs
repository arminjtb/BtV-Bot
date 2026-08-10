// scripts/refreshWorks.mjs
//
// Fuerza refreshEligibleWorks() directo, sin pasar por el throttle de ~20h de
// ensureEligibleWorksFresh. Útil para testear cambios en la resolución de títulos
// sin tener que esperar. No necesita login de Discord, solo Mongo.
//
// Uso:
//   node scripts/refreshWorks.mjs

import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import characters from "../lib/characters.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("Falta MONGODB_URI en el entorno (.env).");
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db("nihongotracker").collection("btv");
  console.log("Mongo conectado. Refrescando obras elegibles (puede tardar varios minutos)...");

  const count = await characters.refreshEligibleWorks(db);
  console.log(`Listo. ${count} obra(s) elegible(s) encontradas.`);

  const works = await db.find({ kind: "eligibleWork", memberCount: { $gte: 2 } })
    .sort({ memberCount: -1 })
    .toArray();

  console.log("\nEstado actual del cache:");
  for (const w of works) {
    console.log(`  [${w.type}] ${w.title}  (contentId=${w.contentId}, ${w.memberCount} miembros)`);
  }

  await mongoClient.close();
  process.exit(0);
}

main().catch(err => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
