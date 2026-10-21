function errorDetails(error) {
  return {
    code: error?.code || "unknown",
    status: error?.status ?? error?.response?.status ?? null,
    message: String(error?.message || error).slice(0, 300)
  };
}

export function logInteractionError(scope, interaction, error) {
  console.error(`[${scope}] Error`, {
    command: interaction?.commandName || null,
    customId: interaction?.customId || null,
    ...errorDetails(error)
  });
}

export async function respondSafely(interaction, payload) {
  if (!interaction) return null;
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (error) {
    logInteractionError("discord-response", interaction, error);
    return null;
  }
}

export async function respondAutocompleteSafely(interaction, choices = []) {
  if (!interaction || interaction.responded || interaction.replied || interaction.deferred) return null;
  try {
    return await interaction.respond(choices);
  } catch (error) {
    logInteractionError("discord-autocomplete-response", interaction, error);
    return null;
  }
}
