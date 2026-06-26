declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIContext {
    notify(message: string, level?: "info" | "warn" | "error"): void;
  }

  export interface ExtensionCommandContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    cwd: string;
  }

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      options: {
        description?: string;
        getArgumentCompletions?:
          | ((prefix: string) => Array<{ value: string; label?: string }> | null)
          | ((prefix: string) => Promise<Array<{ value: string; label?: string }> | null>);
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ): void;
  }
}
