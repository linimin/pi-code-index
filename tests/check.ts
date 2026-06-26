import assert from "node:assert/strict";

import extensionEntrypoint from "../extensions/index.ts";
import { createDaemonServer } from "../src/daemon/server.ts";
import { registerIndexCommand } from "../src/extension/commands/index-command.ts";
import { DaemonClient, defaultSocketPath } from "../src/extension/daemon-client.ts";
import { DAEMON_PROTOCOL_VERSION } from "../src/shared/protocol.ts";

const commands = new Map<string, unknown>();
const tools = new Map<string, unknown>();

extensionEntrypoint({
  registerCommand(name: string, options: unknown) {
    commands.set(name, options);
  },
  registerTool(tool: { name: string }) {
    tools.set(tool.name, tool);
  },
  on() {},
  getActiveTools() {
    return [];
  },
  setActiveTools() {},
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
assert.deepEqual([...tools.keys()].sort(), ["file_summary", "impact_analysis", "symbol_lookup"]);
assert.equal(typeof defaultSocketPath(), "string");
assert.equal(health.protocolVersion, DAEMON_PROTOCOL_VERSION);
assert.ok(health.capabilities.includes("openRepo"));
assert.ok(health.capabilities.includes("symbolLookup"));
assert.ok(health.capabilities.includes("fileSummary"));
assert.ok(health.capabilities.includes("impactAnalysis"));
