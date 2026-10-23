import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { PROFILE_KEY_RE } from "../../src/bridge/protocol";
import { bridgesDir, SOCKET_SUFFIX, socketPath } from "./paths";
import { probeSocket } from "./probe";

/** The key of the shared protocol-1 socket (`bridge.sock`): an extension of 0.1.x, or a host of 0.1.x. */
export const LEGACY_KEY = "legacy";

/** One Chrome profile's bridge as the MCP server finds it: a socket file. */
export interface Endpoint {
  /** The profile key (the socket file's name), or `legacy` for the shared protocol-1 socket. */
  key: string;
  socket: string;
  legacy: boolean;
  /** The socket file's inode: a new host (Chrome restarted, the switch went off and on) makes a new one. */
  ino: number;
}

/** A socket that refuses connections is removed only when it is at least this old (a host between bind and listen is younger). */
export const STALE_AGE_MS = 5_000;

const socketIno = (p: string): number | null => {
  try {
    const st = statSync(p);
    return st.isSocket() ? st.ino : null;
  } catch {
    return null;
  }
};

/**
 * Every profile whose bridge may be on: `<bridges>/<key>.sock` (protocol 2, one per profile) and the shared `bridge.sock`
 * (protocol 1). Only a directory listing and a stat per file: cheap enough for every tool call. Whether a host is really
 * there is found out by connecting.
 */
export function discoverEndpoints(
  dir: string = bridgesDir(),
  legacy: string = socketPath(),
): Endpoint[] {
  const found: Endpoint[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no directory: no profile with protocol 2 has been on yet */
  }
  for (const name of names.sort()) {
    if (!name.endsWith(SOCKET_SUFFIX)) continue;
    const key = name.slice(0, -SOCKET_SUFFIX.length);
    if (!PROFILE_KEY_RE.test(key) || key === LEGACY_KEY) continue;
    const socket = path.join(dir, name);
    const ino = socketIno(socket);
    if (ino !== null) found.push({ key, socket, legacy: false, ino });
  }
  const ino = socketIno(legacy);
  if (ino !== null)
    found.push({ key: LEGACY_KEY, socket: legacy, legacy: true, ino });
  return found;
}

/**
 * A socket file whose host is gone (it refuses connections): removed, so it stops showing up as a profile. Only a file
 * older than `STALE_AGE_MS` and still the same file (inode) is touched; a live one never is.
 */
export async function removeIfStale(
  ep: Endpoint,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const st = statSync(ep.socket);
    if (st.ino !== ep.ino || now - st.mtimeMs < STALE_AGE_MS) return false;
  } catch {
    return false;
  }
  if ((await probeSocket(ep.socket, 1_000)) !== "stale") return false;
  try {
    if (statSync(ep.socket).ino !== ep.ino) return false;
    unlinkSync(ep.socket);
    return true;
  } catch {
    return false;
  }
}
