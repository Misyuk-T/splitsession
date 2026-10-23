import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bridgesDir, profileSocketPath, SOCKET_PATH_MAX } from "./paths";
import { discoverEndpoints, LEGACY_KEY, removeIfStale } from "./profiles";

// Unix socket paths are short (104 bytes on macOS): a short directory directly under /tmp.
const dirs: string[] = [];
const servers: net.Server[] = [];
const tmp = () => {
  const d = mkdtempSync("/tmp/fb-");
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const listen = (sock: string) =>
  new Promise<net.Server>((resolve) => {
    const server = net.createServer((c) => c.on("error", () => {}));
    servers.push(server);
    server.listen(sock, () => resolve(server));
  });

/** A socket file whose process was killed: it accepts nothing. */
async function leftover(sock: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve) =>
    child.stdout.once("data", () => resolve()),
  );
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
}

describe("per-profile sockets", () => {
  it("live next to the legacy socket unless told otherwise, one file per profile key", () => {
    expect(bridgesDir({ FACET_BRIDGE_SOCKET: "/x/y/bridge.sock" })).toBe(
      "/x/y/bridges",
    );
    expect(
      bridgesDir({
        FACET_BRIDGE_SOCKET: "/x/bridge.sock",
        FACET_BRIDGE_DIR: "/d",
      }),
    ).toBe("/d");
    expect(bridgesDir({}, "/Users/me")).toMatch(
      /Library[\\/]Application Support[\\/]SplitSession[\\/]bridges$|\.config[\\/]SplitSession[\\/]bridges$/,
    );
    expect(profileSocketPath("k1abc23def", { FACET_BRIDGE_DIR: "/d" })).toBe(
      "/d/k1abc23def.sock",
    );
  });

  it("fit a Unix socket path for an ordinary macOS home", () => {
    const p = profileSocketPath(
      "k1abc23def",
      {},
      "/Users/a-rather-long-user-name",
    );
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
  });

  it("discovery lists every well-formed socket in the directory, then the legacy one; nothing else", async () => {
    const root = tmp();
    const dir = path.join(root, "bridges");
    mkdirSync(dir);
    const legacy = path.join(root, "bridge.sock");
    expect(discoverEndpoints(dir, legacy)).toEqual([]);
    await listen(path.join(dir, "bbbbbbbbbb.sock"));
    await listen(path.join(dir, "aaaaaaaaaa.sock"));
    await listen(path.join(dir, "legacy.sock")); // reserved name
    await listen(path.join(dir, "Bad-Key.sock"));
    writeFileSync(path.join(dir, "cccccccccc.sock"), "not a socket");
    writeFileSync(path.join(dir, "host.log"), "");
    await listen(legacy);
    const found = discoverEndpoints(dir, legacy);
    expect(found.map((e) => [e.key, e.legacy])).toEqual([
      ["aaaaaaaaaa", false],
      ["bbbbbbbbbb", false],
      [LEGACY_KEY, true],
    ]);
    expect(found[0]!.socket).toBe(path.join(dir, "aaaaaaaaaa.sock"));
    expect(found[0]!.ino).toBeGreaterThan(0);
  });

  it("a leftover socket is removed once it is old enough; a live or young one never is", async () => {
    const dir = tmp();
    const dead = path.join(dir, "dddddddddd.sock");
    await leftover(dead);
    const live = path.join(dir, "eeeeeeeeee.sock");
    await listen(live);
    const [d, l] = discoverEndpoints(dir, path.join(dir, "none.sock"));
    expect(d!.key).toBe("dddddddddd");
    // Young: a host may be between bind and listen.
    expect(await removeIfStale(d!)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(dead, old, old);
    utimesSync(live, old, old);
    expect(await removeIfStale(l!)).toBe(false);
    expect(await removeIfStale(d!)).toBe(true);
    expect(
      discoverEndpoints(dir, path.join(dir, "none.sock")).map((e) => e.key),
    ).toEqual(["eeeeeeeeee"]);
  });
});
