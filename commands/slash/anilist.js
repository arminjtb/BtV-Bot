import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

import store from "../../lib/anilistStore.js";
import anilist from "../../lib/anilist.js";
import ui from "../../lib/anilistUi.js";

const PENDING_TTL_MS = 15 * 60 * 1000;

function requireManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

export default {
  data: new SlashCommandBuilder()
    .setName("anilist")
    .setDescription("Conecta tu cuenta de AniList y configura los avisos de anime")

    .addSubcommand(sub =>
      sub
        .setName("vincular")
        .setDescription("Vincula tu cuenta de AniList (sólo lectura: avisos y menciones)")
        .addStringOption(o =>
          o
            .setName("usuario")
            .setDescription("Tu nombre de usuario en AniList")
            .setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("autorizar")
        .setDescription("Autoriza al bot a escribir en tu lista (botones de añadir a planning)")
    )

    .addSubcommand(sub =>
      sub
        .setName("perfil")
        .setDescription("Muestra el estado de tu vínculo con AniList")
        .addUserOption(o =>
          o.setName("miembro").setDescription("Ver el de otra persona").setRequired(false)
        )
    )

    .addSubcommand(sub =>
      sub.setName("sincronizar").setDescription("Fuerza una relectura de tu lista de AniList")
    )

    .addSubcommand(sub =>
      sub.setName("desvincular").setDescription("Borra tu vínculo y tu token de AniList")
    )

    .addSubcommand(sub =>
      sub
        .setName("canal")
        .setDescription("[Admin] Define el canal donde salen los avisos de anime")
        .addChannelOption(o =>
          o
            .setName("canal")
            .setDescription("Canal de avisos")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
        .addRoleOption(o =>
          o
            .setName("rol_estrenos")
            .setDescription("Rol al que hacer ping en cada estreno (opcional)")
            .setRequired(false)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("config")
        .setDescription("[Admin] Ajusta qué se anuncia y cuánto ruido se filtra")
        .addStringOption(o =>
          o
            .setName("estrenos")
            .setDescription("Qué estrenos se anuncian")
            .addChoices(
              { name: "Todos los estrenos", value: "always" },
              { name: "Sólo los que alguien tenga en lista", value: "planning" },
              { name: "Ninguno", value: "off" }
            )
            .setRequired(false)
        )
        .addBooleanOption(o =>
          o
            .setName("episodios")
            .setDescription("Avisar de episodios nuevos (de anime que alguien tenga en lista)")
            .setRequired(false)
        )
        .addIntegerOption(o =>
          o
            .setName("popularidad_minima")
            .setDescription("Popularidad mínima en AniList para anunciar un estreno que nadie sigue")
            .setMinValue(0)
            .setMaxValue(200000)
            .setRequired(false)
        )
        .addStringOption(o =>
          o
            .setName("paises")
            .setDescription("Países de origen, separados por coma (JP, CN, KR). Vacío = todos")
            .setRequired(false)
        )
        .addStringOption(o =>
          o
            .setName("zona_horaria")
            .setDescription("Zona horaria para /calendario (ej. America/Mexico_City)")
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const db = interaction.client.db;

    if (!db) {
      return interaction.reply({
        embeds: [ui.errorEmbed("Sin base de datos", "El bot no tiene conexión a la base de datos.")],
        flags: 64
      });
    }

    switch (sub) {
      case "vincular":
        return vincular(interaction, db);
      case "autorizar":
        return autorizar(interaction);
      case "perfil":
        return perfil(interaction, db);
      case "sincronizar":
        return sincronizar(interaction, db);
      case "desvincular":
        return desvincular(interaction, db);
      case "canal":
        return canal(interaction, db);
      case "config":
        return config(interaction, db);
      default:
        return interaction.reply({ content: "Subcomando desconocido.", flags: 64 });
    }
  }
};

// ─── /anilist vincular ───────────────────────────────────────────────────────

async function vincular(interaction, db) {
  const userName = interaction.options.getString("usuario").trim();
  await interaction.deferReply({ flags: 64 });

  let profile;
  try {
    profile = await anilist.fetchUserByName(userName);
  } catch (err) {
    return interaction.editReply({
      embeds: [ui.errorEmbed("AniList no respondió", `\`${err.message}\`\n\nInténtalo en un minuto.`)]
    });
  }

  if (!profile) {
    return interaction.editReply({
      embeds: [
        ui.errorEmbed(
          "No encontré ese usuario",
          `No existe nadie llamado **${userName}** en AniList.\n\n` +
            "Usa el nombre exacto de tu perfil (el de `anilist.co/user/**TU_NOMBRE**`)."
        )
      ]
    });
  }

  await store.linkUser(db, interaction.user.id, {
    anilistId: profile.id,
    anilistName: profile.name,
    avatar: profile.avatar?.large || null,
    siteUrl: profile.siteUrl || null
  });

  const user = await store.getUser(db, interaction.user.id);
  const synced = await store.syncUserList(db, user, { force: true });

  if (synced.listError) {
    return interaction.editReply({
      embeds: [
        ui.errorEmbed(
          "Vinculado, pero no pude leer tu lista",
          `Cuenta: **${profile.name}**\n\n` +
            "Suele pasar si tu lista de anime es **privada**. Usa **/anilist autorizar** para que " +
            "el bot pueda leerla con tu permiso."
        )
      ]
    });
  }

  const planningCount = (synced.planning || []).length;
  const currentCount = (synced.current || []).length;

  const embed = ui
    .okEmbed(
      "✅ Cuenta de AniList vinculada",
      `Vinculado como **${profile.name}**.\n\n` +
        `📋 **${planningCount}** en planning · ▶️ **${currentCount}** viendo\n\n` +
        "Te mencionaré en el canal de avisos cuando salga un episodio de algo que tengas en lista."
    )
    .setThumbnail(profile.avatar?.large || null)
    .setFooter({
      text: "Para usar los botones de «Añadir a planning» hace falta /anilist autorizar"
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Ver perfil en AniList")
      .setURL(profile.siteUrl)
      .setStyle(ButtonStyle.Link)
  );

  return interaction.editReply({ embeds: [embed], components: [row] });
}

// ─── /anilist autorizar ──────────────────────────────────────────────────────

async function autorizar(interaction) {
  const client = interaction.client;

  if (!anilist.isConfigured()) {
    return interaction.reply({
      embeds: [
        ui.errorEmbed(
          "Falta configurar el bot",
          "El administrador todavía no ha puesto `ANILIST_CLIENT_ID` y `ANILIST_CLIENT_SECRET`.\n\n" +
            "Mientras tanto puedes usar **/anilist vincular** para recibir avisos."
        )
      ],
      flags: 64
    });
  }

  client.anilistPendingAuth ||= new Map();
  client.anilistPendingAuth.set(interaction.user.id, { expiresAt: Date.now() + PENDING_TTL_MS });

  const authUrl = anilist.buildAuthorizeUrl();

  const embed = new EmbedBuilder()
    .setColor(0x02A9FF)
    .setTitle("Autoriza tu cuenta de AniList")
    .setDescription(
      "**1.** Abre el enlace de abajo e inicia sesión en AniList si hace falta.\n" +
        "**2.** Dale a **Authorize**.\n" +
        "**3.** AniList te mostrará un **código largo**. Cópialo entero.\n" +
        "**4.** **Pégalo aquí mismo, en este DM.**\n\n" +
        "Con esto el bot podrá añadir anime a tu planning desde los botones y marcar episodios " +
        "como vistos. No puede leer tus mensajes privados ni borrar tu cuenta."
    )
    .setFooter({ text: "Tienes 15 minutos · Revoca cuando quieras con /anilist desvincular" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Autorizar en AniList").setURL(authUrl).setStyle(ButtonStyle.Link)
  );

  try {
    await interaction.user.send({ embeds: [embed], components: [row] });

    return interaction.reply({
      embeds: [
        ui.okEmbed(
          "📬 Revisa tus DMs",
          "Te mandé las instrucciones por mensaje directo."
        )
      ],
      flags: 64
    });
  } catch {
    client.anilistPendingAuth.delete(interaction.user.id);

    return interaction.reply({
      embeds: [
        ui.errorEmbed(
          "❌ No pude enviarte un DM",
          "Activa **Mensajes directos de miembros del servidor** en *Configuración → Privacidad y " +
            "seguridad* y vuelve a intentarlo."
        )
      ],
      flags: 64
    });
  }
}

// ─── /anilist perfil ─────────────────────────────────────────────────────────

async function perfil(interaction, db) {
  const target = interaction.options.getUser("miembro") || interaction.user;
  const isSelf = target.id === interaction.user.id;

  await interaction.deferReply({ flags: 64 });

  const user = await store.getUser(db, target.id);

  if (!user?.anilistName) {
    return interaction.editReply({
      embeds: [
        ui.infoEmbed(
          "Sin vincular",
          isSelf
            ? "Todavía no has vinculado tu AniList. Usa **/anilist vincular**."
            : `**${target.username}** no tiene AniList vinculado.`
        )
      ]
    });
  }

  const write = store.hasWriteAccess(user);

  const embed = new EmbedBuilder()
    .setColor(0x02A9FF)
    .setTitle(user.anilistName)
    .setURL(user.siteUrl || null)
    .setThumbnail(user.avatar || target.displayAvatarURL())
    .addFields(
      { name: "📋 Planning", value: String((user.planning || []).length), inline: true },
      { name: "▶️ Viendo", value: String((user.current || []).length), inline: true },
      {
        name: "Permisos",
        value: write ? "✅ Lectura y escritura" : "👁️ Sólo lectura",
        inline: true
      }
    )
    .setFooter({
      text: user.listSyncedAt
        ? `Lista sincronizada ${new Date(user.listSyncedAt).toLocaleString("es-MX")}`
        : "Lista aún sin sincronizar"
    });

  if (user.listError) {
    embed.addFields({ name: "⚠️ Último error", value: `\`${user.listError}\`` });
  }

  if (isSelf && !write) {
    embed.setDescription(
      "Usa **/anilist autorizar** para poder añadir anime a tu planning desde los botones."
    );
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── /anilist sincronizar ────────────────────────────────────────────────────

async function sincronizar(interaction, db) {
  await interaction.deferReply({ flags: 64 });

  const user = await store.getUser(db, interaction.user.id);
  if (!user?.anilistName) {
    return interaction.editReply({
      embeds: [ui.infoEmbed("Sin vincular", "Usa **/anilist vincular** primero.")]
    });
  }

  const synced = await store.syncUserList(db, user, { force: true });

  if (synced.listError) {
    return interaction.editReply({
      embeds: [ui.errorEmbed("No pude leer tu lista", `\`${synced.listError}\``)]
    });
  }

  return interaction.editReply({
    embeds: [
      ui.okEmbed(
        "🔄 Lista actualizada",
        `📋 **${(synced.planning || []).length}** en planning · ▶️ **${(synced.current || []).length}** viendo`
      )
    ]
  });
}

// ─── /anilist desvincular ────────────────────────────────────────────────────

async function desvincular(interaction, db) {
  const removed = await store.unlinkUser(db, interaction.user.id);

  return interaction.reply({
    embeds: [
      removed
        ? ui.okEmbed(
            "🔌 Desvinculado",
            "Borré tu vínculo y tu token. Si además quieres revocar el permiso desde AniList, " +
              "hazlo en [tus apps de AniList](https://anilist.co/settings/apps)."
          )
        : ui.infoEmbed("Nada que borrar", "No tenías ninguna cuenta vinculada.")
    ],
    flags: 64
  });
}

// ─── /anilist canal ──────────────────────────────────────────────────────────

async function canal(interaction, db) {
  if (!requireManageGuild(interaction)) {
    return interaction.reply({
      embeds: [ui.errorEmbed("Sin permisos", "Necesitas **Gestionar servidor** para esto.")],
      flags: 64
    });
  }

  const channel = interaction.options.getChannel("canal");
  const role = interaction.options.getRole("rol_estrenos");

  const patch = { channelId: channel.id };
  if (role) patch.premiereRoleId = role.id;

  const saved = await store.setGuildConfig(db, interaction.guildId, patch);

  return interaction.reply({
    embeds: [
      ui.okEmbed(
        "📢 Canal de avisos configurado",
        `Los avisos de anime saldrán en ${channel}.\n\n` +
          (saved.premiereRoleId ? `Ping de estrenos: <@&${saved.premiereRoleId}>\n` : "") +
          `Estrenos: **${describePremiereMode(saved.premiereMode)}**\n` +
          `Episodios: **${saved.episodesEnabled ? "activados" : "desactivados"}**`
      )
    ],
    flags: 64
  });
}

function describePremiereMode(mode) {
  if (mode === "always") return "todos";
  if (mode === "planning") return "sólo los que alguien siga";
  return "ninguno";
}

// ─── /anilist config ─────────────────────────────────────────────────────────

async function config(interaction, db) {
  if (!requireManageGuild(interaction)) {
    return interaction.reply({
      embeds: [ui.errorEmbed("Sin permisos", "Necesitas **Gestionar servidor** para esto.")],
      flags: 64
    });
  }

  const patch = {};

  const estrenos = interaction.options.getString("estrenos");
  if (estrenos) patch.premiereMode = estrenos;

  const episodios = interaction.options.getBoolean("episodios");
  if (episodios !== null) patch.episodesEnabled = episodios;

  const minPop = interaction.options.getInteger("popularidad_minima");
  if (minPop !== null) patch.minPopularity = minPop;

  const paises = interaction.options.getString("paises");
  if (paises !== null) {
    patch.countries = paises
      .split(",")
      .map(p => p.trim().toUpperCase())
      .filter(Boolean);
  }

  const zona = interaction.options.getString("zona_horaria");
  if (zona) {
    try {
      new Intl.DateTimeFormat("es-MX", { timeZone: zona });
      patch.timeZone = zona;
    } catch {
      return interaction.reply({
        embeds: [
          ui.errorEmbed(
            "Zona horaria inválida",
            `\`${zona}\` no existe. Usa el formato IANA, por ejemplo \`America/Mexico_City\`.`
          )
        ],
        flags: 64
      });
    }
  }

  const saved = Object.keys(patch).length
    ? await store.setGuildConfig(db, interaction.guildId, patch)
    : await store.getGuildConfig(db, interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(0x02A9FF)
    .setTitle("⚙️ Configuración de avisos de anime")
    .addFields(
      {
        name: "Canal",
        value: saved.channelId ? `<#${saved.channelId}>` : "⚠️ sin configurar (`/anilist canal`)",
        inline: false
      },
      { name: "Estrenos", value: describePremiereMode(saved.premiereMode), inline: true },
      { name: "Episodios", value: saved.episodesEnabled ? "sí" : "no", inline: true },
      {
        name: "Ping de estrenos",
        value: saved.premiereRoleId ? `<@&${saved.premiereRoleId}>` : "ninguno",
        inline: true
      },
      { name: "Popularidad mínima", value: String(saved.minPopularity), inline: true },
      {
        name: "Países",
        value: (saved.countries || []).length ? saved.countries.join(", ") : "todos",
        inline: true
      },
      { name: "Zona horaria", value: saved.timeZone, inline: true }
    )
    .setFooter({
      text: "La popularidad y los países sólo filtran estrenos que nadie del club sigue."
    });

  return interaction.reply({ embeds: [embed], flags: 64 });
}
