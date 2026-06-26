import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIndexCommand } from "./commands/index-command.ts";

export default function createPiCodeIndexExtension(pi: ExtensionAPI): void {
  registerIndexCommand(pi);
}
