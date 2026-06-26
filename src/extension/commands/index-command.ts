import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type IndexSubcommand =
  | "help"
  | "enable"
  | "disable"
  | "status"
  | "reindex"
  | "doctor";

function parseIndexSubcommand(rawArgs: string | undefined): IndexSubcommand {
  const value = rawArgs?.trim().toLowerCase();

  switch (value) {
    case "enable":
    case "on":
      return "enable";
    case "disable":
    case "off":
      return "disable";
    case "status":
      return "status";
    case "reindex":
      return "reindex";
    case "doctor":
      return "doctor";
    default:
      return "help";
  }
}

function buildMessage(command: IndexSubcommand): { title: string; detail: string } {
  switch (command) {
    case "enable":
      return {
        title: "pi-code-index scaffold",
        detail:
          "`/index enable` is registered, but daemon bootstrap, repo registration, and indexing are not implemented yet.",
      };
    case "disable":
      return {
        title: "pi-code-index scaffold",
        detail:
          "`/index disable` is registered, but repo disable/pause behavior is not implemented yet.",
      };
    case "status":
      return {
        title: "pi-code-index scaffold",
        detail:
          "`/index status` is registered, but daemon-backed repo status reporting is not implemented yet.",
      };
    case "reindex":
      return {
        title: "pi-code-index scaffold",
        detail:
          "`/index reindex` is registered, but rebuild orchestration is not implemented yet.",
      };
    case "doctor":
      return {
        title: "pi-code-index scaffold",
        detail:
          "`/index doctor` is registered, but runtime diagnostics are not implemented yet.",
      };
    case "help":
    default:
      return {
        title: "pi-code-index scaffold",
        detail:
          "Available planned commands: /index enable, /index disable, /index status, /index reindex, /index doctor.",
      };
  }
}

export function registerIndexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("index", {
    description: "Manage background indexing for the current repository",
    handler: async (args, ctx) => {
      const subcommand = parseIndexSubcommand(args);
      const message = buildMessage(subcommand);

      if (ctx.hasUI) {
        ctx.ui.notify(message.detail, "info");
      } else {
        // eslint-disable-next-line no-console
        console.log(`${message.title}: ${message.detail}`);
      }
    },
  });
}
