import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import characters from "../../lib/characters.js";

// Canal fijo de pruebas — este comando NUNCA postea en el canal real de anuncios
// (events/characterEvent.js usa otro ANNOUNCE_CHANNEL_ID, y este evento de prueba usa
// kind:"testCharacterEvent" así que el poll real ni lo ve).
const TEST_CHANNEL_ID = "1476707434780164177";

const POLL_MS = 20 * 1000; // más rápido que el poll real (60s) para no esperar tanto probando
const TEST_DURATION_MS = 3 * 60 * 60 * 1000; // 3h tope, por si se olvida detenerlo

const ROLE_LABELS = {
  main: "⭐ Personaje principal",
  side: "Personaje secundario"
};

function unitLabel(challenge) {
  switch (challenge.unit) {
    case "episodes": return `${challenge.amount} episodios`;
    case "pages":    return `${challenge.amount} páginas`;
    case "chars":    return `${challenge.amount.toLocaleString("es-MX")} caracteres`;
    case "minutes":  return `${challenge.amount} minutos`;
    default:         return `${challenge.amount}`;
  }
}

function challengeSummary(event) {
  const typeLabel = characters.TYPE_LABELS[event.challenge.contentType] ?? event.challenge.contentType;
  const tagClause = event.challenge.tag === "general"
    ? ""
    : ` con el tag \`${event.challenge.tag}\``;

  return (
    `De **${event.workTitle}** · ${ROLE_LABELS[event.characterRole]}\n` +
    `**Reto:** loguear ${unitLabel(event.challenge)} de ${typeLabel}${tagClause}.`
  );
}

function buildStartEmbed(event) {
  return new EmbedBuilder()
    .setColor(0x3B82F6)
    .setTitle(`🧪 Evento de prueba: ${event.characterName}`)
    .setDescription(
      `${challengeSummary(event)}\n\n` +
      `Esto es solo una prueba — **no se otorga el personaje** ni afecta el sorteo real. ` +
      `Voy a avisar acá cada vez que detecte un log relevante de alguien linkeado, y si cumplió el filtro del reto.\n\n` +
      `Corriendo por hasta ${Math.round(TEST_DURATION_MS / 3600000)}h, o hasta que uses \`/reto-prueba detener\`.`
    )
    .setImage(event.characterImage || null)
    .setTimestamp();
}

function matchLabel(matchesFilter) {
  if (matchesFilter === true) return "✅ cumple el filtro del reto";
  if (matchesFilter === false) return "❌ NO cumple el filtro del reto";
  return "❔ no se pudo verificar el filtro (cuenta igual, mismo criterio que el evento real)";
}

function buildLogEmbed(event, entry) {
  return new EmbedBuilder()
    .setColor(entry.matchesFilter === false ? 0xEF4444 : 0x22C55E)
    .setTitle("📥 Log detectado")
    .setDescription(
      `<@${entry.discordId}> (\`${entry.username}\`) logueó **${entry.amount.toLocaleString("es-MX")}** ${event.challenge.unit === "episodes" ? "episodios" : event.challenge.unit === "pages" ? "páginas" : "caracteres"}` +
      (entry.title ? ` de **${entry.title}**` : "") +
      `.\n\n${matchLabel(entry.matchesFilter)}\n` +
      `Acumulado hacia el reto: **${entry.runningTotal.toLocaleString("es-MX")} / ${event.challenge.amount.toLocaleString("es-MX")}**`
    )
    .setTimestamp(entry.createdAt);
}

function buildWinEmbed(event, entry) {
  return new EmbedBuilder()
    .setColor(0xF59E0B)
    .setTitle(`🏆 [PRUEBA] ${entry.username} habría ganado a ${event.characterName}`)
    .setDescription(
      `Esto es una prueba — el personaje **no fue otorgado de verdad**. ` +
      `Si esto fuera el evento real, <@${entry.discordId}> se lo hubiera ganado en este momento.`
    )
    .setTimestamp();
}

// Un solo test corriendo a la vez por proceso — guardado en el client para sobrevivir entre
// invocaciones del comando (no entre reinicios del bot, no hace falta para algo de prueba).
function getState(client) {
  if (!client.testCharacterEvent) client.testCharacterEvent = null;
  return client.testCharacterEvent;
}

function stopRunning(client) {
  const state = getState(client);
  if (state?.interval) clearInterval(state.interval);
  client.testCharacterEvent = null;
  return state;
}

async function postToTestChannel(client, payload) {
  const channel = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`[reto-prueba] Canal de prueba ${TEST_CHANNEL_ID} no encontrado o no es de texto.`);
    return;
  }
  await channel.send(payload).catch(err => console.error("[reto-prueba] Error posteando:", err.message));
}

async function pollOnce(client) {
  const state = getState(client);
  if (!state) return;

  const db = client.db;
  if (!db) return;

  if (Date.now() >= state.expiresAt) {
    await postToTestChannel(client, {
      content: `🧪 El evento de prueba de **${state.event.characterName}** expiró (llegó al tope de tiempo).`
    });
    stopRunning(client);
    return;
  }

  let entries;
  try {
    entries = await characters.checkEventProgressVerbose(db, state.event, state.startedAt);
  } catch (err) {
    console.error("[reto-prueba] Error revisando progreso:", err.response?.data || err.message);
    return;
  }

  for (const entry of entries) {
    if (state.seenLogIds.has(entry.logId)) continue;
    state.seenLogIds.add(entry.logId);

    await postToTestChannel(client, { embeds: [buildLogEmbed(state.event, entry)] });

    if (entry.completed && !state.winnerAnnounced) {
      state.winnerAnnounced = true;
      await postToTestChannel(client, { embeds: [buildWinEmbed(state.event, entry)] });
      // Se sigue corriendo (a diferencia del evento real) para poder seguir probando más logs si
      // querés, hasta que lo detengas a mano o se cumpla el tope de tiempo.
    }
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("reto-prueba")
    .setDescription("[Admin] Dispara un evento de personaje de PRUEBA para probar la detección de logs")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName("iniciar").setDescription("Dispara un evento de prueba en el canal de pruebas")
    )
    .addSubcommand(sub =>
      sub.setName("detener").setDescription("Detiene el evento de prueba que esté corriendo")
    )
    .addSubcommand(sub =>
      sub.setName("refrescar-obras").setDescription("Fuerza un refresco de obras elegibles ahora mismo (normalmente tarda ~20h)")
    ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Este comando es solo para administradores.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const client = interaction.client;

    if (sub === "detener") {
      const state = stopRunning(client);
      if (!state) {
        return interaction.reply({ content: "No hay ningún evento de prueba corriendo.", ephemeral: true });
      }
      await postToTestChannel(client, { content: `🧪 Evento de prueba de **${state.event.characterName}** detenido manualmente.` });
      return interaction.reply({ content: "Evento de prueba detenido.", ephemeral: true });
    }

    if (sub === "refrescar-obras") {
      await interaction.deferReply({ ephemeral: true });
      const db = client.db;
      if (!db) return interaction.editReply("La base de datos no está lista todavía, intenta en un momento.");
      const count = await characters.refreshEligibleWorks(db);
      return interaction.editReply(`Listo — ${count} obra(s) elegible(s) recalculadas (títulos incluidos).`);
    }

    // sub === "iniciar"
    await interaction.deferReply({ ephemeral: true });
    stopRunning(client); // si ya había uno corriendo, lo reemplaza

    const db = client.db;
    if (!db) {
      return interaction.editReply("La base de datos no está lista todavía, intenta en un momento.");
    }

    const event = await characters.forceSpawnTestEvent(db);
    if (!event) {
      return interaction.editReply("No encontré ninguna obra elegible con personajes para armar un evento de prueba ahora mismo.");
    }

    const startedAt = new Date();
    client.testCharacterEvent = {
      event,
      startedAt,
      expiresAt: Date.now() + TEST_DURATION_MS,
      seenLogIds: new Set(),
      winnerAnnounced: false,
      interval: null
    };
    client.testCharacterEvent.interval = setInterval(() => {
      pollOnce(client).catch(err => console.error("[reto-prueba] Error en poll:", err));
    }, POLL_MS);

    await postToTestChannel(client, { embeds: [buildStartEmbed(event)] });
    return interaction.editReply(`Evento de prueba de **${event.characterName}** disparado en <#${TEST_CHANNEL_ID}>.`);
  }
};
