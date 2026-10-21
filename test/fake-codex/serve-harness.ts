// Mimics `just-usage serve`: an open server, one wedged codex app-server child,
// and the real shutdown handler.
import { createServer } from "node:http";
import { AppServerClient } from "../../src/adapters/codex.ts";
import { installShutdown } from "../../src/shutdown.ts";

const server = createServer(() => {}).listen(0, "127.0.0.1");
AppServerClient.spawn(undefined, { killGraceMs: 300 });
installShutdown(() => server.close(), { graceMs: 300 });
