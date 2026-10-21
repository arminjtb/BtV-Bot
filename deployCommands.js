import { REST, Routes } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

dotenv.config();

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN) throw new Error("Missing BOT_TOKEN");
if (!CLIENT_ID) throw new Error("Missing CLIENT_ID");

const commandsPath = path.join(process.cwd(), "commands", "slash");
const files = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));

const commands = [];

console.log("📂 Files:", files);

for (const file of files) {
  try {
    const mod = await import(
      pathToFileURL(path.join(commandsPath, file)).href
    );

    const command = mod.default;

    if (!command?.data?.toJSON) {
      console.log("❌ Skipping invalid command:", file);
      continue;
    }

    commands.push(command.data.toJSON());
    console.log("✔ Loaded:", command.data.name);
  } catch (err) {
    console.error("❌ Error loading:", file, err.message);
  }
}

console.log("\n🚀 Deploying...", commands.length);

const rest = new REST({ version: "10" }).setToken(TOKEN);

const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

const result = await rest.put(route, { body: commands });

console.log(`✅ Deployed ${result.length} command(s)${GUILD_ID ? ` to guild ${GUILD_ID}` : " globally"}.`);
