import { Client, GatewayIntentBits, Collection, Partials } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();
client.prefixCommands = new Collection();
client.pendingLinks = new Map();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
await mongoClient.connect();

const db = mongoClient.db(process.env.MONGODB_DB_NAME || "nihongotracker");
client.db = db.collection(process.env.MONGODB_COLLECTION_NAME || "btv");

console.log("Mongo connected");

const slashPath = path.join(__dirname, "commands", "slash");
if (fs.existsSync(slashPath)) {
  const slashFiles = fs.readdirSync(slashPath).filter(f => f.endsWith(".js"));

  for (const file of slashFiles) {
    const command = await import(`./commands/slash/${file}`);

    if (command.default?.data) {
      client.commands.set(command.default.data.name, command.default);
      console.log("Loaded slash:", command.default.data.name);
    }
  }
}

const eventsPath = path.join(__dirname, "events");
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith(".js"));

for (const file of eventFiles) {
  const event = await import(`./events/${file}`);
  const eventData = event.default;

  if (!eventData?.name || !eventData?.execute) continue;

  if (eventData.once) {
    client.once(eventData.name, (...args) =>
      eventData.execute(...args, client)
    );
  } else {
    client.on(eventData.name, (...args) =>
      eventData.execute(...args, client)
    );
  }

  console.log("Loaded event:", eventData.name);
}

client.on("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);
