export default {
  name: "interactionCreate",
  async execute(interaction, client) {
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error("Autocomplete error:", err);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;

      if (customId.startsWith("ranking_period:") || customId.startsWith("ranking_page:")) {
        const command = client.commands.get("ranking");
        if (command?.handleSelect) {
          try {
            await command.handleSelect(interaction);
          } catch (err) {
            console.error("Select menu error:", err);
          }
        }
        return;
      }

      if (customId.startsWith("mispersonajes_page:")) {
        const command = client.commands.get("mis-personajes");
        if (command?.handleSelect) {
          try {
            await command.handleSelect(interaction);
          } catch (err) {
            console.error("Select menu error:", err);
          }
        }
        return;
      }

      if (customId.startsWith("obrasdisponibles_page")) {
        const command = client.commands.get("obras-disponibles");
        if (command?.handleSelect) {
          try {
            await command.handleSelect(interaction);
          } catch (err) {
            console.error("Select menu error:", err);
          }
        }
        return;
      }

      if (customId.startsWith("obrasdelreto_page")) {
        const command = client.commands.get("obras-del-reto");
        if (command?.handleSelect) {
          try {
            await command.handleSelect(interaction);
          } catch (err) {
            console.error("Select menu error:", err);
          }
        }
        return;
      }

      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "voting_refresh") {
        const votingCmd = interaction.client.commands.get("voting");
        if (votingCmd?.handleRefresh) {
          await votingCmd.handleRefresh(interaction);
        }
        return;
      }

      if (interaction.customId.startsWith("log_delete:")) {
        const logCmd = interaction.client.commands.get("log");
        if (logCmd?.handleDelete) {
          try {
            await logCmd.handleDelete(interaction);
          } catch (err) {
            console.error("Log delete button error:", err);
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({
                content: "No pude borrar el log.",
                flags: 64
              });
            }
          }
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
        console.error("Slash command error:", err);
        if (!interaction.replied) {
          await interaction.reply({
            content: "Error executing command.",
            flags: 64
          });
        }
      }
    }
  }
};
