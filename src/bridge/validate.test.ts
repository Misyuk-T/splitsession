import { describe, expect, it } from "vitest";

import { TOOL_NAMES, toolByName, TOOLS } from "./spec";
import { validateArgs } from "./validate";

const schema = (name: string) => toolByName(name)!.inputSchema;

describe("tool arguments", () => {
  it("lists every tool of the bridge, each with an object schema and a description", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "activate_tab",
        "assign_tab",
        "bridge_info",
        "click",
        "close_tab",
        "extension_log",
        "get_tab_html",
        "get_tab_text",
        "list_containers",
        "list_tabs",
        "navigate",
        "open_in_container",
        "open_tab",
        "run_js",
        "screenshot_tab",
        "scroll",
        "type",
        // CDP ("full hands")
        "snapshot",
        "hover",
        "drag",
        "press_key",
        "select_option",
        "upload_file",
        "wait_for",
        "navigate_back",
        "navigate_forward",
        "reload",
        "handle_dialog",
        "console_messages",
        "network_requests",
        "watch",
        "resize_viewport",
      ].sort(),
    );
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(10);
      for (const key of tool.inputSchema.required ?? [])
        expect(tool.inputSchema.properties[key]).toBeDefined();
    }
  });

  it("fills defaults", () => {
    const r = validateArgs(schema("get_tab_text"), { tabId: 7 });
    expect(r).toEqual({ ok: true, value: { tabId: 7, maxChars: 20_000 } });
    expect(
      validateArgs(schema("open_in_container"), {
        url: "https://a.test",
        container: "Work",
      }),
    ).toEqual({
      ok: true,
      value: {
        url: "https://a.test",
        container: "Work",
        createIfMissing: false,
        active: false,
        wait: true,
      },
    });
  });

  it("requires what is required and rejects unknown arguments", () => {
    expect(validateArgs(schema("get_tab_text"), {})).toEqual({
      ok: false,
      error: 'missing required argument "tabId"',
    });
    expect(
      validateArgs(schema("close_tab"), { tabId: 1, force: true }),
    ).toEqual({ ok: false, error: 'unknown argument "force"' });
  });

  it("checks types, integers, ranges, enums and lengths", () => {
    const bad = (name: string, args: unknown) => {
      const r = validateArgs(schema(name), args);
      expect(r.ok).toBe(false);
      return (r as { error: string }).error;
    };
    expect(bad("close_tab", { tabId: "3" })).toMatch(
      /tabId: expected integer, got string/,
    );
    expect(bad("close_tab", { tabId: 1.5 })).toMatch(/expected integer/);
    expect(bad("close_tab", { tabId: -1 })).toMatch(/at least 0/);
    expect(bad("get_tab_text", { tabId: 1, maxChars: 5 })).toMatch(
      /at least 100/,
    );
    expect(bad("get_tab_text", { tabId: 1, maxChars: 3_000_000 })).toMatch(
      /at most 2000000/,
    );
    expect(bad("screenshot_tab", { tabId: 1, format: "gif" })).toMatch(
      /one of "png", "jpeg"/,
    );
    expect(bad("run_js", { tabId: 1, code: "" })).toMatch(/shorter than 1/);
    expect(bad("run_js", { tabId: 1, code: "x", world: "main" })).toMatch(
      /one of "MAIN", "ISOLATED"/,
    );
    expect(bad("type", { tabId: 1, selector: "a", text: 5 })).toMatch(
      /text: expected string/,
    );
    expect(bad("close_tab", "tab 1")).toMatch(/must be an object/);
    expect(bad("click", { tabId: 1, x: Number.NaN })).toMatch(
      /expected number/,
    );
  });

  it("accepts null where the schema allows it (assign_tab leaves the container)", () => {
    expect(
      validateArgs(schema("assign_tab"), { tabId: 1, container: null }),
    ).toEqual({
      ok: true,
      value: {
        tabId: 1,
        container: null,
        createIfMissing: false,
        reload: true,
      },
    });
    expect(validateArgs(schema("assign_tab"), { tabId: 1 }).ok).toBe(false);
  });

  it("treats missing arguments as an empty object for tools without required ones", () => {
    expect(validateArgs(schema("list_containers"), undefined)).toEqual({
      ok: true,
      value: {},
    });
    expect(validateArgs(schema("list_tabs"), null)).toEqual({
      ok: true,
      value: {},
    });
  });

  it("checks arrays (items, bounds) and string patterns", () => {
    expect(
      validateArgs(schema("select_option"), {
        tabId: 1,
        ref: "e3",
        values: ["a", "b"],
      }),
    ).toEqual({ ok: true, value: { tabId: 1, ref: "e3", values: ["a", "b"] } });
    expect(
      validateArgs(schema("select_option"), { tabId: 1, values: [] }),
    ).toEqual({ ok: false, error: "values: needs at least 1 item" });
    expect(
      validateArgs(schema("select_option"), { tabId: 1, values: "a" }),
    ).toEqual({ ok: false, error: "values: expected array, got string" });
    expect(
      validateArgs(schema("select_option"), { tabId: 1, values: ["a", 2] }),
    ).toEqual({ ok: false, error: "values[1]: expected string, got number" });
    expect(
      validateArgs(schema("upload_file"), {
        tabId: 1,
        selector: "input",
        paths: ["relative.txt"],
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/paths\[0\]: .* has the wrong form/),
    });
    expect(
      validateArgs(schema("upload_file"), {
        tabId: 1,
        selector: "input",
        paths: Array.from({ length: 21 }, (_, i) => `/f${i}`),
      }),
    ).toEqual({ ok: false, error: "paths: takes at most 20 items" });
    expect(
      validateArgs(schema("click"), { tabId: 1, ref: "x12" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^ref: .* has the wrong form/),
    });
    expect(
      validateArgs(schema("click"), {
        tabId: 1,
        ref: "e12",
        modifiers: ["Shift", "Hyper"],
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/modifiers\[1\]: must be one of/),
    });
    expect(validateArgs(schema("click"), { tabId: 1, ref: "e12" })).toEqual({
      ok: true,
      value: { tabId: 1, ref: "e12", button: "left", clickCount: 1 },
    });
    expect(
      validateArgs(schema("wait_for"), {
        tabId: 1,
        text: "x",
        timeout: 31_000,
      }),
    ).toEqual({ ok: false, error: "timeout: must be at most 30000" });
  });

  it("gives slow tools a longer deadline", async () => {
    const { toolTimeoutMs } = await import("./spec");
    expect(toolTimeoutMs("list_tabs")).toBe(15_000);
    expect(toolTimeoutMs("wait_for")).toBe(35_000);
    expect(toolTimeoutMs("nope")).toBe(15_000);
  });
});
