import { describe, expect, it, vi } from "vitest";

import { cleanAgentName } from "../../bridge/protocol";
import { AgentActivity, PILL_NAME_MAX, pillName } from "./activity";
import { type ActivityCommand, pageActivity } from "./overlay";

function setup() {
  const commands: ActivityCommand[] = [];
  const b = {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, active: true })),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async (o: { args: ActivityCommand[] }) => {
        commands.push(o.args[0]!);
        return [{ result: true }];
      }),
    },
  };
  const activity = new AgentActivity({
    b: b as never,
    enabled: () => true,
    startBlink: vi.fn(),
    stopBlink: vi.fn(async () => {}),
  });
  return { activity, commands };
}

describe("agent session names", () => {
  it("keep letters, digits, space and - _ . only", () => {
    expect(cleanAgentName("claude-code-a1b2")).toBe("claude-code-a1b2");
    expect(cleanAgentName("My Agent_1.2")).toBe("My Agent_1.2");
    expect(cleanAgentName("<img src=x onerror=alert(1)>")).toBe(
      "img srcx onerroralert1",
    );
    expect(cleanAgentName('"><script>x</script>')).toBe("scriptxscript");
    expect(cleanAgentName("a‮b\nc\td")).toBe("abcd"); // control and bidi characters go
    expect(cleanAgentName("  a   b  ")).toBe("a b");
    expect(cleanAgentName("agent".repeat(30), 64)).toHaveLength(64);
  });

  it("are null when nothing is left or the value is not a string", () => {
    expect(cleanAgentName("")).toBeNull();
    expect(cleanAgentName("<>&;")).toBeNull();
    expect(cleanAgentName(42)).toBeNull();
    expect(cleanAgentName(undefined)).toBeNull();
    expect(cleanAgentName({ toString: () => "x" })).toBeNull();
  });

  it("are cut to 24 characters on the pill, with an ellipsis", () => {
    expect(pillName("codex-a1b2")).toBe("codex-a1b2");
    const long = pillName("a-very-long-session-name-from-an-env-var-1234");
    expect(long.length).toBeLessThanOrEqual(PILL_NAME_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(pillName(undefined)).toBe("");
    expect(pillName("<b>")).toBe("b");
  });
});

describe("the pill names the session", () => {
  it("a touch with a session sends its (sanitised, cut) name to the page", async () => {
    const { activity, commands } = setup();
    await activity.touch(4, "click", null, "claude-code-a1b2");
    await activity.touch(4, "snapshot", null, "<script>alert(1)</script>-x");
    const shows = commands.filter((c) => c.op === "show");
    expect(shows.map((c) => [c.who, c.label])).toEqual([
      ["claude-code-a1b2", "clicking"],
      ["scriptalert1script-x", "reading"],
    ]);
    activity.forget(4);
  });

  it("an old host (no session) leaves the pill as it was", async () => {
    const { activity, commands } = setup();
    await activity.touch(4, "click");
    expect(commands.find((c) => c.op === "show")?.who).toBe("");
    activity.forget(4);
  });
});

describe("pageActivity text", () => {
  it("is built from textContent only: a name can never become markup", () => {
    // The page side sets `s.text.textContent = "<who>: <label>"`; check the source says so (the closed shadow root is only
    // reachable from the page world, which e2e covers).
    const source = pageActivity.toString();
    expect(source).toMatch(
      /textContent = `\$\{cmd\.who \|\| "Agent"\}: \$\{cmd\.label\}`/,
    );
    expect(source).not.toMatch(/innerHTML\s*=/);
  });
});
