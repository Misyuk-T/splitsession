import { describe, expect, it } from "vitest";

import {
  buildExport,
  EXPORT_FORMAT,
  parseExport,
  planImport,
} from "./transfer";
import type { Container, Cookie } from "./types";

const containers: Container[] = [
  { id: "work1", name: "Work", color: "blue", createdAt: 1 },
  { id: "home2", name: "Home", color: "green", createdAt: 2 },
];

const cookie = (over: Partial<Cookie> = {}): Cookie => ({
  name: "sid",
  value: "abc",
  domain: "a.localhost",
  hostOnly: true,
  path: "/",
  secure: false,
  httpOnly: true,
  sameSite: "lax",
  partitioned: false,
  partitionKey: null,
  expires: null,
  creationTime: 5,
  ...over,
});

const rules = [
  { domain: "github.com", action: "always" as const, containerId: "work1" },
  { domain: "reddit.com", action: "ask" as const },
];

describe("buildExport", () => {
  it("has no cookies unless asked", () => {
    const file = buildExport({ containers, rules, now: 10 });
    expect(file).toEqual({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: 10,
      containers: [
        { id: "work1", name: "Work", color: "blue" },
        { id: "home2", name: "Home", color: "green" },
      ],
      rules,
    });
    expect("jars" in file).toBe(false);
    expect(JSON.stringify(file)).not.toContain("abc");
  });

  it("includes one jar per container when asked", () => {
    const file = buildExport({
      containers,
      rules,
      jars: { work1: [cookie()] },
      now: 10,
    });
    expect(file.jars).toEqual({ work1: [cookie()], home2: [] });
  });

  it("drops rules whose container is gone", () => {
    const file = buildExport({ containers: [containers[1]!], rules });
    expect(file.rules).toEqual([{ domain: "reddit.com", action: "ask" }]);
  });
});

describe("parseExport", () => {
  const good = () => buildExport({ containers, rules, now: 10 });

  it("accepts its own output, as an object or as text", () => {
    const file = good();
    expect(parseExport(file)).toEqual({ ok: true, file });
    expect(parseExport(JSON.stringify(file))).toEqual({ ok: true, file });
  });

  it("round-trips cookie jars", () => {
    const file = buildExport({
      containers,
      rules,
      jars: { work1: [cookie(), cookie({ name: "b", value: "x" })] },
      now: 10,
    });
    const parsed = parseExport(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.jars?.work1).toHaveLength(2);
  });

  const bad = (label: string, mutate: (f: any) => void, message: RegExp) =>
    it(`rejects: ${label}`, () => {
      const f = JSON.parse(JSON.stringify(good()));
      mutate(f);
      const r = parseExport(f);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(message);
    });

  bad("wrong format", (f) => (f.format = "other"), /Not a SplitSession export/);
  bad("unknown version", (f) => (f.version = 2), /Unsupported export version/);
  bad("containers missing", (f) => delete f.containers, /containers/);
  bad("rules missing", (f) => delete f.rules, /rules/);
  bad("bad id", (f) => (f.containers[0].id = "Not Valid!"), /invalid "id"/);
  bad("duplicate id", (f) => (f.containers[1].id = "work1"), /repeats the id/);
  bad("empty name", (f) => (f.containers[0].name = "   "), /empty name/);
  bad(
    "name too long",
    (f) => (f.containers[0].name = "x".repeat(65)),
    /longer than/,
  );
  bad(
    "duplicate names",
    (f) => (f.containers[1].name = "work"),
    /Two containers are named/,
  );
  bad(
    "unknown colour",
    (f) => (f.containers[0].color = "teal"),
    /unknown colour/,
  );
  bad(
    "rule for a missing container",
    (f) => (f.rules[0].containerId = "ghost"),
    /Rule 1: .*does not exist/,
  );
  bad("rule with a bad domain", (f) => (f.rules[1].domain = "com"), /Rule 2/);
  bad(
    "two rules for one domain",
    (f) => f.rules.push({ domain: "https://www.github.com/", action: "ask" }),
    /more than one rule/,
  );
  bad(
    "jars for an unknown container",
    (f) => (f.jars = { ghost: [] }),
    /unknown container/,
  );
  bad("jar not a list", (f) => (f.jars = { work1: "x" }), /not a list/);
  bad(
    "malformed cookie",
    (f) => (f.jars = { work1: [{ name: "x" }] }),
    /malformed/,
  );
  bad("jars not an object", (f) => (f.jars = []), /"jars"/);

  it.each(["", "not json", "[]", "null", "42"])(
    "rejects non-export text %j",
    (text) => {
      expect(parseExport(text).ok).toBe(false);
    },
  );

  it("rejects absurd sizes", () => {
    const f: any = good();
    f.rules = Array.from({ length: 2001 }, (_, i) => ({
      domain: `s${i}.com`,
      action: "ask",
    }));
    expect(parseExport(f)).toMatchObject({ ok: false });
  });

  it("ignores unknown extra fields", () => {
    const f: any = good();
    f.note = "hello";
    f.containers[0].icon = "x";
    const r = parseExport(f);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.file.containers[0]).toEqual({
        id: "work1",
        name: "Work",
        color: "blue",
      });
  });
});

describe("planImport", () => {
  it("matches containers by name (case-insensitive) and counts the rest", () => {
    const file = buildExport({
      containers,
      rules,
      jars: { work1: [cookie()], home2: [] },
      now: 1,
    });
    const plan = planImport(
      file,
      [{ id: "zzz", name: "work" }],
      [{ domain: "reddit.com" }],
    );
    expect(plan.create.map((c) => c.name)).toEqual(["Home"]);
    expect(plan.match).toEqual([
      {
        exported: { id: "work1", name: "Work", color: "blue" },
        existingId: "zzz",
      },
    ]);
    expect(plan.rules).toBe(2);
    expect(plan.replacedRules).toBe(1);
    expect(plan.jarContainers).toBe(2);
    expect(plan.cookies).toBe(1);
  });

  it("reports no cookies for a file without jars", () => {
    const plan = planImport(buildExport({ containers, rules }), [], []);
    expect(plan.jarContainers).toBe(0);
    expect(plan.cookies).toBe(0);
    expect(plan.create).toHaveLength(2);
  });
});
