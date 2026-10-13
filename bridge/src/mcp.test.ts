import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { encodeLine, LineReader } from "../../src/bridge/framing";
import { callHost, unreachableMessage } from "./mcp";
import { MANIFEST_DIRS_ENV, SOCKET_ENV, socketPath } from "./paths";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "fb-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("mcp side of the bridge", () => {
  it('says "off" when the host is installed and "not installed" when it is not', () => {
    const env = { [MANIFEST_DIRS_ENV]: "/a:/b" };
    expect(
      unreachableMessage(env, (p) => p === "/b/com.splitsession.bridge.json"),
    ).toMatch(/is off — turn it on in SplitSession Settings/);
    expect(unreachableMessage(env, () => false)).toMatch(
      /not installed — run `pnpm bridge:install`/,
    );
  });

  it("honours the socket override", () => {
    expect(socketPath({ [SOCKET_ENV]: "/x/y.sock" })).toBe("/x/y.sock");
    expect(socketPath({}, "/Users/me")).toMatch(
      /SplitSession[\\/]bridge\.sock$/,
    );
  });

  it("talks to a socket server with one line per request and response", async () => {
    const sock = path.join(tmp(), "s.sock");
    const server = net.createServer((c) => {
      const lines = new LineReader();
      c.setEncoding("utf8");
      c.on("data", (d: string) => {
        for (const m of lines.push(d) as Array<{
          id: number;
          tool: string;
          args: unknown;
        }>) {
          c.write(
            encodeLine({
              id: m.id,
              ok: true,
              result: {
                content: [
                  { type: "text", text: `${m.tool}:${JSON.stringify(m.args)}` },
                ],
              },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const response = await callHost("list_tabs", { windowId: 3 }, 2000, sock);
      expect(response).toEqual({
        id: 1,
        ok: true,
        result: {
          content: [{ type: "text", text: 'list_tabs:{"windowId":3}' }],
        },
      });
    } finally {
      server.close();
    }
  });

  it("rejects as unreachable when nothing listens, and when the server hangs up or stays silent", async () => {
    const dir = tmp();
    await expect(
      callHost("x", {}, 500, path.join(dir, "none.sock")),
    ).rejects.toThrow("ENOENT");

    const hangup = path.join(dir, "h.sock");
    const s1 = net.createServer((c) => c.end());
    await new Promise<void>((r) => s1.listen(hangup, r));
    await expect(callHost("x", {}, 500, hangup)).rejects.toThrow(
      /closed the connection/,
    );
    s1.close();

    const silent = path.join(dir, "q.sock");
    const s2 = net.createServer(() => {});
    await new Promise<void>((r) => s2.listen(silent, r));
    await expect(callHost("x", {}, 150, silent)).rejects.toThrow(
      /did not answer x within 0 seconds|did not answer x/,
    );
    s2.close();
  });
});
