import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { BUSY_REASON, EXTENSION_ORIGIN, PROTOCOL_VERSION } from '../../src/bridge/protocol';
import { encodeFrame, encodeLine, FrameError, FrameReader, LineReader } from '../../src/bridge/framing';
import { socketPath } from './paths';
import { probeSocket } from './probe';
import { Relay } from './relay';

/**
 * `host` mode: launched by Chrome (`runtime.connectNative('com.facet.bridge')`). stdin/stdout speak Chrome's native
 * messaging framing; a Unix socket (0600, in a 0700 directory) takes the MCP servers. Chrome closes stdin when the
 * extension drops the port (the bridge is switched off, or Chrome quits): the host then removes the socket and exits.
 * Nothing but frames may ever be written to stdout.
 */
export async function runHost(args: string[]): Promise<void> {
  // Anything that would print to stdout would corrupt the framing.
  console.log = console.info = console.debug = (...parts: unknown[]) => process.stderr.write(`${parts.join(' ')}\n`);

  const origin = args.find((a) => a.startsWith('chrome-extension://'));
  if (origin && origin !== EXTENSION_ORIGIN) {
    process.stderr.write(`refusing to run for ${origin}\n`);
    process.exit(2);
  }

  const send = (message: unknown) => process.stdout.write(encodeFrame(message));
  const sockPath = socketPath();
  const dir = path.dirname(sockPath);
  // A small log next to the socket (starts, stops, errors; never request or page content) for "why is it not connecting".
  const logFile = path.join(dir, 'host.log');
  const note = (line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 });
    } catch {
      /* the log is a courtesy */
    }
  };
  process.umask(0o077);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(logFile) && statSync(logFile).size > 200_000) truncateSync(logFile, 0);
    note(`start args=${args.join(' ')}`);
    // Only tighten a directory this program owns (the default `.../Facet`); a test-chosen path may be a shared tmp dir.
    if (!process.env.FACET_BRIDGE_SOCKET) chmodSync(dir, 0o700);
  } catch (error) {
    return fatal(send, note, `cannot create ${dir}: ${errorText(error)}`);
  }

  const relay = new Relay({ sendToExtension: (m) => send(m) });
  const server = net.createServer((socket) => {
    const lines = new LineReader();
    const id = relay.addClient((response) => {
      if (!socket.destroyed) socket.write(encodeLine(response));
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      try {
        for (const message of lines.push(chunk)) relay.handleClient(id, message);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
    });
    socket.on('close', () => relay.removeClient(id));
    socket.on('error', () => relay.removeClient(id));
  });

  // One host at a time, and a live one is never taken over: another Chrome profile that switched the bridge on first
  // keeps it (its popup says "connected" and that stays true). This host tells its extension and leaves.
  const found = await probeSocket(sockPath);
  if (found === 'live') return busy(send, note);
  if (found === 'unknown') return fatal(send, note, `cannot tell whether ${sockPath} is in use`);
  // A socket file left by a host that was killed (it accepts nothing): safe to remove and take over.
  if (found === 'stale' && existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch (error) {
      return fatal(send, note, `cannot remove the old socket ${sockPath}: ${errorText(error)}`);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => resolve());
    });
    chmodSync(sockPath, 0o600);
  } catch (error) {
    // Two hosts starting at the same moment: the one that lost the race to bind is the busy one.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return busy(send, note);
    return fatal(send, note, `cannot listen on ${sockPath}: ${errorText(error)}`);
  }
  const ino = statSync(sockPath).ino;

  let stopping = false;
  const stop = (code: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    note(`stop code=${code}: ${reason}`);
    relay.extensionGone(reason);
    server.close();
    try {
      if (existsSync(sockPath) && statSync(sockPath).ino === ino) unlinkSync(sockPath); // never remove a successor's socket
    } catch {
      /* already gone */
    }
    // Give pending socket writes a moment, then leave.
    setTimeout(() => process.exit(code), 50);
  };

  const reader = new FrameReader();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const message of reader.push(chunk)) relay.handleExtension(message);
    } catch (error) {
      note(`bad frame from Chrome: ${errorText(error)}`);
      stop(1, 'the Facet bridge host received a malformed message from Chrome');
    }
  });
  process.stdin.on('end', () => stop(0, 'Facet agent bridge was switched off'));
  process.stdin.on('close', () => stop(0, 'Facet agent bridge was switched off'));
  process.stdout.on('error', () => stop(0, 'Facet agent bridge was switched off'));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => stop(0, 'Facet agent bridge host was stopped'));

  send({ type: 'ready', version: PROTOCOL_VERSION, socket: sockPath });
  note(`ready on ${sockPath}`);
}

function busy(send: (m: unknown) => void, note: (line: string) => void): void {
  note(`busy: ${BUSY_REASON}`);
  try {
    send({ type: 'busy', reason: BUSY_REASON });
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
  }
  // Nothing was created, so there is nothing to remove: the live host's socket stays untouched.
  setTimeout(() => process.exit(0), 100);
}

function fatal(send: (m: unknown) => void, note: (line: string) => void, message: string): void {
  process.stderr.write(`${message}\n`);
  note(`fatal: ${message}`);
  try {
    send({ type: 'fatal', message });
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
  }
  setTimeout(() => process.exit(1), 100);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
