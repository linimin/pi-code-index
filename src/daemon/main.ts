import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { buildRuntimePaths } from "../shared/protocol.ts";
import { DaemonAlreadyRunningError, createDaemonServer } from "./server.ts";

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function main(): Promise<void> {
  const runtimePaths = buildRuntimePaths();
  const server = await createDaemonServer({
    cacheDir: runtimePaths.cacheDir,
    socketPath: runtimePaths.socketPath,
    version: await readPackageVersion(),
  });

  try {
    await server.start();
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      return;
    }

    throw error;
  }

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("pi-code-index daemon failed", error);
    process.exitCode = 1;
  });
}
