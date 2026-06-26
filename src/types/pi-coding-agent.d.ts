declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIContext {
    notify(message: string, level?: "info" | "warn" | "error"): void;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    cwd: string;
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface ExtensionAPI {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    registerTool(tool: unknown): void;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
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

  export function defineTool<T>(tool: T): T;
}
