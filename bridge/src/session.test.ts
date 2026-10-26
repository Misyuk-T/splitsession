import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeLine, LineReader } from "../../src/bridge/framing";
import { validateArgs } from "../../src/bridge/validate";
import { type CallContext, Dispatcher } from "./dispatch";
import { LEASE_MUTATING } from "./leases";
import { callHost, MCP_TOOLS, sessionName } from "./mcp";
import type { Endpoint } from "./profiles";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("session name", () => {
  it("is the base plus a suffix; falls back to agent; cleans odd characters", () => {
    expect(sessionName("claude-code", "ab12")).toBe("claude-code-ab12");
    expect(sessionName(undefined, "ab12")).toBe("agent-ab12");
    expect(sessionName("  ", "ab12")).toBe("agent-ab12");
    expect(sessionName("my\nsession ✓", "ab12")).toBe("mysession-ab12");
    expect(sessionName("x".repeat(80), "ab12")).toHaveLength(40 + 5);
  });

  it("gets a random suffix by default, different between calls", () => {
    const names = new Set(Array.from({ length: 20 }, () => sessionName("a")));
    expect(names.size).toBeGreaterThan(1);
    for (const n of names) expect(n).toMatch(/^a-[0-9a-f]{4}$/);
  });
});

describe("takeOver in the MCP tool schemas", () => {
  it("is offered on exactly the mutating tools and validates as a boolean", () => {
    for (const t of MCP_TOOLS) {
      const has = "takeOver" in (t.inputSchema.properties ?? {});
      expect(has, t.name).toBe(LEASE_MUTATING.has(t.name));
    }
    const click = MCP_TOOLS.find((t) => t.name === "click")!;
    expect(
      validateArgs(click.inputSchema, { tabId: 1, takeOver: true }).ok,
    ).toBe(true);
    expect(
      validateArgs(click.inputSchema, { tabId: 1, takeOver: "yes" }).ok,
    ).toBe(false);
  });
});

describe("dispatcher and leases", () => {
  const ep: Endpoint = {
    key: "aaaaaaaaaa",
    socket: "/b/a.sock",
    legacy: false,
    ino: 1,
  };
  const reply = (value: unknown) => ({
    id: 1,
    ok: true as const,
    result: {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    },
  });
  function world(session: string | undefined) {
    const calls: Array<{ tool: string; args: unknown; ctx?: CallContext }> = [];
    const d = new Dispatcher({
      discover: () => [ep],
      unreachable: () => "off",
      session: () => session,
      call: async (_ep, tool, args, ctx) => {
        calls.push({ tool, args, ...(ctx ? { ctx } : {}) });
        if (tool === "__tabs") return reply([{ tabId: 7, windowId: 1 }]);
        return reply({ tabId: 7 });
      },
    });
    return { d, calls };
  }

  it("sends the session with agent actions and takeOver in the context, never in the arguments", async () => {
    const { d, calls } = world("agent-a1");
    await d.run("click", { tabId: 7, ref: "e1", takeOver: true });
    await d.run("snapshot", { tabId: 7 });
    const real = calls.filter((c) => !c.tool.startsWith("__"));
    expect(real[0]).toEqual({
      tool: "click",
      args: { tabId: 7, ref: "e1" },
      ctx: { session: "agent-a1", takeOver: true },
    });
    expect(real[1]).toMatchObject({ ctx: { session: "agent-a1" } });
    expect(real[1]!.ctx).not.toHaveProperty("takeOver");
    // the internal tab index is never attributed to the session
    expect(calls.filter((c) => c.tool === "__tabs").every((c) => !c.ctx)).toBe(
      true,
    );
  });

  it("without a session (no identity) it calls the host exactly as before", async () => {
    const { d, calls } = world(undefined);
    await d.run("click", { tabId: 7, ref: "e1", takeOver: true });
    const real = calls.find((c) => c.tool === "click")!;
    expect(real).toEqual({ tool: "click", args: { tabId: 7, ref: "e1" } });
  });

  it("list_tabs carries the session so the host can mark the caller's tabs", async () => {
    const { d, calls } = world("agent-a1");
    await d.run("list_tabs", {});
    expect(calls.find((c) => c.tool === "list_tabs")?.ctx).toEqual({
      session: "agent-a1",
    });
  });
});

describe("callHost envelope", () => {
  it("adds session and takeOver beside the arguments, only when given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fb-"));
    dirs.push(dir);
    const sock = path.join(dir, "h.sock");
    const seen: unknown[] = [];
    const server = net.createServer((socket) => {
      const lines = new LineReader();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const m of lines.push(chunk) as Array<{ id: number }>) {
          seen.push(m);
          socket.write(
            encodeLine({
              id: m.id,
              ok: true,
              result: { content: [{ type: "text", text: "{}" }] },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      await callHost("click", { tabId: 1 }, 2000, sock, {
        session: "agent-a1",
        takeOver: true,
      });
      await callHost("click", { tabId: 1 }, 2000, sock);
    } finally {
      server.close();
    }
    expect(seen).toEqual([
      {
        id: 1,
        tool: "click",
        args: { tabId: 1 },
        session: "agent-a1",
        takeOver: true,
      },
      { id: 1, tool: "click", args: { tabId: 1 } },
    ]);
    vi.restoreAllMocks();
  });
});
