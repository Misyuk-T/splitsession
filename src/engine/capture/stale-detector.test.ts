import { describe, expect, it } from "vitest";

import {
  type MainFrameSend,
  parseCookieHeader,
  StaleNavigationDetector,
  violates,
} from "./stale-detector";

const T0 = 1_000_000;
const send = (over: Partial<MainFrameSend> = {}): MainFrameSend => ({
  requestId: "r1",
  tabId: 1,
  url: "http://a.localhost/whoami",
  method: "GET",
  sentAt: T0 + 5,
  cookie: null,
  ...over,
});
const sidChange = {
  name: "sid",
  value: "new",
  domain: "a.localhost",
  hostOnly: true,
  secure: false,
};

function detector(now = T0 + 10) {
  const clock = { now };
  const d = new StaleNavigationDetector({
    containerOf: (tabId) => (tabId === 1 || tabId === 2 ? "alt" : undefined),
    now: () => clock.now,
  });
  return { d, clock };
}

describe("parseCookieHeader / violates", () => {
  it("parses pairs and nameless cookies", () => {
    expect(parseCookieHeader("a=1; b=2;  c")).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["", "c"],
    ]);
    expect(parseCookieHeader(null)).toEqual([]);
  });

  it("flags a request that lacks a changed cookie it should carry", () => {
    expect(violates(send(), [sidChange])).toBe(true);
    expect(violates(send({ cookie: "sid=old" }), [sidChange])).toBe(true);
    expect(violates(send({ cookie: "x=1; sid=new" }), [sidChange])).toBe(false);
  });

  it("ignores hosts the change does not apply to, Secure cookies on http and partitioned cookies", () => {
    expect(
      violates(send({ url: "http://sub.a.localhost/" }), [sidChange]),
    ).toBe(false);
    expect(
      violates(send({ url: "http://sub.a.localhost/" }), [
        { ...sidChange, hostOnly: false },
      ]),
    ).toBe(true);
    expect(
      violates(send({ url: "http://example.com/" }), [
        { ...sidChange, domain: "example.com", secure: true },
      ]),
    ).toBe(false);
    expect(violates(send(), [{ ...sidChange, partitioned: true }])).toBe(false);
  });

  it("ignores SameSite=Strict cookies: cross-site top-level navigations go without them by design", () => {
    expect(violates(send(), [{ ...sidChange, sameSite: "strict" }])).toBe(
      false,
    );
    expect(violates(send(), [{ ...sidChange, sameSite: "lax" }])).toBe(true);
  });

  it("flags a deleted cookie that is still sent", () => {
    const deleted = { ...sidChange, value: null, previousValue: "old" };
    expect(violates(send({ cookie: "sid=old" }), [deleted])).toBe(true);
    // Another cookie of the same name (a Domain `sid` beside the deleted host-only one) is no evidence.
    expect(violates(send({ cookie: "sid=other" }), [deleted])).toBe(false);
    // Previous value unknown: ambiguous, so not an expectation (importing beats dropping).
    expect(
      violates(send({ cookie: "sid=old" }), [{ ...sidChange, value: null }]),
    ).toBe(false);
    expect(
      violates(send({ cookie: "x=1" }), [{ ...sidChange, value: null }]),
    ).toBe(false);
  });
});

describe("StaleNavigationDetector", () => {
  it("judges a request against the latest change of a cookie: after sid=A then sid=B, a request carrying B is fresh", () => {
    const { d } = detector(T0 + 200);
    d.noteChange({
      containerId: "alt",
      from: T0,
      until: T0 + 3,
      changes: [{ ...sidChange, value: "A", path: "/" }],
    });
    d.noteChange({
      containerId: "alt",
      from: T0 + 100,
      until: T0 + 103,
      changes: [{ ...sidChange, value: "B", path: "/" }],
    });
    expect(d.noteSend(send({ sentAt: T0 + 150, cookie: "sid=B" }))).toEqual([]);
    expect(
      d.noteSend(send({ requestId: "r2", sentAt: T0 + 150, cookie: "sid=A" })),
    ).toHaveLength(1);
  });

  it("re-navigates the 302 hop that went out before the new cookie (send noted first)", () => {
    const { d } = detector();
    expect(d.noteSend(send())).toEqual([]);
    expect(
      d.noteChange({
        containerId: "alt",
        from: T0,
        until: T0 + 3,
        changes: [sidChange],
      }),
    ).toEqual([
      {
        tabId: 1,
        url: "http://a.localhost/whoami",
        requestId: "r1",
        reason: "stale-cookies",
      },
    ]);
  });

  it("also when the send event arrives after the rules resolved (Chrome lag), judged by the header", () => {
    const { d } = detector();
    d.noteChange({
      containerId: "alt",
      from: T0,
      until: T0 + 3,
      changes: [sidChange],
    });
    expect(d.noteSend(send({ sentAt: T0 + 4 }))).toHaveLength(1);
    expect(
      d.noteSend(send({ requestId: "r2", sentAt: T0 + 6, cookie: "sid=new" })),
    ).toEqual([]);
  });

  it("leaves alone: the request that caused the change, other containers, other hosts, non-GET", () => {
    const { d } = detector();
    d.noteChange({
      containerId: "alt",
      from: T0,
      until: T0 + 3,
      changes: [sidChange],
    });
    expect(d.noteSend(send({ sentAt: T0 - 1 }))).toEqual([]);
    expect(d.noteSend(send({ requestId: "x", tabId: 9 }))).toEqual([]);
    expect(
      d.noteSend(send({ requestId: "y", url: "http://b.localhost/" })),
    ).toEqual([]);
    expect(d.noteSend(send({ requestId: "z", method: "POST" }))).toEqual([]);
  });

  it("re-navigates a (tab, url) once per window and caps re-navigations per tab", () => {
    const { d } = detector();
    d.noteChange({
      containerId: "alt",
      from: T0,
      until: T0 + 3,
      changes: [sidChange],
    });
    expect(d.noteSend(send())).toHaveLength(1);
    expect(d.noteSend(send({ requestId: "r1b", sentAt: T0 + 6 }))).toEqual([]);
    for (let i = 0; i < 5; i++)
      d.noteChange({
        containerId: "alt",
        from: T0 + 10 + i,
        until: T0 + 11 + i,
        changes: [sidChange],
      });
    let total = 1;
    for (let i = 0; i < 5; i++)
      total += d.noteSend(
        send({ requestId: `q${i}`, sentAt: T0 + 10 + i }),
      ).length;
    expect(total).toBeLessThanOrEqual(3);
  });

  it("assignment: re-navigates the stray request sent before the rules, or racing them with a foreign header", () => {
    const { d } = detector();
    d.noteSend(
      send({ tabId: 2, sentAt: T0 - 2, url: "http://a.localhost/start" }),
    );
    expect(d.noteAssignment(2, T0, () => false)).toEqual([
      {
        tabId: 2,
        url: "http://a.localhost/start",
        requestId: "r1",
        reason: "pre-assignment",
      },
    ]);
    const { d: d2 } = detector();
    d2.noteAssignment(2, T0, (s) => s.cookie === "real=1");
    expect(
      d2.noteSend(
        send({ tabId: 2, requestId: "late", sentAt: T0 + 1, cookie: "real=1" }),
      ),
    ).toHaveLength(1);
    expect(
      d2.noteSend(
        send({
          tabId: 2,
          requestId: "ok",
          sentAt: T0 + 2,
          cookie: null,
          url: "http://a.localhost/x",
        }),
      ),
    ).toEqual([]);
  });

  it("suppress() and forgetTab() silence a tab the caller navigates itself", () => {
    const { d } = detector();
    d.suppress(1);
    d.noteChange({
      containerId: "alt",
      from: T0,
      until: T0 + 3,
      changes: [sidChange],
    });
    expect(d.noteSend(send())).toEqual([]);
    const { d: d2 } = detector();
    d2.noteSend(send({ tabId: 2, sentAt: T0 - 2 }));
    d2.forgetTab(2);
    expect(d2.noteAssignment(2, T0, () => false)).toEqual([]);
  });

  it("only re-navigates http(s) URLs and forgets old sends", () => {
    const { d, clock } = detector();
    d.noteSend(send({ url: "about:blank" }));
    expect(
      d.noteChange({
        containerId: "alt",
        from: T0,
        until: T0 + 3,
        changes: [{ ...sidChange, domain: "blank", hostOnly: false }],
      }),
    ).toEqual([]);
    d.noteSend(send({ requestId: "old" }));
    clock.now = T0 + 60_000;
    expect(
      d.noteChange({
        containerId: "alt",
        from: T0,
        until: T0 + 3,
        changes: [sidChange],
      }),
    ).toEqual([]);
    expect(d.latestSend(1)).toBeUndefined();
  });
});
