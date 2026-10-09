import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSocket } from './probe';

// Unix socket paths are short (104 bytes on macOS): a short directory directly under /tmp.
const dirs: string[] = [];
const servers: net.Server[] = [];
const tmp = () => {
  const d = mkdtempSync('/tmp/fb-');
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const listen = (sock: string) =>
  new Promise<net.Server>((resolve) => {
    const server = net.createServer((c) => c.on('error', () => {}));
    servers.push(server);
    server.listen(sock, () => resolve(server));
  });

describe('probeSocket', () => {
  it('a socket that accepts a connection is a live host', async () => {
    const sock = path.join(tmp(), 'bridge.sock');
    await listen(sock);
    expect(await probeSocket(sock)).toBe('live');
  });

  it('nothing there is absent', async () => {
    expect(await probeSocket(path.join(tmp(), 'bridge.sock'))).toBe('absent');
  });

  it('a socket file nobody listens on (a killed host) is stale; so is a plain file in its place', async () => {
    const dir = tmp();
    const sock = path.join(dir, 'bridge.sock');
    // A process killed with SIGKILL cannot clean up: its socket file stays behind and accepts nothing.
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(await probeSocket(sock)).toBe('stale');
    const file = path.join(dir, 'plain');
    writeFileSync(file, 'x');
    expect(await probeSocket(file)).toBe('stale');
  });
});
