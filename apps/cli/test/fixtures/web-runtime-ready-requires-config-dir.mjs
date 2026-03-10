const expectedConfigDir = process.env.ORQIS_EXPECTED_CONFIG_DIR?.trim();
const runtimeConfigDir = process.env.ORQIS_CONFIG_DIR?.trim();

if (
  expectedConfigDir === undefined ||
  expectedConfigDir.length === 0 ||
  runtimeConfigDir === undefined ||
  runtimeConfigDir.length === 0 ||
  expectedConfigDir !== runtimeConfigDir
) {
  if (typeof process.send === "function") {
    process.send({
      type: "orqis:web-runtime-start-error",
      message: `expected ORQIS_CONFIG_DIR=${expectedConfigDir ?? "<missing>"} but received ${runtimeConfigDir ?? "<missing>"}`,
    });
  }

  process.exit(1);
}

if (typeof process.send === "function") {
  process.send({
    type: "orqis:web-runtime-ready",
    baseUrl: "http://127.0.0.1:43110",
    healthUrl: "http://127.0.0.1:43110/health",
  });
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
