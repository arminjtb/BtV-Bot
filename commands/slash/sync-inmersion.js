import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import axios from "axios";
import coImmersion from "../../lib/coImmersion.js";

const API_BASE = "https://nihongotracker.app/api";
const CLUB_ID = "6951b8e3319c4aea0d5d2b2d";
const MEMBER_BATCH_SIZE = 5;

async function fetchClubMembers() {
  const members = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data } = await axios.get(`${API_BASE}/clubs/${CLUB_ID}/rankings`, {
      params: { period: "all-time", limit, offset }
    });
    const rankings = Array.isArray(data?.rankings) ? data.rankings : [];
    members.push(...rankings.map(entry => entry.user).filter(user => user?.username));

    const total = data?.pagination?.total;
    if (rankings.length < limit || (Number.isFinite(total) && offset + rankings.length >= total)) break;
    offset += rankings.length;
  }

  return [...new Map(members.map(m => [m.username.toLowerCase(), m])).values()];
}

export default {
  data: new SlashCommandBuilder()
    .setName("sync-inmersion")
    .setDescription("Rellena el índice de 'quién más lo está viendo/leyendo' con la actividad reciente ya existente")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Solo los administradores pueden correr esto.", flags: 64 });
    }

    await interaction.deferReply();

    const members = await fetchClubMembers().catch(err => {
      console.error("[sync-inmersion] Error trayendo miembros del club:", err.response?.status || err.message);
      return [];
    });

    if (members.length === 0) {
      return interaction.editReply({ content: "No pude traer la lista de miembros del club." });
    }

    let processedMembers = 0;
    let recordedSightings = 0;
    let failedMembers = 0;

    for (let i = 0; i < members.length; i += MEMBER_BATCH_SIZE) {
      const batch = members.slice(i, i + MEMBER_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async member => {
          try {
            const { data } = await axios.get(`${API_BASE}/users/${encodeURIComponent(member.username)}/immersionlist`);
            const recorded = await coImmersion.backfillFromImmersionList(interaction.client.db, member.username, data);
            return { ok: true, recorded };
          } catch (err) {
            console.error(`[sync-inmersion] Error con ${member.username}:`, err.response?.status || err.message);
            return { ok: false };
          }
        })
      );

      for (const result of batchResults) {
        if (result.ok) {
          processedMembers++;
          recordedSightings += result.recorded;
        } else {
          failedMembers++;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("👀 Sincronización de inmersión activa")
      .setDescription(
        `Revisé **${processedMembers}** de **${members.length}** miembros del club ` +
        `y registré **${recordedSightings}** actividades recientes (últimas 3 semanas).` +
        (failedMembers > 0 ? `\n⚠️ ${failedMembers} miembro(s) fallaron y se saltaron.` : "")
      )
      .setFooter({ text: "Esto es un backfill único — de aquí en adelante /log y el mirror del club lo mantienen al día solos." });

    return interaction.editReply({ embeds: [embed] });
  }
};
