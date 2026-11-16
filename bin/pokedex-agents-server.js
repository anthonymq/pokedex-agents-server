#!/usr/bin/env bun
// Starts the Pokedex agents server. Apps start it when they can't reach it; a second copy
// finds the port taken and exits quietly, so starting it twice is harmless.
import { startServer, DEFAULT_PORT } from "../src/server.js";
import { settings } from "../src/store.js";

const port = Number(process.env.POKEDEX_PORT) || settings().port || DEFAULT_PORT;
const log = (...a) => console.log(new Date().toISOString(), ...a);
try {
  startServer({ port, log });
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    log(`port ${port} is taken: the server is already running`);
    process.exit(0);
  }
  throw error;
}
