// Recibe por DM el código (PIN) que AniList muestra al final de /anilist autorizar, lo canjea por
// un access token y lo guarda.
//
// Es un segundo listener de "messageCreate" (el primero, events/messageCreate.js, es el de la API
// key de NihongoTracker). Cada uno mira su propio mapa de solicitudes pendientes y sale sin hacer
// nada si el mensaje no es para él, así que no se estorban.

import store from "../lib/anilistStore.js";
import anilist from "../lib/anilist.js";
import ui from "../lib/anilistUi.js";

const PENDING_TTL_MS = 15 * 60 * 1000;

export default {
  name: "messageCreate",

  async execute(message, client) {
    if (message.author.bot) return;
    if (message.guild) return; // sólo por DM

    const pending = client.anilistPendingAuth?.get(message.author.id);
    if (!pending) return;

    if (Date.now() > pending.expiresAt) {
      client.anilistPendingAuth.delete(message.author.id);
      return message.reply({
        embeds: [
          ui.errorEmbed(
            "⏰ Solicitud expirada",
            "El enlace de autorización caducó. Usa **/anilist autorizar** otra vez."
          )
        ]
      });
    }

    const code = message.content.trim();
    if (code.length < 20) {
      return message.reply({
        embeds: [
          ui.errorEmbed(
            "Eso no parece el código",
            "Pega el código largo que te muestra AniList después de darle a **Authorize** " +
              "(es una cadena de varias líneas de letras y números)."
          )
        ]
      });
    }

    const thinking = await message.reply({
      embeds: [ui.infoEmbed("⏳ Validando…", "Un segundo, estoy hablando con AniList.")]
    });

    try {
      const token = await anilist.exchangeCodeForToken(code);
      const viewer = await anilist.fetchViewer(token.accessToken);

      if (!viewer?.id) throw new Error("AniList no devolvió el perfil del usuario.");

      const db = client.db;

      // Autorizar también vincula: el token nos dice quién es, así que no hace falta que haya
      // pasado antes por /anilist vincular.
      await store.linkUser(db, message.author.id, {
        anilistId: viewer.id,
        anilistName: viewer.name,
        avatar: viewer.avatar?.large || null,
        siteUrl: viewer.siteUrl || null
      });

      await store.setUserToken(db, message.author.id, token);

      client.anilistPendingAuth.delete(message.author.id);

      // Se baja su lista ya mismo para que el primer aviso no tarde media hora.
      const user = await store.getUser(db, message.author.id);
      const synced = await store.syncUserList(db, user, { force: true });

      const planningCount = (synced.planning || []).length;
      const currentCount = (synced.current || []).length;

      const embed = ui
        .okEmbed(
          "✅ Cuenta de AniList autorizada",
          `Vinculado como **${viewer.name}**.\n\n` +
            `📋 **${planningCount}** anime en planning\n` +
            `▶️ **${currentCount}** anime viendo\n\n` +
            "Ya puedes usar los botones **➕ Añadir a planning** de los avisos, y te mencionaré " +
            "en el canal cuando salga un episodio de algo que tengas en lista."
        )
        .setThumbnail(viewer.avatar?.large || null)
        .setFooter({ text: "El permiso se puede revocar con /anilist desvincular" });

      // El mensaje con el código se borra: es una credencial de un solo uso, pero no hace falta
      // que quede ahí flotando en el DM.
      await message.delete().catch(() => {});

      return thinking.edit({ embeds: [embed] });
    } catch (err) {
      console.error("[anilistAuthDm] Error canjeando el código:", err.response?.data || err.message);

      return thinking.edit({
        embeds: [
          ui.errorEmbed(
            "❌ No pude autorizar la cuenta",
            "El código no fue aceptado por AniList. Suele pasar si ya se usó antes o si " +
              "caducó.\n\nVuelve a empezar con **/anilist autorizar** y pega el código nuevo."
          )
        ]
      });
    }
  }
};

export { PENDING_TTL_MS };
