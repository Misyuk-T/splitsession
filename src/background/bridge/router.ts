import type { ToolResult } from "../../bridge/protocol";
import { toolByName, toolTimeoutMs } from "../../bridge/spec";
import { validateArgs } from "../../bridge/validate";
import { DEVTOOLS_TOOLS } from "./tools/devtools";
import { INPUT_TOOLS } from "./tools/input";
import { READ_TOOLS } from "./tools/read";
import { TAB_TOOLS } from "./tools/tabs";
import { ToolError } from "./errors";
import { type RouterDeps, ToolContext, type ToolHandler } from "./tool-context";
import { type ActionMeta, type Args, live, withTimeout } from "./tool-kit";

export { ToolError };
export type { RouterDeps } from "./tool-context";
export { type ActionMeta, checkUrl, withTimeout } from "./tool-kit";

/** The bridge's command router: validates the arguments of a tool call and runs it with extension APIs. */
export class BridgeRouter {
  private readonly c: ToolContext;
  /** Every tool by name (their arguments are described in src/bridge/spec.ts). Built here, not at module level, so Lite drops it all. */
  private readonly tools: Record<string, ToolHandler> = {
    ...TAB_TOOLS,
    ...READ_TOOLS,
    ...INPUT_TOOLS,
    ...DEVTOOLS_TOOLS,
  };

  constructor(d: RouterDeps) {
    this.c = new ToolContext(d);
  }

  /** The tab closed. */
  forgetTab(tabId: number): void {
    this.c.refs.delete(tabId);
  }

  /** The agent's MCP process is gone (and no other one is connected): take back viewport overrides and debugger sessions. */
  async release(): Promise<void> {
    await this.c.d.cdp?.release();
  }

  /** Runs one tool. Throws ToolError (or any error) with a message meant for the agent. */
  async run(
    tool: string,
    rawArgs: unknown,
    meta: ActionMeta,
    timeoutMs?: number,
  ): Promise<ToolResult> {
    const spec = toolByName(tool);
    if (!spec) throw new ToolError(`unknown tool "${tool}"`);
    const checked = validateArgs(spec.inputSchema, rawArgs);
    if (!checked.ok) throw new ToolError(`${tool}: ${checked.error}`);
    await this.c.d.facet.ready;
    live(meta);
    return withTimeout(
      this.dispatch(tool, checked.value as Args, meta),
      timeoutMs ?? toolTimeoutMs(tool),
      tool,
      meta.signal,
    );
  }

  private dispatch(
    tool: string,
    a: Args,
    meta: ActionMeta,
  ): Promise<ToolResult> {
    if (typeof a.tabId === "number") meta.tabId = a.tabId;
    meta.tool = tool;
    const handler = Object.hasOwn(this.tools, tool)
      ? this.tools[tool]
      : undefined;
    if (!handler) throw new ToolError(`unknown tool "${tool}"`);
    return handler(this.c, a, meta);
  }
}
