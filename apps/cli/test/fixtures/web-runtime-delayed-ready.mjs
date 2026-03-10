const READY_DELAY_MS = Number.parseInt(
  process.env.ORQIS_TEST_RUNTIME_READY_DELAY_MS ?? "5500",
  10,
);

const READY_MESSAGE = {
  type: "orqis:web-runtime-ready",
  baseUrl: "http://127.0.0.1:43110",
  healthUrl: "http://127.0.0.1:43110/health",
};

const START_ERROR_MESSAGE = {
  type: "orqis:web-runtime-start-error",
  message: "invalid ORQIS_TEST_RUNTIME_READY_DELAY_MS",
};

if (!Number.isInteger(READY_DELAY_MS) || READY_DELAY_MS < 0) {
  if (typeof process.send === "function") {
    process.send(START_ERROR_MESSAGE);
  }
  process.exit(1);
}

const heartbeat = setInterval(() => {
  return;
}, 1_000);

const readyTimer = setTimeout(() => {
  if (typeof process.send === "function") {
    process.send(READY_MESSAGE);
  }
}, READY_DELAY_MS);

const shutdown = () => {
  clearInterval(heartbeat);
  clearTimeout(readyTimer);
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("disconnect", shutdown);
