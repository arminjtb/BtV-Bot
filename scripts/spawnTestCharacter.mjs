// scripts/spawnTestCharacter.mjs
//
// Fuerza la aparición de un personaje (como el evento diario) en un canal específico,
// sin pasar por el sorteo de 1/5 ni el límite de "una vez al día". Pensado solo para testear.
//
// Uso:
//   node scripts/spawnTestCharacter.mjs
//   node scripts/spawnTestCharacter.mjs --canal 123456789012345678
//   node scripts/spawnTestCharacter.mjs --tipo anime --contentId 21
//
// Requiere las mismas variables de entorno que el bot: BOT_TOKEN y MONGODB_URI (.env en la raíz).

import { Client, GatewayIntentBits } from "discord.js";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import characters from "../lib/characters.js";
import { buildEventEmbed } from "../events/characterEvent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carga el .env desde la raíz del proyecto (un nivel arriba de scripts/), no desde el cwd.
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DEFAULT_TEST_CHANNEL_ID = "1476707434780164177";

function parseArgs(argv) {
  const args = { channelId: DEFAULT_TEST_CHANNEL_ID, workType: null, contentId: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--canal" || arg === "--channel") args.channelId = argv[++i];
    else if (arg === "--tipo" || arg === "--type") args.workType = argv[++i];
    else if (arg === "--contentId" || arg === "--content-id") args.contentId = argv[++i];
  }

  return args;
}

async function main() {
  const { channelId, workType, contentId } = parseArgs(process.argv.slice(2));

  if (!process.env.BOT_TOKEN) {
    console.error("Falta BOT_TOKEN en el entorno (.env).");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("Falta MONGODB_URI en el entorno (.env).");
    process.exit(1);
  }

  console.log("Conectando a Mongo...");
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db("nihongotracker").collection("btv");
  console.log("Mongo conectado.");

  console.log("Conectando el bot a Discord...");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
  });

  await new Promise((resolve, reject) => {
    client.once("clientReady", resolve);
    client.once("error", reject);
    client.login(process.env.BOT_TOKEN).catch(reject);
  });
  console.log(`Conectado como ${client.user.tag}.`);

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`No pude acceder al canal ${channelId} (¿el bot está en ese servidor y tiene permiso de verlo?).`);
    await client.destroy();
    await mongoClient.close();
    process.exit(1);
  }

  console.log("Buscando/refrescando obras elegibles (esto puede tardar si el cache está viejo)...");
  const event = await characters.forceSpawnEvent(db, {
    workType: workType || undefined,
    workContentId: contentId || undefined
  });

  if (!event) {
    console.error(
      workType || contentId
        ? "No encontré esa obra entre las elegibles, o no tiene personajes sin reclamar."
        : "No hay ninguna obra elegible con personajes sin reclamar todavía."
    );
    await client.destroy();
    await mongoClient.close();
    process.exit(1);
  }

  console.log(`Personaje elegido: ${event.characterName} (${event.characterRole}) de ${event.workTitle}`);
  console.log(`Reto: ${event.challenge.amount} ${event.challenge.unit} de ${event.challenge.contentType} · tag "${event.challenge.tag}"`);

  const message = await channel.send({ embeds: [buildEventEmbed(event)] });
  await characters.setEventMessage(db, event._id, channel.id, message.id);

  console.log(`Publicado en #${channel.name ?? channel.id} → ${message.url ?? message.id}`);
  console.log(`Evento activo con _id: ${event._id} (se resuelve solo, como cualquier evento diario — lo revisa el poll normal de characterEvent.js).`);

  await client.destroy();
  await mongoClient.close();
  process.exit(0);
}

main().catch(async err => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
