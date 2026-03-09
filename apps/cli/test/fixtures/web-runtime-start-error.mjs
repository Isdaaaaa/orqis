if (typeof process.send === "function") {
  process.send({
    type: "orqis:web-runtime-start-error",
    message: "listen EADDRINUSE",
    code: "EADDRINUSE",
  });
}

process.exit(1);
