import { describe, expect, it, vi } from 'vitest';
import { SWITCHED_OFF } from '../../bridge/protocol';
import { BridgeRouter, checkUrl, ToolError, withTimeout, type ActionMeta } from './router';

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  title: string;
  url: string;
  status: 'complete' | 'loading';
  groupId: number;
}

function setup(tabs: FakeTab[], containers = [{ id: 'c1', name: 'Work', color: 'blue', tabCount: 1 }]) {
  const assigned = new Map<number, string>([[tabs[0]!.id, 'c1']]);
  const calls: string[] = [];
  const b = {
    tabs: {
      query: vi.fn(async (q: { windowId?: number }) => tabs.filter((t) => q.windowId === undefined || t.windowId === q.windowId)),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id');
        return t;
      }),
      remove: vi.fn(async (id: number) => void calls.push(`remove ${id}`)),
      update: vi.fn(async (id: number, props: object) => void calls.push(`update ${id} ${JSON.stringify(props)}`)),
    },
    scripting: { executeScript: vi.fn(async (..._a: unknown[]) => [{ result: { text: 'hello page', total: 10, url: 'https://a.test/', title: 'T' } }]) },
    windows: { update: vi.fn(async () => ({})), getAll: vi.fn(async () => [{ id: 10 }, { id: 11 }]) },
    runtime: { getManifest: () => ({ version: '1.2.3' }) },
  };
  const facet = {
    ready: Promise.resolve(),
    listContainers: () => containers,
    containers: {
      resolve: (ref: string) => containers.find((c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase()),
      get: (id: string) => containers.find((c) => c.id === id),
    },
    createContainer: vi.fn(),
    getTabContainer: (id: number) => assigned.get(id) ?? null,
    prepareNavigation: vi.fn(async () => {}),
    openInContainer: vi.fn(async () => 99),
  };
  const api = { assignTab: vi.fn(async () => {}) };
  let label = 'Work';
  const router = new BridgeRouter({ b: b as never, facet: facet as never, api: api as never, sleep: async () => {}, profileLabel: async () => label });
  return { router, b, facet, api, calls, setLabel: (l: string) => void (label = l) };
}

const tab = (over: Partial<FakeTab> = {}): FakeTab => ({ id: 1, windowId: 10, index: 0, active: true, pinned: false, title: '[Work] Inbox', url: 'https://mail.test/inbox', status: 'complete', groupId: -1, ...over });
const run = async (router: BridgeRouter, name: string, args: unknown, meta: ActionMeta = {}) => {
  const result = await router.run(name, args, meta);
  return result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`));
};

describe('bridge router', () => {
  it('list_tabs maps every tab with its container and honours the filters', async () => {
    const { router } = setup([tab(), tab({ id: 2, windowId: 11, url: 'https://b.test/', title: 'B' })]);
    const all = JSON.parse((await run(router, 'list_tabs', {}))[0]!);
    expect(all).toEqual([
      { tabId: 1, windowId: 10, index: 0, active: true, pinned: false, title: '[Work] Inbox', url: 'https://mail.test/inbox', status: 'complete', groupId: -1, container: { id: 'c1', name: 'Work' } },
      { tabId: 2, windowId: 11, index: 0, active: true, pinned: false, title: 'B', url: 'https://b.test/', status: 'complete', groupId: -1, container: null },
    ]);
    expect(JSON.parse((await run(router, 'list_tabs', { windowId: 11 }))[0]!)).toHaveLength(1);
    expect(JSON.parse((await run(router, 'list_tabs', { containerId: 'work' }))[0]!).map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    await expect(run(router, 'list_tabs', { containerId: 'none' })).rejects.toThrow('no container "none"');
  });

  it('rejects unknown tools and invalid arguments before touching the browser', async () => {
    const { router, b } = setup([tab()]);
    await expect(run(router, 'format_disk', {})).rejects.toThrow('unknown tool');
    await expect(run(router, 'close_tab', { tabId: 'x' })).rejects.toThrow('close_tab: tabId: expected integer');
    await expect(run(router, 'close_tab', { tabId: 1, extra: 1 })).rejects.toThrow('unknown argument "extra"');
    expect(b.tabs.remove).not.toHaveBeenCalled();
  });

  it('reports the host (never the page) of the tab it acts on', async () => {
    const { router } = setup([tab()]);
    const meta: ActionMeta = {};
    await run(router, 'get_tab_text', { tabId: 1 }, meta);
    expect(meta).toEqual({ tabId: 1, host: 'mail.test' });
  });

  it('get_tab_text returns metadata and the text as two blocks', async () => {
    const { router, b } = setup([tab()]);
    const [meta, body] = await run(router, 'get_tab_text', { tabId: 1, maxChars: 500 });
    expect(JSON.parse(meta!)).toEqual({ tabId: 1, url: 'https://a.test/', title: 'T', length: 10, truncated: false });
    expect(body).toBe('hello page');
    const call = b.scripting.executeScript.mock.calls[0]![0] as { target: unknown; world: string; args: unknown[] };
    expect(call.target).toEqual({ tabId: 1, frameIds: [0] });
    expect(call.world).toBe('ISOLATED');
    expect(call.args).toEqual([500]);
  });

  it('turns a page-side error into a tool error, and "cannot access" into advice', async () => {
    const { router, b } = setup([tab()]);
    b.scripting.executeScript.mockResolvedValueOnce([{ result: { error: 'no element matches "#x"' } }] as never);
    await expect(run(router, 'click', { tabId: 1, selector: '#x' })).rejects.toThrow('no element matches "#x"');
    b.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    await expect(run(router, 'get_tab_text', { tabId: 1 })).rejects.toThrow(/cannot be scripted.*chrome:\/\//);
    b.scripting.executeScript.mockResolvedValueOnce([{}] as never);
    await expect(run(router, 'get_tab_text', { tabId: 1 })).rejects.toThrow(/returned nothing/);
  });

  it('click needs a selector or both coordinates', async () => {
    const { router } = setup([tab()]);
    await expect(run(router, 'click', { tabId: 1 })).rejects.toThrow('selector, or both x and y');
    await expect(run(router, 'click', { tabId: 1, x: 5 })).rejects.toThrow('selector, or both x and y');
    await expect(run(router, 'scroll', { tabId: 1 })).rejects.toThrow('give selector, to, or dx/dy');
  });

  it('a tab that is gone is a clear error', async () => {
    const { router } = setup([tab()]);
    await expect(run(router, 'close_tab', { tabId: 77 })).rejects.toThrow('no tab with id 77');
  });

  it('navigate prepares the service-worker removal for container tabs, only for web addresses', async () => {
    const { router, facet, calls } = setup([tab(), tab({ id: 2, url: 'https://b.test/' })]);
    await run(router, 'navigate', { tabId: 1, url: 'https://x.test/p', wait: false });
    expect(facet.prepareNavigation).toHaveBeenCalledWith('https://x.test/p');
    expect(calls).toContain('update 1 {"url":"https://x.test/p"}');
    facet.prepareNavigation.mockClear();
    await run(router, 'navigate', { tabId: 2, url: 'https://x.test/p', wait: false }); // not in a container
    expect(facet.prepareNavigation).not.toHaveBeenCalled();
    await expect(run(router, 'navigate', { tabId: 1, url: 'javascript:alert(1)' })).rejects.toThrow('not allowed');
    await expect(run(router, 'navigate', { tabId: 1, url: 'file:///etc/passwd' })).rejects.toThrow('not allowed');
  });

  it('assign_tab resolves the container (or null) and reloads by default', async () => {
    const { router, api } = setup([tab(), tab({ id: 2, url: 'https://b.test/' })]);
    await run(router, 'assign_tab', { tabId: 2, container: 'work' });
    expect(api.assignTab).toHaveBeenLastCalledWith(2, 'c1', { reload: true });
    await run(router, 'assign_tab', { tabId: 1, container: null, reload: false });
    expect(api.assignTab).toHaveBeenLastCalledWith(1, null, { reload: false });
    await expect(run(router, 'assign_tab', { tabId: 1, container: 'Ghost' })).rejects.toThrow(/no container "Ghost".*existing: "Work".*createIfMissing/);
  });

  it('open_in_container uses Facet\'s own open path and only http(s)', async () => {
    const { router, facet } = setup([tab({ id: 99, url: 'https://a.test/' })]);
    await run(router, 'open_in_container', { url: 'https://a.test/', container: 'Work', wait: false });
    expect(facet.openInContainer).toHaveBeenCalledWith('https://a.test/', 'c1', { active: false });
    await expect(run(router, 'open_in_container', { url: 'chrome://settings', container: 'Work' })).rejects.toThrow('not allowed');
  });

  it('a tool that hangs fails with a timeout instead of hanging the agent', async () => {
    const { router, b } = setup([tab()]);
    b.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
    await expect(router.run('get_tab_text', { tabId: 1 }, {}, 20)).rejects.toThrow('get_tab_text timed out');
  });
});

describe('bridge router: switched off while a tool runs', () => {
  const abortable = () => {
    const controller = new AbortController();
    return { controller, meta: { signal: controller.signal } as ActionMeta };
  };

  it('does not act when "off" arrives while the tab lookup is still pending', async () => {
    const { router, b, calls } = setup([tab()]);
    const { controller, meta } = abortable();
    let release!: () => void;
    b.tabs.get.mockImplementationOnce(() => new Promise((r) => (release = () => r(tab() as never))) as never);
    const pending = router.run('click', { tabId: 1, selector: '#go' }, meta);
    const settled = expect(pending).rejects.toThrow(SWITCHED_OFF);
    await Promise.resolve();
    controller.abort();
    release(); // the lookup finishes after "off": the click must not follow
    await settled;
    await new Promise((r) => setTimeout(r, 0));
    expect(b.scripting.executeScript).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('refuses a run that starts after "off", without touching the browser', async () => {
    const { router, b } = setup([tab()]);
    const { controller, meta } = abortable();
    controller.abort();
    await expect(router.run('close_tab', { tabId: 1 }, meta)).rejects.toThrow(SWITCHED_OFF);
    expect(b.tabs.get).not.toHaveBeenCalled();
    expect(b.tabs.remove).not.toHaveBeenCalled();
  });

  it('the answer comes at once even when the work is stuck in a page script', async () => {
    const { router, b } = setup([tab()]);
    const { controller, meta } = abortable();
    b.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
    const pending = router.run('run_js', { tabId: 1, code: 'return 1' }, meta);
    const settled = expect(pending).rejects.toThrow(SWITCHED_OFF);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await settled;
  });

  it('a wait for a page load ends on "off" instead of polling to its limit; navigate still did what it was asked before', async () => {
    const { router, b, calls } = setup([tab({ status: 'loading' })]);
    const { controller, meta } = abortable();
    let polls = 0;
    b.tabs.get.mockImplementation(async () => {
      if (++polls === 3) controller.abort();
      return tab({ status: 'loading' }) as never;
    });
    await expect(router.run('navigate', { tabId: 1, url: 'https://x.test/' }, meta)).rejects.toThrow(SWITCHED_OFF);
    expect(calls).toEqual(['update 1 {"url":"https://x.test/"}']);
    expect(polls).toBeLessThan(10);
  });

  it('nothing is navigated, assigned or captured after "off" during the steps in between', async () => {
    const { router, facet, api, b, calls } = setup([tab()]);
    const nav = abortable();
    facet.prepareNavigation.mockImplementationOnce(async () => nav.controller.abort());
    await expect(router.run('navigate', { tabId: 1, url: 'https://x.test/', wait: false }, nav.meta)).rejects.toThrow(SWITCHED_OFF);
    expect(calls).toEqual([]);

    const assign = abortable();
    facet.containers.resolve = ((ref: string) => {
      assign.controller.abort();
      return { id: 'c1', name: ref };
    }) as never;
    await expect(router.run('assign_tab', { tabId: 1, container: 'Work' }, assign.meta)).rejects.toThrow(SWITCHED_OFF);
    expect(api.assignTab).not.toHaveBeenCalled();
    expect(b.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('bridge_info', () => {
  it('names the profile and sizes it', async () => {
    const { router, setLabel } = setup([tab(), tab({ id: 2 })]);
    expect(JSON.parse((await run(router, 'bridge_info', {}))[0]!)).toEqual({ profileLabel: 'Work', windows: 2, tabs: 2, containers: 1, extensionVersion: '1.2.3' });
    setLabel('  ');
    expect(JSON.parse((await run(router, 'bridge_info', {}))[0]!).profileLabel).toBeNull();
  });
});

describe('helpers', () => {
  it('checkUrl allows only the listed schemes', () => {
    expect(checkUrl('https://a.test/x?y=1', ['http:', 'https:']).host).toBe('a.test');
    expect(() => checkUrl('ftp://a.test', ['http:', 'https:'])).toThrow(ToolError);
    expect(() => checkUrl('a.test', ['https:'])).toThrow('not a valid address');
  });

  it('withTimeout passes results and failures through', async () => {
    await expect(withTimeout(Promise.resolve(3), 50, 'x')).resolves.toBe(3);
    await expect(withTimeout(Promise.reject(new Error('inner')), 50, 'x')).rejects.toThrow('inner');
  });
});
