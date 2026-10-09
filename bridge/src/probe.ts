import net from 'node:net';

/**
 * What lives at the socket address:
 * - `live`: something accepted a connection (a running host, i.e. another Chrome profile's bridge);
 * - `stale`: a leftover that accepts nothing (a killed host's file) and is safe to remove;
 * - `absent`: nothing there;
 * - `unknown`: neither (permissions, a hung probe): not ours to judge.
 */
export type SocketState = 'live' | 'stale' | 'absent' | 'unknown';

export function probeSocket(sock: string, timeoutMs = 1_500): Promise<SocketState> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sock);
    const done = (state: SocketState) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done('unknown'), timeoutMs);
    socket.on('connect', () => done('live'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return done('absent');
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') return done('stale');
      done('unknown');
    });
  });
}
