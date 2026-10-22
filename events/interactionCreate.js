import ntToggle from "../lib/nihongoTrackerToggle.js";
import { logInteractionError, respondAutocompleteSafely, respondSafely } from "../lib/interactionResponse.js";

async function reportInteractionFailure(interaction, scope, error, message = "No pude procesar esta interacción.") {
  logInteractionError(scope, interaction, error);
  if (interaction?.isAutocomplete?.()) return respondAutocompleteSafely(interaction, []);
  return respondSafely(interaction, { content: message, flags: 64 });
}

async function dispatchInteraction(interaction, client) {
  // Interruptor de NihongoTracker: si está apagado, se bloquea todo lo que usa su API.
  if (!ntToggle.isEnabled()) {
    if (interaction.isAutocomplete() && ntToggle.isApiCommand(interaction.commandName)) {
      return respondAutocompleteSafely(interaction, []);
    }
    if (interaction.isChatInputCommand() && ntToggle.isApiCommand(interaction.commandName)) {
      return respondSafely(interaction, { content: ntToggle.DISABLED_MESSAGE, flags: 64 });
    }
    if (
      (interaction.isButton() && ntToggle.isApiButton(interaction.customId)) ||
      (interaction.isStringSelectMenu() && ntToggle.isApiSelect(interaction.customId))
    ) {
      return respondSafely(interaction, { content: ntToggle.DISABLED_MESSAGE, flags: 64 });
    }
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return respondAutocompleteSafely(interaction, []);
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      logInteractionError("autocomplete", interaction, err);
      await respondAutocompleteSafely(interaction, []);
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;
    const route = customId.startsWith("ranking_period:") || customId.startsWith("ranking_page:")
      ? ["ranking", "handleSelect"]
      : customId.startsWith("mispersonajes_page:")
        ? ["mis-personajes", "handleSelect"]
        : customId.startsWith("obrasdisponibles_page")
          ? ["obras-disponibles", "handleSelect"]
          : customId.startsWith("obrasdelreto_page")
            ? ["obras-del-reto", "handleSelect"]
            : null;

    if (!route) return;
    const command = client.commands.get(route[0]);
    if (!command?.[route[1]]) return;
    try {
      await command[route[1]](interaction);
    } catch (err) {
      await reportInteractionFailure(interaction, `select:${route[0]}`, err);
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("nukiyasu:")) {
      const command = client.commands.get("nukiyasu");
      if (!command?.handleButton) return;
      try {
        await command.handleButton(interaction);
      } catch (err) {
        await reportInteractionFailure(interaction, "nukiyasu-button", err, "No pude actualizar esta página.");
      }
      return;
    }

    if (interaction.customId === "voting_refresh") {
      const command = client.commands.get("voting");
      if (!command?.handleRefresh) return;
      try {
        await command.handleRefresh(interaction);
      } catch (err) {
        await reportInteractionFailure(interaction, "voting-button", err);
      }
      return;
    }

    if (interaction.customId.startsWith("log_delete:")) {
      const command = client.commands.get("log");
      if (!command?.handleDelete) return;
      try {
        await command.handleDelete(interaction);
      } catch (err) {
        await reportInteractionFailure(interaction, "log-button", err, "No pude borrar el log.");
      }
      return;
    }
  }

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      await reportInteractionFailure(interaction, `command:${interaction.commandName}`, err, "Error al ejecutar el comando.");
    }
  }
}

export default {
  name: "interactionCreate",
  async execute(interaction, client) {
    try {
      await dispatchInteraction(interaction, client);
    } catch (err) {
      await reportInteractionFailure(interaction, "interactionCreate", err);
    }
  }
};
