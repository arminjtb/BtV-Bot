function toSocketUrl(baseUrl) {
  const url = new URL(process.env.NUKIYASU_SOCKET_URL || baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/socket.io/`;
  url.search = "?EIO=4&transport=websocket";
  return url.toString();
}

export function connectNukiyasuSocket({ baseUrl, onLibraryUpdate, onError } = {}) {
  if (typeof WebSocket === "undefined" || !baseUrl) return null;

  let socket;
  let stopped = false;
  let reconnectTimer;

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(toSocketUrl(baseUrl));
      socket.addEventListener("open", () => {});
      socket.addEventListener("message", event => {
        const message = typeof event.data === "string" ? event.data : "";
        if (message === "2") {
          socket.send("3");
          return;
        }
        if (message.startsWith("0")) {
          // Nukiyasu declara el gateway en el namespace /ws.
          socket.send("40/ws,");
          return;
        }
        const eventStart = message.indexOf("[");
        if (!message.startsWith("42") || eventStart < 0) return;
        try {
          const [name, payload] = JSON.parse(message.slice(eventStart));
          if (name === "notification" && payload?.action === "LIBRARY_UPDATE") onLibraryUpdate?.(payload);
        } catch (error) {
          onError?.(error);
        }
      });
      socket.addEventListener("error", error => onError?.(error));
      socket.addEventListener("close", () => {
        if (stopped || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 30_000);
      });
    } catch (error) {
      onError?.(error);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 30_000);
    }
  };

  connect();
  return {
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
    }
  };
}

