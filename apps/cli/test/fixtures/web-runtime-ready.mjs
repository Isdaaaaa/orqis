const READY_MESSAGE = {
  type: "orqis:web-runtime-ready",
  baseUrl: "http://127.0.0.1:43110",
  healthUrl: "http://127.0.0.1:43110/health",
};

if (typeof process.send === "function") {
  process.send(READY_MESSAGE);
}

const heartbeat = setInterval(() => {
  return;
}, 1_000);

const shutdown = () => {
  clearInterval(heartbeat);
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("disconnect", shutdown);
