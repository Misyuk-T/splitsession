import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameError } from '../../src/bridge/framing';
import { PING_TOOL, SESSION_TOOL, type ClientResponse, type HostToExtension } from '../../src/bridge/protocol';
import { Relay } from './relay';

function setup(timeoutMs = 1000) {
  const sent: HostToExtension[] = [];
  const relay = new Relay({ sendToExtension: (m) => sent.push(m), timeoutMs });
  const client = () => {
    const got: ClientResponse[] = [];
    const id = relay.addClient((r) => got.push(r));
    return { id, got };
  };
  return { relay, sent, client };
}
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

describe('relay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('numbers requests globally and routes each answer to its own client with the client\'s own id', () => {
    const { relay, sent, client } = setup();
    const a = client();
    const b = client();
    relay.handleClient(a.id, { id: 1, tool: 'list_tabs', args: {} });
    relay.handleClient(b.id, { id: 1, tool: 'list_containers' });
    expect(sent.map((m) => (m as { id: number }).id)).toEqual([1, 2]); // both clients used id 1
    // answered out of order
    relay.handleExtension({ type: 'response', id: 2, ok: true, result: text('for b') });
    relay.handleExtension({ type: 'response', id: 1, ok: true, result: text('for a') });
    expect(a.got).toEqual([{ id: 1, ok: true, result: text('for a') }]);
    expect(b.got).toEqual([{ id: 1, ok: true, result: text('for b') }]);
    expect(relay.pendingCount).toBe(0);
  });

  it('passes errors through', () => {
    const { relay, client } = setup();
    const a = client();
    relay.handleClient(a.id, { id: 9, tool: 'click', args: { tabId: 1 } });
    relay.handleExtension({ type: 'response', id: 1, ok: false, error: 'no element matches "#x"' });
    expect(a.got).toEqual([{ id: 9, ok: false, error: 'no element matches "#x"' }]);
  });

  it('answers a ping itself, without involving Chrome', () => {
    const { relay, sent, client } = setup();
    const a = client();
    relay.handleClient(a.id, { id: 3, tool: PING_TOOL });
    expect(a.got[0]).toMatchObject({ id: 3, ok: true });
    expect(sent).toEqual([]);
  });

  it('times out a request Chrome never answers, and ignores the late answer', () => {
    const { relay, client } = setup(1000);
    const a = client();
    relay.handleClient(a.id, { id: 1, tool: 'get_tab_text', args: { tabId: 1 } });
    vi.advanceTimersByTime(1001);
    expect(a.got).toHaveLength(1);
    expect(a.got[0]).toMatchObject({ id: 1, ok: false });
    expect((a.got[0] as { error: string }).error).toMatch(/did not answer get_tab_text within 1 seconds/);
    relay.handleExtension({ type: 'response', id: 1, ok: true, result: text('late') });
    expect(a.got).toHaveLength(1);
  });

  it('drops the pending requests of a client that disconnected', () => {
    const { relay, client } = setup();
    const a = client();
    const b = client();
    relay.handleClient(a.id, { id: 1, tool: 'list_tabs' });
    relay.removeClient(a.id);
    expect(relay.pendingCount).toBe(0);
    relay.handleExtension({ type: 'response', id: 1, ok: true, result: text('x') });
    expect(a.got).toEqual([]);
    expect(b.got).toEqual([]);
    expect(relay.clientCount).toBe(1);
  });

  it('answers a request that is too big for Chrome instead of sending it', () => {
    const sent: unknown[] = [];
    const relay = new Relay({
      sendToExtension: () => {
        throw new FrameError('message is 2000000 bytes; the limit is 1048576');
      },
    });
    const got: ClientResponse[] = [];
    const id = relay.addClient((r) => got.push(r));
    relay.handleClient(id, { id: 1, tool: 'run_js', args: {} });
    expect(got[0]).toMatchObject({ id: 1, ok: false });
    expect((got[0] as { error: string }).error).toMatch(/could not send the request to Chrome.*limit is 1048576/);
    expect(relay.pendingCount).toBe(0);
    expect(sent).toEqual([]);
  });

  it('fails everything waiting, and later requests, once the extension is gone', () => {
    const { relay, client } = setup();
    const a = client();
    const b = client();
    relay.handleClient(a.id, { id: 1, tool: 'list_tabs' });
    relay.handleClient(b.id, { id: 5, tool: 'list_tabs' });
    relay.extensionGone('SplitSession agent bridge was switched off');
    expect(a.got).toEqual([{ id: 1, ok: false, error: 'SplitSession agent bridge was switched off' }]);
    expect(b.got).toEqual([{ id: 5, ok: false, error: 'SplitSession agent bridge was switched off' }]);
    relay.handleClient(a.id, { id: 2, tool: 'list_tabs' });
    expect(a.got[1]).toEqual({ id: 2, ok: false, error: 'SplitSession agent bridge was switched off' });
  });

  it('ignores garbage from both sides and answers requests without a tool', () => {
    const { relay, sent, client } = setup();
    const a = client();
    relay.handleClient(a.id, 'nonsense');
    relay.handleClient(a.id, { tool: 'x' });
    relay.handleClient(a.id, { id: 4 });
    relay.handleExtension(null);
    relay.handleExtension({ type: 'ready' });
    relay.handleExtension({ type: 'response', id: 'x' });
    expect(a.got).toEqual([{ id: 4, ok: false, error: 'request has no tool name' }]);
    expect(sent).toEqual([]);
  });

  it('gives each tool its own deadline: a 30 s wait_for is not cut off at 20 s', () => {
    const sent: HostToExtension[] = [];
    const relay = new Relay({ sendToExtension: (m) => sent.push(m) });
    const got: ClientResponse[] = [];
    const id = relay.addClient((r) => got.push(r));
    relay.handleClient(id, { id: 1, tool: 'list_tabs' });
    relay.handleClient(id, { id: 2, tool: 'wait_for', args: { tabId: 1, text: 'x', timeout: 30_000 } });
    vi.advanceTimersByTime(20_001);
    expect(got.map((r) => r.id)).toEqual([1]);
    expect(got[0]).toMatchObject({ ok: false, error: 'Chrome did not answer list_tabs within 20 seconds' });
    vi.advanceTimersByTime(20_000);
    expect(got.map((r) => r.id)).toEqual([1, 2]);
    expect(got[1]).toMatchObject({ ok: false, error: 'Chrome did not answer wait_for within 40 seconds' });
  });

  it('tells the extension how many agents are present: a __session connection counts until it closes', () => {
    const { relay, sent, client } = setup();
    const a = client();
    const b = client();
    const oneShot = client(); // a plain per-call connection never counts
    relay.handleClient(a.id, { id: 1, tool: SESSION_TOOL });
    relay.handleClient(a.id, { id: 2, tool: SESSION_TOOL }); // twice on one connection: still one
    relay.handleClient(b.id, { id: 1, tool: SESSION_TOOL });
    relay.handleClient(oneShot.id, { id: 1, tool: PING_TOOL });
    expect(a.got[0]).toMatchObject({ id: 1, ok: true });
    expect(sent).toEqual([
      { type: 'clients', count: 1 },
      { type: 'clients', count: 2 },
    ]);
    relay.removeClient(oneShot.id);
    relay.removeClient(a.id);
    relay.removeClient(b.id);
    expect(sent.slice(2)).toEqual([
      { type: 'clients', count: 1 },
      { type: 'clients', count: 0 },
    ]);
  });
});
