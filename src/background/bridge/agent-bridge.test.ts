import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../../engine/storage/storage-area';
import { createLogger } from '../log';
import { AgentBridge, BRIDGE_ALARM, BRIDGE_STATE_KEY } from './agent-bridge';

class FakePort {
  sent: any[] = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (l: (m: unknown) => void) => void this.messageListeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => void this.disconnectListeners.push(l) };
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
  // test side
  receive(m: unknown) {
    for (const l of this.messageListeners) l(m);
  }
  die() {
    for (const l of this.disconnectListeners) l();
  }
}

function setup() {
  const ports: FakePort[] = [];
  const state = { lastError: undefined as { message: string } | undefined };
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true) };
  const b = {
    runtime: {
      connectNative: vi.fn(() => {
        const p = new FakePort();
        ports.push(p);
        return p;
      }),
      get lastError() {
        return state.lastError;
      },
    },
    alarms,
  };
  const area = new MemoryStorageArea();
  const log = createLogger(50);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bridge = new AgentBridge(b as never, area, log);
  const run = vi.fn(async (tool: string, _args: unknown, meta: { tabId?: number; host?: string; signal?: AbortSignal }) => {
    meta.tabId = 5;
    meta.host = 'a.test';
    if (tool === 'boom') throw new Error('tool failed');
    return { content: [{ type: 'text' as const, text: 'ok' }] };
  });
  bridge.setRunner({ run });
  return { bridge, b, ports, state, alarms, area, log, run };
}

describe('AgentBridge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays off, and connects to nothing, until switched on', async () => {
    const { bridge, b } = setup();
    await bridge.sync(false);
    expect(b.runtime.connectNative).not.toHaveBeenCalled();
    expect(bridge.state().status).toBe('off');
  });

  it('connects to com.facet.bridge and is connected when the host says ready', async () => {
    const { bridge, b, ports, alarms } = setup();
    await bridge.sync(true, true);
    expect(b.runtime.connectNative).toHaveBeenCalledWith('com.facet.bridge');
    expect(bridge.state().status).toBe('connecting');
    expect(alarms.create).toHaveBeenCalledWith(BRIDGE_ALARM, { periodInMinutes: 1 });
    ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    expect(bridge.state().status).toBe('connected');
  });

  it('answers requests through the router, counts and logs them without page content', async () => {
    const { bridge, ports, run, log } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: 'ready', version: 1, socket: '/s' });
    port.receive({ type: 'request', id: 7, tool: 'get_tab_text', args: { tabId: 5 } });
    port.receive({ type: 'request', id: 8, tool: 'boom', args: { text: 'secret' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(port.sent).toEqual([
      { type: 'response', id: 7, ok: true, result: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'response', id: 8, ok: false, error: 'tool failed' },
    ]);
    expect(bridge.state()).toMatchObject({ actions: 2, lastTool: 'boom' });
    const entries = log.entries().filter((e) => e.message === 'agent action');
    expect(entries.map((e) => e.data)).toEqual([
      { tool: 'get_tab_text', tabId: 5, host: 'a.test', ok: true, ms: expect.any(Number) },
      { tool: 'boom', tabId: 5, host: 'a.test', ok: false, ms: expect.any(Number), error: 'tool failed' },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('turning it off disconnects the port and clears the retry alarm; the counter restarts on the next "on"', async () => {
    const { bridge, ports, alarms } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    ports[0]!.receive({ type: 'request', id: 1, tool: 'list_tabs', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.state().actions).toBe(1);
    await bridge.sync(false);
    expect(ports[0]!.disconnected).toBe(true);
    expect(alarms.clear).toHaveBeenCalledWith(BRIDGE_ALARM);
    expect(bridge.state()).toMatchObject({ status: 'off', actions: 1 });
    await bridge.sync(true, true);
    expect(bridge.state().actions).toBe(0);
  });

  it('a late answer after switching off is dropped, not sent to a new connection', async () => {
    const { bridge, ports, run } = setup();
    let release!: () => void;
    run.mockImplementationOnce(() => new Promise((r) => (release = () => r({ content: [] }))));
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    ports[0]!.receive({ type: 'request', id: 1, tool: 'list_tabs', args: {} });
    await bridge.sync(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0]!.sent).toEqual([]);
  });

  it('hands every tool a signal that is aborted when the switch goes off, and runs nothing once it is off', async () => {
    const { bridge, ports, run } = setup();
    let signal: AbortSignal | undefined;
    run.mockImplementationOnce(async (_t, _a, meta: { signal?: AbortSignal }) => {
      signal = meta.signal;
      return new Promise(() => {});
    });
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    ports[0]!.receive({ type: 'request', id: 1, tool: 'click', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await bridge.sync(false);
    expect(signal?.aborted).toBe(true);
    // A request that arrives from the old port after "off" does not reach the router at all.
    run.mockClear();
    ports[0]!.receive({ type: 'request', id: 2, tool: 'click', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    // Switching on again gives the next connection a fresh, live signal.
    await bridge.sync(true, true);
    ports[1]!.receive({ type: 'ready', version: 1, socket: '/s' });
    run.mockImplementationOnce(async (_t, _a, meta: { signal?: AbortSignal }) => {
      signal = meta.signal;
      return { content: [] };
    });
    ports[1]!.receive({ type: 'request', id: 3, tool: 'click', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
  });

  it('aborts running tools when the connection drops, not only when the switch goes off', async () => {
    const { bridge, ports, run, state } = setup();
    let signal: AbortSignal | undefined;
    run.mockImplementationOnce(async (_t, _a, meta: { signal?: AbortSignal }) => {
      signal = meta.signal;
      return new Promise(() => {});
    });
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    ports[0]!.receive({ type: 'request', id: 1, tool: 'click', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    state.lastError = { message: 'Native host has exited.' };
    ports[0]!.die();
    expect(signal?.aborted).toBe(true);
  });

  it('says "busy" when another Chrome profile holds the bridge, stays busy while it looks again, and connects when the other lets go', async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'busy', reason: 'another Chrome profile is connected' });
    expect(bridge.state()).toMatchObject({ status: 'busy', error: 'another Chrome profile is connected' });
    state.lastError = { message: 'Native host has exited.' };
    ports[0]!.die();
    expect(bridge.state().status).toBe('busy'); // not "error": nothing is broken
    await vi.advanceTimersByTimeAsync(9_999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(bridge.state().status).toBe('busy'); // no flicker to "connecting" between looks
    ports[1]!.receive({ type: 'busy', reason: 'another Chrome profile is connected' });
    ports[1]!.die();
    await vi.advanceTimersByTimeAsync(10_001); // still busy: it keeps looking at the same pace (no back-off growth)
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
    ports[2]!.receive({ type: 'ready', version: 1, socket: '/s' });
    expect(bridge.state()).toMatchObject({ status: 'connected', error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
  });

  it('switching off while busy stops the looking', async () => {
    const { bridge, b, ports } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'busy', reason: 'x' });
    ports[0]!.die();
    await bridge.sync(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    expect(bridge.state().status).toBe('off');
  });

  it('reports a missing host and does not hammer Chrome; "check again" tries once more', async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    state.lastError = { message: 'Specified native messaging host not found.' };
    ports[0]!.die();
    expect(bridge.state()).toMatchObject({ status: 'host-missing', error: 'Specified native messaging host not found.' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1); // only the alarm / the button retry
    bridge.handleAlarm(BRIDGE_ALARM);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    state.lastError = undefined;
    ports[1]!.receive({ type: 'ready', version: 1, socket: '/s' });
    expect(bridge.state().status).toBe('connected');
  });

  it('reconnects with a growing back-off when the host exits, and resets it after a successful connection', async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    state.lastError = { message: 'Native host has exited.' };
    ports[0]!.die();
    expect(bridge.state()).toMatchObject({ status: 'error', error: 'Native host has exited.' });
    await vi.advanceTimersByTimeAsync(999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2); // 1 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    ports[1]!.die();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2); // 2 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
    ports[2]!.receive({ type: 'ready', version: 1, socket: '/s' });
    ports[2]!.die();
    await vi.advanceTimersByTimeAsync(1_001); // back to 1 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(4);
  });

  it('shows the host\'s own explanation when it says why it is exiting', async () => {
    const { bridge, ports, state } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: 'fatal', message: 'cannot listen on /s: EACCES' });
    state.lastError = { message: 'Native host has exited.' };
    ports[0]!.die();
    expect(bridge.state().error).toBe('cannot listen on /s: EACCES');
  });

  it('gives up on a host that starts but never says ready', async () => {
    const { bridge, ports } = setup();
    await bridge.sync(true, true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(ports[0]!.disconnected).toBe(true);
    expect(bridge.state()).toMatchObject({ status: 'error', error: 'the host started but did not answer' });
  });

  it('keeps the counter across a worker restart and publishes its state for the UI', async () => {
    const first = setup();
    await first.bridge.sync(true, true);
    first.ports[0]!.receive({ type: 'ready', version: 1, socket: '/s' });
    first.ports[0]!.receive({ type: 'request', id: 1, tool: 'list_tabs', args: {} });
    await vi.advanceTimersByTimeAsync(0);
    const stored = first.area.data.get(BRIDGE_STATE_KEY) as { actions: number; status: string };
    expect(stored).toMatchObject({ actions: 1, status: 'connected' });

    const area = new MemoryStorageArea();
    await area.set({ [BRIDGE_STATE_KEY]: stored });
    const again = new AgentBridge({ runtime: { connectNative: vi.fn(() => new FakePort()) }, alarms: { create: vi.fn(), clear: vi.fn() } } as never, area, createLogger(5));
    await again.sync(true, false);
    expect(again.state()).toMatchObject({ status: 'connecting', actions: 1 });
  });
});
