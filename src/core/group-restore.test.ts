import { describe, expect, it } from "vitest";

import {
  groupRestorePlan,
  type GroupSnapshot,
  planGroupRestore,
} from "./group-restore";
import { groupTitle } from "./restore";

const group = (
  id: number,
  title: string | undefined,
  color = "blue",
  windowId = 1,
): GroupSnapshot => ({ id, windowId, title, color });

describe("planGroupRestore: leftover SplitSession groups -> containers", () => {
  it("reads name and container colour from the group, and keeps the container ID the marker names", () => {
    const plan = planGroupRestore([
      group(10, groupTitle("main", "a1b2c3d4e5"), "blue"),
      group(11, groupTitle("secondline", "zz99yy88xx"), "cyan"),
      group(12, groupTitle("Work", "q1w2e3r4t5"), "pink"),
    ]);
    expect(plan).toEqual([
      { id: "a1b2c3d4e5", name: "main", color: "blue", groupIds: [10] },
      {
        id: "zz99yy88xx",
        name: "secondline",
        color: "turquoise", // Chrome's cyan
        groupIds: [11],
      },
      { id: "q1w2e3r4t5", name: "Work", color: "pink", groupIds: [12] },
    ]);
  });

  it("takes groups without SplitSession's marker for the user's own: never offered", () => {
    expect(
      planGroupRestore([
        group(1, "Shopping"),
        group(2, "⧉ fake"), // the visible glyph is not evidence
        group(3, undefined),
        group(4, ""),
        group(5, groupTitle("forged", "abc123").slice(0, -1)), // marker cut short
        group(6, groupTitle("real", "abc123"), "green"),
      ]),
    ).toEqual([{ id: "abc123", name: "real", color: "green", groupIds: [6] }]);
  });

  it("is one container for the groups of one container in several windows", () => {
    const plan = planGroupRestore([
      group(20, groupTitle("main", "abc123"), "red", 2),
      group(10, groupTitle("main", "abc123"), "red", 1),
    ]);
    expect(plan).toEqual([
      { id: "abc123", name: "main", color: "red", groupIds: [10, 20] },
    ]);
  });

  it("recognises titles of earlier versions (name and marker, no glyph)", () => {
    const old = groupTitle("legacy", "abc123").replace(/^⧉ /, "");
    expect(planGroupRestore([group(1, old, "orange")])[0]).toMatchObject({
      name: "legacy",
      color: "orange",
    });
  });

  it("gives an empty or too long name a usable one, and a clashing name a number", () => {
    const plan = planGroupRestore([
      group(1, groupTitle("", "aaa111"), "blue"),
      group(2, groupTitle("x".repeat(50), "bbb222"), "red"),
      group(3, groupTitle("Main", "ccc333"), "green"),
      group(4, groupTitle("main", "ddd444"), "yellow"),
    ]);
    expect(plan.map((c) => c.name)).toEqual([
      "Container",
      "x".repeat(32),
      "Main",
      "main 2",
    ]);
  });

  it("gives a grey group (no container has grey) the first colour not used by the others", () => {
    const plan = planGroupRestore([
      group(1, groupTitle("a", "aaa111"), "grey"),
      group(2, groupTitle("b", "bbb222"), "blue"),
      group(3, groupTitle("c", "ccc333"), "grey"),
    ]);
    expect(plan.map((c) => c.color)).toEqual(["turquoise", "blue", "green"]);
  });

  it("offers nothing when there are no groups", () => {
    expect(planGroupRestore([])).toEqual([]);
  });
});

describe("groupRestorePlan: when the popup offers it", () => {
  const groups = [group(1, groupTitle("main", "abc123"))];

  it("offers when there are no containers and the user has not said no", () => {
    expect(
      groupRestorePlan({ containerCount: 0, dismissed: false, groups }),
    ).toHaveLength(1);
  });

  it("offers nothing next to existing containers", () => {
    expect(
      groupRestorePlan({ containerCount: 1, dismissed: false, groups }),
    ).toEqual([]);
  });

  it("offers nothing once dismissed", () => {
    expect(
      groupRestorePlan({ containerCount: 0, dismissed: true, groups }),
    ).toEqual([]);
  });

  it("offers nothing when only the user's own groups exist", () => {
    expect(
      groupRestorePlan({
        containerCount: 0,
        dismissed: false,
        groups: [group(1, "Reading"), group(2, "⧉ fake")],
      }),
    ).toEqual([]);
  });
});
