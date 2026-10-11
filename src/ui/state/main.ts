import { browser } from 'wxt/browser';
import { CONTAINER_HEX } from '../../core';
import { facetApi } from '../../engine/api-client';
import { describeError } from '../format';

/**
 * state.html: what SplitSession knows, as plain text for AI agents (`get_page_text`) and for debugging: containers, the open
 * container tabs, and ready-to-copy ways to open a URL in a container.
 */

const root = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function list(items: Array<string | HTMLElement>): HTMLUListElement {
  const ul = el('ul');
  for (const item of items) {
    const li = el('li');
    if (typeof item === 'string') li.textContent = item;
    else li.append(item);
    ul.append(li);
  }
  return ul;
}

async function render(): Promise<void> {
  try {
    const [containers, registry, tabs] = await Promise.all([facetApi.listContainers(), facetApi.listTabs(), browser.tabs.query({})]);
    const byId = new Map(containers.map((c) => [c.id, c]));
    const tabById = new Map(tabs.map((t) => [t.id, t]));
    const extensionId = browser.runtime.id;
    const open = `chrome-extension://${extensionId}/open.html`;
    const sample = containers[0]?.name ?? 'Work';
    const sampleUrl = 'https://example.com/';

    const out: Node[] = [];
    out.push(el('h1', 'SplitSession state'));
    out.push(el('p', `Extension ID: ${extensionId}. ${containers.length} containers, ${registry.length} open container tabs. Generated ${new Date().toISOString()}.`));

    out.push(el('h2', `Containers (${containers.length})`));
    if (containers.length === 0) out.push(el('p', 'No containers yet. Opening an open.html address with a new container name creates it.'));
    else {
      out.push(
        list(
          containers.map((c) => {
            const li = el('span');
            const dot = el('span', '', 'dot');
            dot.style.background = CONTAINER_HEX[c.color];
            li.append(dot, document.createTextNode(`id=${c.id} name="${c.name}" color=${c.color} tabs=${c.tabCount}`));
            return li;
          }),
        ),
      );
    }

    out.push(el('h2', `Open container tabs (${registry.length})`));
    if (registry.length === 0) out.push(el('p', 'No tab is in a container right now.'));
    else {
      out.push(
        list(
          registry
            .slice()
            .sort((a, b) => a.tabId - b.tabId)
            .map((r) => {
              const tab = tabById.get(r.tabId);
              const c = byId.get(r.containerId);
              return `tabId=${r.tabId} container="${c?.name ?? '?'}" (${r.containerId}) window=${tab?.windowId ?? '?'} title="${tab?.title ?? ''}" url=${tab?.url ?? tab?.pendingUrl ?? ''}`;
            }),
        ),
      );
    }

    out.push(el('h2', 'How to open a page in a container'));
    out.push(el('p', 'Navigate a tab to this address. The tab is put in the container before its first request. An unknown container name creates the container.'));
    out.push(el('pre', `${open}?container=${encodeURIComponent(sample)}&url=${encodeURIComponent(sampleUrl)}`));
    out.push(el('p', `Or add a marker to any address (the container must already exist; the marker is stripped, one request goes out before SplitSession sees it):`));
    out.push(el('pre', `${sampleUrl}#ctr=${encodeURIComponent(sample)}`));
    out.push(el('p', 'Container tabs show the container in three places: the page title starts with "[name] ", the top document has the attribute data-ctr="name" on <html>, and the toolbar badge shows its initials.'));
    out.push(el('p', `container = a container name or id. url = a full http(s) address, URL-encoded. ${open} is the open page.`, 'muted'));

    root.replaceChildren(...out);
  } catch (error) {
    root.replaceChildren(el('h1', 'SplitSession state'), el('p', `Could not read SplitSession's state: ${describeError(error)}`));
  }
}

void render();

// Keep the page current while an agent works with it.
let timer: ReturnType<typeof setTimeout> | null = null;
const soon = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void render(), 300);
};
browser.tabs.onUpdated.addListener((_id, change) => {
  if (change.title !== undefined || change.url !== undefined || change.status === 'complete') soon();
});
browser.tabs.onRemoved.addListener(soon);
browser.tabs.onCreated.addListener(soon);
browser.storage.onChanged.addListener(soon);
