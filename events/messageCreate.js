const axios = require("axios");
const { EmbedBuilder } = require("discord.js");
const ntToggle = require("../lib/nihongoTrackerToggle.js");

const getHeaders = (apiKey) => ({
  "X-API-Key": apiKey,
  "Content-Type": "application/json",
  "Accept": "application/json"
});

module.exports = {
  name: "messageCreate",
  async execute(message, client) {
    if (message.author.bot) return;
    if (message.guild) return;
    if (!ntToggle.isEnabled()) return; // NihongoTracker desactivado: no validar keys

    const pending = client.pendingLinks.get(message.author.id);
    if (!pending) return;

    if (Date.now() > pending.expiresAt) {
      client.pendingLinks.delete(message.author.id);

      const embedExpirado = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("⏰ Solicitud expirada")
        .setDescription("Tu solicitud de vinculación expiró. Usa **/link** de nuevo para intentarlo.");

      return message.reply({ embeds: [embedExpirado] });
    }

    const apiKey = message.content.trim();

    try {
      const createRes = await axios.post(
        `${process.env.API_BASE}/logs`,
        {
          type: "anime",
          mediaData: {
            contentId: "14829",
            contentTitleNative: "Fate/kaleid liner プリズマ☆イリヤ",
            contentTitleEnglish: "Fate/kaleid liner Prisma☆Illya",
            contentTitleRomaji: "Fate/kaleid liner Prisma☆Illya",
            contentImage: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx14829-PZVOr1ZxwOJV.png",
            type: "anime"
          },
          description: "Link validation test",
          episodes: 1,
          pages: 0,
          chars: 0,
          time: 24,
          date: new Date().toISOString(),
          private: true,
          tags: []
        },
        { headers: getHeaders(apiKey) }
      );

      const logId = createRes.data._id;

      await axios.delete(`${process.env.API_BASE}/logs/${logId}`, {
        headers: getHeaders(apiKey)
      });

      if (client.db) {
        const result = await client.db.updateOne(
          { discordId: message.author.id },
          {
            $set: {
              discordId: message.author.id,
              apiKey,
              linkedAt: new Date()
            }
          },
          { upsert: true }
        );
        console.log("MONGO RESULT:", result);
      }

      client.pendingLinks.delete(message.author.id);

      const embedExito = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("✅ ¡Cuenta vinculada!")
        .setDescription(
          `Tu cuenta de Discord ha sido vinculada exitosamente a **nihongotracker.app**.\n\n` +
          `Ya puedes usar **/log** para registrar tu inmersión y **/ranking** para ver el ranking del club.`
        )
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: "nihongotracker.app  ·  ¡Buena suerte con tu estudio!" })
        .setTimestamp();

      return message.reply({ embeds: [embedExito] });

    } catch (err) {
      console.error("LINK ERROR:", err.response?.data || err.message);

      const embedError = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("❌ Error al vincular")
        .setDescription(
          "No se pudo vincular tu cuenta. Asegúrate de que tu **API Key** sea válida.\n\n" +
          "Si el problema persiste, genera una nueva key en [nihongotracker.app/settings](https://nihongotracker.app/settings) e intenta de nuevo con **/link**."
        );

      return message.reply({ embeds: [embedError] });
    }
  }
};