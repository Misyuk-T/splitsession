import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  encodeFrame,
  encodeLine,
  FrameError,
  FrameReader,
  LineReader,
} from "../../src/bridge/framing";
import {
  BUSY_REASON,
  EXTENSION_ORIGIN,
  MULTI_PROFILE_PROTOCOL,
  PROFILE_KEY_RE,
  PROTOCOL_VERSION,
  SAME_PROFILE_REASON,
} from "../../src/bridge/protocol";
import {
  bridgesDir,
  profileSocketPath,
  SOCKET_PATH_MAX,
  SOCKET_SUFFIX,
  socketPath,
} from "./paths";
import { probeSocket } from "./probe";
import { LEGACY_KEY } from "./profiles";
import { Relay } from "./relay";

/**
 * `host` mode: launched by Chrome (`runtime.connectNative('com.splitsession.bridge')`), one per Chrome profile whose bridge is
 * on. stdin/stdout speak Chrome's native messaging framing; a Unix socket (0600, in a 0700 directory) takes the MCP servers:
 * `bridges/<profileKey>.sock` for an extension that says `hello` (protocol 2), the shared `bridge.sock` for one that does not. Chrome closes stdin when the
 * extension drops the port (the bridge is switched off, or Chrome quits): the host then removes the socket and exits.
 * Nothing but frames may ever be written to stdout.
 */
export async function runHost(args: string[]): Promise<void> {
  // Anything that would print to stdout would corrupt the framing.
  console.log =
    console.info =
    console.debug =
      (...parts: unknown[]) => process.stderr.write(`${parts.join(" ")}\n`);

  // Chrome passes the caller's origin as an argument. The installer's launcher lists the origins its manifest allows
  // (`--allow-origin=...`: the Full extension, plus an ID given to `install --extension-id`).
  const allowed = new Set([
    EXTENSION_ORIGIN,
    ...args
      .filter((a) => a.startsWith("--allow-origin=chrome-extension://"))
      .map((a) => a.slice("--allow-origin=".length)),
  ]);
  const origin = args.find((a) => a.startsWith("chrome-extension://"));
  if (origin && !allowed.has(origin)) {
    process.stderr.write(`refusing to run for ${origin}\n`);
    process.exit(2);
  }

  const send = (message: unknown) => process.stdout.write(encodeFrame(message));
  const legacyPath = socketPath();
  const dir = path.dirname(legacyPath);
  // A small log next to the socket (starts, stops, errors; never request or page content) for "why is it not connecting".
  const logFile = path.join(dir, "host.log");
  const note = (line: string) => {
    try {
      appendFileSync(
        logFile,
        `${new Date().toISOString()} [${process.pid}] ${line}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* the log is a courtesy */
    }
  };
  process.umask(0o077);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(logFile) && statSync(logFile).size > 200_000)
      truncateSync(logFile, 0);
    note(`start args=${args.join(" ")}`);
    // Only tighten a directory this program owns (the default `.../SplitSession`); a test-chosen path may be a shared tmp dir.
    if (!process.env.FACET_BRIDGE_SOCKET) chmodSync(dir, 0o700);
  } catch (error) {
    return fatal(send, note, `cannot create ${dir}: ${errorText(error)}`);
  }

  // Frames from Chrome. Until the first one is judged (`hello` or not) they go to `first`; then to the relay.
  let deliver: ((message: unknown) => void) | null = null;
  let first: ((message: unknown) => void) | null = null;
  let stopped: (() => void) | null = null;
  /** A malformed frame: before the host runs it just leaves; once running, `stop` answers the waiting clients first. */
  let malformed: (code: number, reason: string) => void = (code) =>
    process.exit(code);
  const reader = new FrameReader();
  let stdinGone = false;
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of reader.push(chunk)) {
        if (deliver) deliver(message);
        else first?.(message);
      }
    } catch (error) {
      note(`bad frame from Chrome: ${errorText(error)}`);
      malformed(
        1,
        "the SplitSession bridge host received a malformed message from Chrome",
      );
    }
  });
  const gone = () => {
    stdinGone = true;
    stopped?.();
  };
  process.stdin.on("end", gone);
  process.stdin.on("close", gone);

  // Protocol 2: the extension opens with `hello` (its profile key) and this host serves that profile alone, on a socket of
  // its own. No hello (an extension of 0.1.x says nothing first): the one shared socket, as before.
  const hello = await new Promise<HelloResult>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "none" }), HELLO_WAIT_MS);
    first = (message) => {
      clearTimeout(timer);
      first = null;
      resolve(readHello(message));
    };
    stopped = () => {
      clearTimeout(timer);
      resolve({ kind: "gone" });
    };
  });
  stopped = null;
  if (hello.kind === "gone" || stdinGone) {
    note("Chrome closed the connection before the host started");
    process.exit(0);
  }
  if (hello.kind === "bad")
    return fatal(send, note, `the extension sent a bad hello: ${hello.why}`);

  const profileKey = hello.kind === "hello" ? hello.profileKey : null;
  let sockPath = legacyPath;
  if (profileKey !== null) {
    const profilesDir = bridgesDir();
    sockPath = profileSocketPath(profileKey);
    if (Buffer.byteLength(sockPath) > SOCKET_PATH_MAX)
      return fatal(
        send,
        note,
        `the socket path ${sockPath} is longer than the ${SOCKET_PATH_MAX} bytes Unix sockets allow`,
      );
    try {
      mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
      chmodSync(profilesDir, 0o700);
    } catch (error) {
      return fatal(
        send,
        note,
        `cannot create ${profilesDir}: ${errorText(error)}`,
      );
    }
  }
  const busyReason = profileKey !== null ? SAME_PROFILE_REASON : BUSY_REASON;

  const relay = new Relay({ sendToExtension: (m) => send(m) });
  const server = net.createServer((socket) => {
    const lines = new LineReader();
    const id = relay.addClient((response) => {
      if (!socket.destroyed) socket.write(encodeLine(response));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      try {
        for (const message of lines.push(chunk))
          relay.handleClient(id, message);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
    });
    socket.on("close", () => relay.removeClient(id));
    socket.on("error", () => relay.removeClient(id));
  });

  // A live host is never taken over. Protocol 1: another Chrome profile that switched the bridge on first keeps the one
  // shared socket (its popup says "connected" and that stays true). Protocol 2: a host for this same profile key (a quick
  // off and on whose old host has not left yet, or a copied profile directory). This host tells its extension and leaves.
  const found = await probeSocket(sockPath);
  if (found === "live") return busy(send, note, busyReason, profileKey);
  if (found === "unknown")
    return fatal(send, note, `cannot tell whether ${sockPath} is in use`);
  // A socket file left by a host that was killed (it accepts nothing): safe to remove and take over.
  if (found === "stale" && existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch (error) {
      return fatal(
        send,
        note,
        `cannot remove the old socket ${sockPath}: ${errorText(error)}`,
      );
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
    chmodSync(sockPath, 0o600);
  } catch (error) {
    // Two hosts starting at the same moment: the one that lost the race to bind is the busy one.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      return busy(send, note, busyReason, profileKey);
    return fatal(
      send,
      note,
      `cannot listen on ${sockPath}: ${errorText(error)}`,
    );
  }
  const ino = statSync(sockPath).ino;

  let stopping = false;
  let counter: ReturnType<typeof setInterval> | null = null;
  const stop = (code: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    if (counter) clearInterval(counter);
    note(`stop code=${code}: ${reason}`);
    relay.extensionGone(reason);
    server.close();
    try {
      if (existsSync(sockPath) && statSync(sockPath).ino === ino)
        unlinkSync(sockPath); // never remove a successor's socket
    } catch {
      /* already gone */
    }
    // Give pending socket writes a moment, then leave.
    setTimeout(() => process.exit(code), 50);
  };

  deliver = (message) => relay.handleExtension(message);
  malformed = stop;
  if (stdinGone) return stop(0, "SplitSession agent bridge was switched off");
  stopped = () => stop(0, "SplitSession agent bridge was switched off");
  process.stdout.on("error", () =>
    stop(0, "SplitSession agent bridge was switched off"),
  );
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () =>
      stop(0, "SplitSession agent bridge host was stopped"),
    );

  if (profileKey !== null) {
    send({
      type: "ready",
      version: PROTOCOL_VERSION,
      socket: sockPath,
      profileKey,
    });
    note(`ready on ${sockPath}`);
    // How many profiles have the bridge on: the extension suggests a profile name once there are several.
    let last = -1;
    const count = () => {
      const n = countProfileSockets(bridgesDir(), legacyPath);
      if (n === last) return;
      last = n;
      try {
        send({ type: "profiles", count: n });
      } catch {
        /* the extension is gone: stdin closes next */
      }
    };
    count();
    counter = setInterval(count, PROFILE_COUNT_MS);
    counter.unref();
  } else {
    // An extension of 0.1.x: it reads `version` only to log it.
    send({ type: "ready", version: 1, socket: sockPath });
    note(`ready on ${sockPath} (protocol 1: the extension sent no hello)`);
  }
}

/** How long a host waits for the extension's `hello` before it takes the extension for a 0.1.x one (protocol 1). */
export const HELLO_WAIT_MS = 1_500;
/** How often a host counts the profiles that have the bridge on. */
const PROFILE_COUNT_MS = 3_000;

type HelloResult =
  | { kind: "hello"; profileKey: string }
  | { kind: "none" }
  | { kind: "bad"; why: string }
  | { kind: "gone" };

/** The extension's first frame: a `hello` with a well-formed profile key, or anything else (then: protocol 1). */
export function readHello(message: unknown): HelloResult {
  const m = message as {
    type?: unknown;
    version?: unknown;
    profileKey?: unknown;
  } | null;
  if (!m || typeof m !== "object" || m.type !== "hello")
    return { kind: "none" };
  if (typeof m.version !== "number" || m.version < MULTI_PROFILE_PROTOCOL)
    return { kind: "none" };
  if (
    typeof m.profileKey !== "string" ||
    !PROFILE_KEY_RE.test(m.profileKey) ||
    m.profileKey === LEGACY_KEY
  )
    return {
      kind: "bad",
      why: "the profile key is not 6-16 letters a-z or digits",
    };
  return { kind: "hello", profileKey: m.profileKey };
}

/** Socket files in the per-profile directory (well-formed keys only), plus the legacy socket when it exists. */
export function countProfileSockets(dir: string, legacy: string): number {
  let n = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(SOCKET_SUFFIX)) continue;
      const key = name.slice(0, -SOCKET_SUFFIX.length);
      if (!PROFILE_KEY_RE.test(key) || key === LEGACY_KEY) continue;
      try {
        if (statSync(path.join(dir, name)).isSocket()) n += 1;
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* no directory yet */
  }
  try {
    if (statSync(legacy).isSocket()) n += 1;
  } catch {
    /* none */
  }
  return n;
}

function busy(
  send: (m: unknown) => void,
  note: (line: string) => void,
  reason: string,
  profileKey: string | null,
): void {
  note(`busy: ${reason}`);
  try {
    send(
      profileKey !== null
        ? { type: "busy", reason, code: "same-profile" }
        : { type: "busy", reason },
    );
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
  }
  // Nothing was created, so there is nothing to remove: the live host's socket stays untouched.
  setTimeout(() => process.exit(0), 100);
}

function fatal(
  send: (m: unknown) => void,
  note: (line: string) => void,
  message: string,
): void {
  process.stderr.write(`${message}\n`);
  note(`fatal: ${message}`);
  try {
    send({ type: "fatal", message });
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
  }
  setTimeout(() => process.exit(1), 100);
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
