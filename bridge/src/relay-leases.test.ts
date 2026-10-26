import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ClientResponse,
  type HostToExtension,
  SESSION_TOOL,
} from "../../src/bridge/protocol";
import { Leases } from "./leases";
import { Relay } from "./relay";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

describe("relay: tab leases", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  let now = 0;
  function leased() {
    now = 1_000_000;
    const sent: HostToExtension[] = [];
    const relay = new Relay({
      sendToExtension: (m) => sent.push(m),
      timeoutMs: 1000,
      leases: new Leases(() => now),
    });
    // One presence connection and short call connections per session, as the MCP server makes them.
    const session = (name: string) => {
      const got: ClientResponse[] = [];
      const presence = relay.addClient(() => {});
      relay.handleClient(presence, {
        id: 1,
        tool: SESSION_TOOL,
        session: name,
      });
      let n = 1;
      const call = (
        tool: string,
        args: Record<string, unknown> = {},
        extra: Record<string, unknown> = {},
      ) => {
        const id = relay.addClient((r) => got.push(r));
        relay.handleClient(id, {
          id: ++n,
          tool,
          args,
          session: name,
          ...extra,
        });
        return id;
      };
      return { name, got, presence, call };
    };
    /** Answers the newest request to the extension. */
    const answer = (value: unknown) => {
      const last = sent.filter((m) => m.type === "request").at(-1) as {
        id: number;
      };
      relay.handleExtension({
        type: "response",
        id: last.id,
        ok: true,
        result: text(JSON.stringify(value)),
      });
    };
    const requests = () => sent.filter((m) => m.type === "request").length;
    return { relay, sent, session, answer, requests };
  }
  const lastError = (r: { got: ClientResponse[] }) =>
    (r.got.at(-1) as { error: string }).error;
  const lastJson = (r: { got: ClientResponse[] }) =>
    JSON.parse(
      (r.got.at(-1) as unknown as { result: { content: [{ text: string }] } })
        .result.content[0].text,
    );

  it("a mutating action leases the tab; another session's mutating action is refused without reaching Chrome", () => {
    const { session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7, ref: "e1" });
    answer({ ok: true });
    expect(requests()).toBe(1);
    b.call("type", { tabId: 7, ref: "e2", text: "x" });
    expect(requests()).toBe(1);
    expect(b.got).toHaveLength(1);
    expect(b.got[0]).toMatchObject({ ok: false });
    expect(lastError(b)).toMatch(
      /^tab 7 is in use by another agent session \(agent-a, last action 0s ago\); open your own tab/,
    );
    // the holder goes on
    a.call("press_key", { tabId: 7, key: "Enter" });
    expect(requests()).toBe(2);
  });

  it("takeOver passes and moves the lease; takeOver never reaches the extension; the session name does (for the page label)", () => {
    const { session, sent, answer } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7 });
    answer({});
    b.call("click", { tabId: 7 }, { takeOver: true });
    expect(sent.at(-1)).toMatchObject({ type: "request", args: { tabId: 7 } });
    expect(JSON.stringify(sent.at(-1))).not.toMatch(/takeOver/);
    expect(sent.at(-1)).toMatchObject({ session: "agent-b" });
    answer({});
    a.call("click", { tabId: 7 });
    expect(lastError(a)).toMatch(/agent-b/);
  });

  it("read-only tools and hover/scroll are always allowed and take no lease", () => {
    const { session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7 });
    answer({});
    for (const tool of [
      "snapshot",
      "get_tab_text",
      "get_tab_html",
      "screenshot_tab",
      "console_messages",
      "network_requests",
      "wait_for",
      "watch",
      "hover",
      "scroll",
    ])
      b.call(tool, { tabId: 7 });
    expect(requests()).toBe(11);
    // b took nothing: a's lease stands, an untouched tab is free for b
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(11);
    b.call("click", { tabId: 8 });
    expect(requests()).toBe(12);
  });

  it("a tab opened by a session is its lease; an unleased tab is free and the first mutating action leases it", () => {
    const { session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("open_tab", { url: "https://x.test" });
    answer({ tabId: 50, windowId: 1 });
    b.call("click", { tabId: 50 });
    expect(requests()).toBe(1); // refused
    const c = session("agent-c");
    c.call("open_in_container", { containerId: "x", url: "https://y.test" });
    answer({ tabId: 51 });
    expect(requests()).toBe(2);
    a.call("navigate", { tabId: 51, url: "https://z.test" });
    expect(requests()).toBe(2); // refused: c opened it
    // the user's own tab 9: b takes it first
    b.call("reload", { tabId: 9 });
    expect(requests()).toBe(3);
    a.call("reload", { tabId: 9 });
    expect(requests()).toBe(3);
  });

  it("a lease expires 120 s after the holder's last action", () => {
    const { session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7 });
    answer({});
    now += 119_000;
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(1);
    now += 1_000;
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(2);
  });

  it("the holder disconnecting frees its tabs; another connection of the same name keeps them", () => {
    const { relay, session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    const a2 = relay.addClient(() => {});
    relay.handleClient(a2, { id: 1, tool: SESSION_TOOL, session: "agent-a" });
    a.call("click", { tabId: 7 });
    answer({});
    relay.removeClient(a.presence);
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(1); // still held through a2
    relay.removeClient(a2);
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(2);
  });

  it("closing a tab frees it; a tab replaced by a domain rule moves the lease to the new one", () => {
    const { session, answer, requests } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7 });
    answer({});
    a.call("close_tab", { tabId: 7 });
    answer({ closed: true });
    b.call("click", { tabId: 7 });
    expect(requests()).toBe(3);
    answer({});
    a.call("navigate", { tabId: 20, url: "https://x.test" });
    answer({ tabId: 21 }); // a rule replaced tab 20 with 21
    b.call("click", { tabId: 21 });
    expect(lastError(b)).toMatch(/tab 21 .*agent-a/);
    b.call("click", { tabId: 20 });
    expect(requests()).toBe(5); // the old number is free; the refused click on 21 never went out
  });

  it("list_tabs shows inUseBy and yours; the shape is otherwise untouched", () => {
    const { session, answer } = leased();
    const a = session("agent-a");
    const b = session("agent-b");
    a.call("click", { tabId: 7 });
    answer({});
    b.call("list_tabs");
    answer([
      { tabId: 7, title: "t", container: null },
      { tabId: 8, title: "u", container: null },
    ]);
    expect(lastJson(b)).toEqual([
      { tabId: 7, title: "t", container: null, inUseBy: "agent-a" },
      { tabId: 8, title: "u", container: null },
    ]);
    a.call("list_tabs");
    answer([{ tabId: 7 }]);
    expect(lastJson(a)).toEqual([{ tabId: 7, yours: true }]);
  });

  it("a client that names no session (an older MCP server) is never leased or refused", () => {
    const { relay, session, answer, requests } = leased();
    const a = session("agent-a");
    a.call("click", { tabId: 7 });
    answer({});
    const old: ClientResponse[] = [];
    const id = relay.addClient((r) => old.push(r));
    relay.handleClient(id, { id: 1, tool: "click", args: { tabId: 7 } });
    expect(requests()).toBe(2);
    answer({});
    relay.handleClient(id, { id: 2, tool: "list_tabs", args: {} });
    answer([{ tabId: 7 }]);
    expect(
      JSON.parse(
        (old.at(-1) as unknown as { result: { content: [{ text: string }] } })
          .result.content[0].text,
      ),
    ).toEqual([{ tabId: 7 }]);
  });

  it("an error answer does not change who holds a tab that was opened", () => {
    const { relay, session, requests } = leased();
    const a = session("agent-a");
    a.call("open_tab", { url: "https://x.test" });
    relay.handleExtension({
      type: "response",
      id: 1,
      ok: false,
      error: "no window",
    });
    expect(lastError(a)).toBe("no window");
    expect(requests()).toBe(1);
  });
});
