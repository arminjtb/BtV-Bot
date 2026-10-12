// Interruptor global para todo lo que hable con la API de nihongotracker.app.
// Por defecto está APAGADO: al arrancar el bot nada llama a la API hasta que se use /nt-api.
// El estado vive en memoria, así que cada reinicio vuelve a apagado.
// Es CommonJS a propósito para poder importarlo tanto con require() como con import.

let enabled = false;

// Slash commands que usan la API de NihongoTracker (directa o indirectamente).
const API_COMMANDS = new Set([
  "log",
  "borrar-log",
  "media",
  "ranking",
  "voting",
  "sync-inmersion",
  "link",
  "readathon",
  "reto-prueba",
  "obras-disponibles"
]);

// Botones / menús que pertenecen a esos comandos.
const API_BUTTON_IDS = ["log_delete:", "voting_refresh"];
const API_SELECT_PREFIXES = ["ranking_period:", "ranking_page:"];

const DISABLED_MESSAGE =
  "🔌 La conexión con NihongoTracker está **desactivada** en este momento. " +
  "Un administrador puede activarla con `/nt-api`.";

module.exports = {
  isEnabled: () => enabled,
  // Red de seguridad para las funciones de lib que hacen requests: lanza si está apagado.
  assertEnabled: () => {
    if (!enabled) throw new Error("NihongoTracker desactivado (/nt-api)");
  },
  setEnabled: (value) => { enabled = Boolean(value); return enabled; },
  toggle: () => { enabled = !enabled; return enabled; },

  isApiCommand: (name) => API_COMMANDS.has(name),
  isApiButton: (customId) =>
    API_BUTTON_IDS.some(id => customId === id || customId.startsWith(id)),
  isApiSelect: (customId) =>
    API_SELECT_PREFIXES.some(prefix => customId.startsWith(prefix)),

  DISABLED_MESSAGE,
  API_COMMANDS
};
