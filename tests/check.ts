import assert from "node:assert/strict";

import extensionEntrypoint from "../extensions/index.ts";
import { createDaemonServer } from "../src/daemon/server.ts";
import { registerIndexCommand } from "../src/extension/commands/index-command.ts";
import { DaemonClient, defaultSocketPath } from "../src/extension/daemon-client.ts";
import { DAEMON_PROTOCOL_VERSION } from "../src/shared/protocol.ts";

const commands = new Map<string, unknown>();

extensionEntrypoint({
  registerCommand(name: string, options: unknown) {
    commands.set(name, options);
  },
} as never);

registerIndexCommand(
  {
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
  } as never,
  {
    createClient: () => new DaemonClient({ socketPath: defaultSocketPath() }),
  },
);

const server = await createDaemonServer({ socketPath: defaultSocketPath(), version: "0.1.0" });
const health = server.health();

assert.equal(typeof extensionEntrypoint, "function");
assert.equal(typeof registerIndexCommand, "function");
assert.equal(commands.has("index"), true);
assert.equal(typeof defaultSocketPath(), "string");
assert.equal(health.protocolVersion, DAEMON_PROTOCOL_VERSION);
assert.ok(health.capabilities.includes("openRepo"));
