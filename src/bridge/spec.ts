import type { Schema } from './validate';

/**
 * The tools of the Facet agent bridge: one list for the MCP server (names, descriptions, input schemas) and the
 * extension (validation). Every tool works on tab IDs as Chrome reports them; `list_tabs` is the starting point.
 */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema & { type: 'object'; properties: Record<string, Schema> };
  /** Does not change anything in the browser (MCP `readOnlyHint`). */
  readOnly: boolean;
}

const obj = (properties: Record<string, Schema>, required: string[] = []): ToolSpec['inputSchema'] => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const tabId: Schema = { type: 'integer', minimum: 0, description: 'Chrome tab ID, from list_tabs.' };
const container: Schema = { type: 'string', minLength: 1, maxLength: 64, description: 'Container name (case-insensitive) or ID.' };
const maxChars = (fallback: number): Schema => ({
  type: 'integer',
  minimum: 100,
  maximum: 2_000_000,
  default: fallback,
  description: `Longest result to return, in characters (default ${fallback}); longer results are cut and flagged as truncated.`,
});
const wait: Schema = { type: 'boolean', default: true, description: 'Wait for the page to finish loading (up to 10 seconds) before returning. Default true.' };

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'bridge_info',
    title: 'Which Chrome profile',
    readOnly: true,
    description:
      'Which Chrome profile these tools are connected to: the profile label the user set in the Facet options (null when none), how many windows, tabs and containers it has, and the extension version. The user may have several Chrome profiles but only ONE holds the bridge at a time; when the tabs are not the ones you expected, check this and ask the user to switch the bridge off in the other profile.',
    inputSchema: obj({}),
  },
  {
    name: 'list_containers',
    title: 'List containers',
    readOnly: true,
    description:
      'List the Facet containers (several logged-in accounts of one site in one Chrome profile). Returns id, name, colour and number of open tabs for each.',
    inputSchema: obj({}),
  },
  {
    name: 'list_tabs',
    title: 'List tabs',
    readOnly: true,
    description:
      'List the open tabs of ALL Chrome windows with the Facet container each one belongs to (container is null for an ordinary tab). Titles of container tabs may carry a "[container] " prefix if the user enabled it. Use the returned tabId with every other tab tool.',
    inputSchema: obj({
      windowId: { type: 'integer', minimum: 0, description: 'Only the tabs of this window.' },
      containerId: { type: 'string', minLength: 1, maxLength: 64, description: 'Only the tabs of this container (name or ID).' },
    }),
  },
  {
    name: 'open_in_container',
    title: 'Open a page in a container',
    readOnly: false,
    description:
      'Open an http(s) page in a NEW tab inside a Facet container. The tab is assigned to the container before its first request, so the page loads with that container\'s cookies (that account\'s logins) and nothing from the regular profile. An unknown container is an error unless createIfMissing is true.',
    inputSchema: obj(
      {
        url: { type: 'string', minLength: 1, maxLength: 8192, description: 'http or https address.' },
        container,
        createIfMissing: { type: 'boolean', default: false, description: 'Create the container when no container has that name. Default false.' },
        active: { type: 'boolean', default: false, description: 'Bring the new tab to the front. Default false (opens in the background).' },
        windowId: { type: 'integer', minimum: 0, description: 'Window to open the tab in (default: the current window).' },
        wait,
      },
      ['url', 'container'],
    ),
  },
  {
    name: 'open_tab',
    title: 'Open a tab',
    readOnly: false,
    description: 'Open a new ordinary tab (no container; the regular Chrome profile). Use open_in_container for a container. Accepts http(s), about:blank and chrome:// addresses.',
    inputSchema: obj(
      {
        url: { type: 'string', minLength: 1, maxLength: 8192 },
        active: { type: 'boolean', default: false, description: 'Bring the new tab to the front. Default false.' },
        windowId: { type: 'integer', minimum: 0 },
        wait,
      },
      ['url'],
    ),
  },
  {
    name: 'navigate',
    title: 'Navigate a tab',
    readOnly: false,
    description:
      'Navigate an existing tab to an address, keeping its container. A Facet domain rule can still move the tab to another container by replacing it with a new tab (new tabId): call list_tabs afterwards when the container matters.',
    inputSchema: obj({ tabId, url: { type: 'string', minLength: 1, maxLength: 8192 }, wait }, ['tabId', 'url']),
  },
  {
    name: 'close_tab',
    title: 'Close a tab',
    readOnly: false,
    description: 'Close a tab.',
    inputSchema: obj({ tabId }, ['tabId']),
  },
  {
    name: 'activate_tab',
    title: 'Activate a tab',
    readOnly: false,
    description: 'Make a tab the active tab of its window and bring that window to the front.',
    inputSchema: obj({ tabId }, ['tabId']),
  },
  {
    name: 'assign_tab',
    title: 'Move a tab into a container',
    readOnly: false,
    description:
      'Put an existing tab into a container, or take it out (container: null). By default the tab is reloaded so the page starts with the new container\'s cookies. Note: the page already loaded keeps its JavaScript state until it reloads, and a window.opener of the old document survives (open_in_container avoids both).',
    inputSchema: obj(
      {
        tabId,
        container: { type: ['string', 'null'], maxLength: 64, description: 'Container name or ID; null removes the tab from its container.' },
        createIfMissing: { type: 'boolean', default: false },
        reload: { type: 'boolean', default: true, description: 'Reload the tab after the move (default true).' },
      },
      ['tabId', 'container'],
    ),
  },
  {
    name: 'get_tab_text',
    title: 'Read the text of a tab',
    readOnly: true,
    description: 'Return the visible text (innerText) of the top frame of a tab. Does not enter iframes.',
    inputSchema: obj({ tabId, maxChars: maxChars(20_000) }, ['tabId']),
  },
  {
    name: 'get_tab_html',
    title: 'Read the HTML of a tab',
    readOnly: true,
    description: 'Return the HTML (outerHTML) of the top frame of a tab, or of the first element matching a CSS selector.',
    inputSchema: obj(
      { tabId, selector: { type: 'string', minLength: 1, maxLength: 1000, description: 'CSS selector; default is the whole document.' }, maxChars: maxChars(50_000) },
      ['tabId'],
    ),
  },
  {
    name: 'screenshot_tab',
    title: 'Screenshot a tab',
    readOnly: false,
    description:
      'Take a screenshot of the visible part of a tab and return it as an image. Chrome can only capture the active tab of a window, so the tab is activated briefly and the previously active tab is restored afterwards (the window may flash).',
    inputSchema: obj({
      tabId,
      format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
      quality: { type: 'integer', minimum: 1, maximum: 100, default: 80, description: 'JPEG quality (ignored for png).' },
    }, ['tabId']),
  },
  {
    name: 'click',
    title: 'Click',
    readOnly: false,
    description:
      'Click an element of the top frame, found by CSS selector, or whatever is at viewport coordinates (x, y). Sends pointer, mouse and click events (they are synthetic: isTrusted is false, which a few sites ignore). The element is scrolled into view first when a selector is used.',
    inputSchema: obj({
      tabId,
      selector: { type: 'string', minLength: 1, maxLength: 1000 },
      x: { type: 'number', minimum: 0, maximum: 100000 },
      y: { type: 'number', minimum: 0, maximum: 100000 },
    }, ['tabId']),
  },
  {
    name: 'type',
    title: 'Type into a field',
    readOnly: false,
    description:
      'Set the text of an input, textarea or contenteditable element found by CSS selector, the way a framework-friendly script does it (native value setter, then input and change events). Replaces the current value unless append is true. With submit, presses Enter and submits the form.',
    inputSchema: obj(
      {
        tabId,
        selector: { type: 'string', minLength: 1, maxLength: 1000 },
        text: { type: 'string', maxLength: 100000 },
        append: { type: 'boolean', default: false },
        submit: { type: 'boolean', default: false },
      },
      ['tabId', 'selector', 'text'],
    ),
  },
  {
    name: 'scroll',
    title: 'Scroll',
    readOnly: false,
    description: 'Scroll the top frame: bring an element into view (selector), jump to the top or bottom (to), or scroll by pixels (dx, dy).',
    inputSchema: obj({
      tabId,
      selector: { type: 'string', minLength: 1, maxLength: 1000 },
      to: { type: 'string', enum: ['top', 'bottom'] },
      dx: { type: 'number', minimum: -100000, maximum: 100000 },
      dy: { type: 'number', minimum: -100000, maximum: 100000 },
    }, ['tabId']),
  },
  {
    name: 'run_js',
    title: 'Run JavaScript',
    readOnly: false,
    description:
      'Run JavaScript in the top frame of a tab. `code` is a function body: use `return` to give a value back (it may be async; the value is returned as JSON). Default world MAIN is the page\'s own world (page variables visible) and needs the page to allow eval: a page whose Content-Security-Policy forbids it fails with a clear error, unless the user enabled the userScripts fallback. World ISOLATED cannot evaluate strings under the extension\'s policy.',
    inputSchema: obj(
      {
        tabId,
        code: { type: 'string', minLength: 1, maxLength: 200000 },
        world: { type: 'string', enum: ['MAIN', 'ISOLATED'], default: 'MAIN' },
        maxChars: maxChars(20_000),
      },
      ['tabId', 'code'],
    ),
  },
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);
export const toolByName = (name: string): ToolSpec | undefined => TOOLS.find((t) => t.name === name);
