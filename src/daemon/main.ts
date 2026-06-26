import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createDaemonServer } from "./server";

function defaultSocketPath(): string {
  return join(homedir(), ".cache", "pi-index", "daemon.sock");
}

async function main(): Promise<void> {
  const socketPath = process.env.PI_CODE_INDEX_SOCKET_PATH ?? defaultSocketPath();
  await mkdir(dirname(socketPath), { recursive: true });

  const server = await createDaemonServer({ socketPath });
  await server.start();

  // eslint-disable-next-line no-console
  console.log("pi-code-index daemon scaffold started", {
    socketPath,
    health: server.health(),
    note: "Socket transport and request handling are not implemented yet.",
  });

  await server.stop();
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("pi-code-index daemon scaffold failed", error);
    process.exitCode = 1;
  });
}
