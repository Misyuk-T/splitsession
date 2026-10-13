import { TOOL_TIMEOUT_MS } from "./protocol";
import type { Schema } from "./validate";

/**
 * The tools of the SplitSession agent bridge: one list for the MCP server (names, descriptions, input schemas) and the
 * extension (validation). Every tool works on tab IDs as Chrome reports them; `list_tabs` is the starting point.
 */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema & { type: "object"; properties: Record<string, Schema> };
  /** Does not change anything in the browser (MCP `readOnlyHint`). */
  readOnly: boolean;
  /** Deadline inside the extension when it is not the default `TOOL_TIMEOUT_MS` (the host and the MCP server add a margin). */
  timeoutMs?: number;
}

const obj = (
  properties: Record<string, Schema>,
  required: string[] = [],
): ToolSpec["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const tabId: Schema = {
  type: "integer",
  minimum: 0,
  description: "Chrome tab ID, from list_tabs.",
};
const container: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "Container name (case-insensitive) or ID.",
};
const maxChars = (fallback: number): Schema => ({
  type: "integer",
  minimum: 100,
  maximum: 2_000_000,
  default: fallback,
  description: `Longest result to return, in characters (default ${fallback}); longer results are cut and flagged as truncated.`,
});
const ref: Schema = {
  type: "string",
  pattern: "^e[0-9]{1,7}$",
  description: 'Element ref from the latest snapshot, e.g. "e12".',
};
const selector: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 1000,
  description: "CSS selector (top frame; first match).",
};
/** An element: a ref from `snapshot`, or a CSS selector. */
const target = { ref, selector };
const modifiers: Schema = {
  type: "array",
  maxItems: 4,
  items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
  description: "Keys held during the action.",
};
const wait: Schema = {
  type: "boolean",
  default: true,
  description:
    "Wait for the page to finish loading (up to 10 seconds) before returning. Default true.",
};

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "bridge_info",
    title: "Which Chrome profile",
    readOnly: true,
    description:
      "Which Chrome profile these tools are connected to: the profile label the user set in the SplitSession options (null when none), how many windows, tabs and containers it has, and the extension version. The user may have several Chrome profiles but only ONE holds the bridge at a time; when the tabs are not the ones you expected, check this and ask the user to switch the bridge off in the other profile.",
    inputSchema: obj({}),
  },
  {
    name: "list_containers",
    title: "List containers",
    readOnly: true,
    description:
      "List the SplitSession containers (several logged-in accounts of one site in one Chrome profile). Returns id, name, colour and number of open tabs for each.",
    inputSchema: obj({}),
  },
  {
    name: "list_tabs",
    title: "List tabs",
    readOnly: true,
    description:
      'List the open tabs of ALL Chrome windows with the SplitSession container each one belongs to (container is null for an ordinary tab). Titles of container tabs may carry a "[container] " prefix if the user enabled it. Use the returned tabId with every other tab tool.',
    inputSchema: obj({
      windowId: {
        type: "integer",
        minimum: 0,
        description: "Only the tabs of this window.",
      },
      containerId: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "Only the tabs of this container (name or ID).",
      },
    }),
  },
  {
    name: "open_in_container",
    title: "Open a page in a container",
    readOnly: false,
    description:
      "Open an http(s) page in a NEW tab inside a SplitSession container. The tab is assigned to the container before its first request, so the page loads with that container's cookies (that account's logins) and nothing from the regular profile. An unknown container is an error unless createIfMissing is true.",
    inputSchema: obj(
      {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 8192,
          description: "http or https address.",
        },
        container,
        createIfMissing: {
          type: "boolean",
          default: false,
          description:
            "Create the container when no container has that name. Default false.",
        },
        active: {
          type: "boolean",
          default: false,
          description:
            "Bring the new tab to the front. Default false (opens in the background).",
        },
        windowId: {
          type: "integer",
          minimum: 0,
          description:
            "Window to open the tab in (default: the current window).",
        },
        wait,
      },
      ["url", "container"],
    ),
  },
  {
    name: "open_tab",
    title: "Open a tab",
    readOnly: false,
    description:
      "Open a new ordinary tab (no container; the regular Chrome profile). Use open_in_container for a container. Accepts http(s), about:blank and chrome:// addresses.",
    inputSchema: obj(
      {
        url: { type: "string", minLength: 1, maxLength: 8192 },
        active: {
          type: "boolean",
          default: false,
          description: "Bring the new tab to the front. Default false.",
        },
        windowId: { type: "integer", minimum: 0 },
        wait,
      },
      ["url"],
    ),
  },
  {
    name: "navigate",
    title: "Navigate a tab",
    readOnly: false,
    description:
      "Navigate an existing tab to an address, keeping its container. A SplitSession domain rule can still move the tab to another container by replacing it with a new tab (new tabId): call list_tabs afterwards when the container matters.",
    inputSchema: obj(
      { tabId, url: { type: "string", minLength: 1, maxLength: 8192 }, wait },
      ["tabId", "url"],
    ),
  },
  {
    name: "navigate_back",
    title: "Go back",
    readOnly: false,
    description:
      "Go back one page in a tab's history (like the Back button), keeping its container.",
    inputSchema: obj({ tabId, wait }, ["tabId"]),
  },
  {
    name: "navigate_forward",
    title: "Go forward",
    readOnly: false,
    description:
      "Go forward one page in a tab's history, keeping its container.",
    inputSchema: obj({ tabId, wait }, ["tabId"]),
  },
  {
    name: "reload",
    title: "Reload",
    readOnly: false,
    description:
      "Reload a tab, keeping its container. bypassCache like Shift+Reload.",
    inputSchema: obj(
      { tabId, bypassCache: { type: "boolean", default: false }, wait },
      ["tabId"],
    ),
  },
  {
    name: "close_tab",
    title: "Close a tab",
    readOnly: false,
    description: "Close a tab.",
    inputSchema: obj({ tabId }, ["tabId"]),
  },
  {
    name: "activate_tab",
    title: "Activate a tab",
    readOnly: false,
    description:
      "Make a tab the active tab of its window and bring that window to the front.",
    inputSchema: obj({ tabId }, ["tabId"]),
  },
  {
    name: "assign_tab",
    title: "Move a tab into a container",
    readOnly: false,
    description:
      "Put an existing tab into a container, or take it out (container: null). By default the tab is reloaded so the page starts with the new container's cookies. Note: the page already loaded keeps its JavaScript state until it reloads, and a window.opener of the old document survives (open_in_container avoids both).",
    inputSchema: obj(
      {
        tabId,
        container: {
          type: ["string", "null"],
          maxLength: 64,
          description:
            "Container name or ID; null removes the tab from its container.",
        },
        createIfMissing: { type: "boolean", default: false },
        reload: {
          type: "boolean",
          default: true,
          description: "Reload the tab after the move (default true).",
        },
      },
      ["tabId", "container"],
    ),
  },
  {
    name: "get_tab_text",
    title: "Read the text of a tab",
    readOnly: true,
    description:
      "Return the visible text (innerText) of the top frame of a tab. Does not enter iframes.",
    inputSchema: obj({ tabId, maxChars: maxChars(20_000) }, ["tabId"]),
  },
  {
    name: "get_tab_html",
    title: "Read the HTML of a tab",
    readOnly: true,
    description:
      "Return the HTML (outerHTML) of the top frame of a tab, or of the first element matching a CSS selector.",
    inputSchema: obj(
      {
        tabId,
        selector: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "CSS selector; default is the whole document.",
        },
        maxChars: maxChars(50_000),
      },
      ["tabId"],
    ),
  },
  {
    name: "snapshot",
    title: "Snapshot the page (accessibility tree)",
    readOnly: true,
    timeoutMs: 25_000,
    description:
      'THE way to see a page: its accessibility tree as compact YAML-like lines, one element per line, each with a ref: `- button "Join" [ref=e12]`, `- textbox "Search" [ref=e13]: current value`, `- link "Docs" [ref=e14] /url=/docs`. Iframes are included where Chrome lets the extension reach them (also cross-site ones). Pass the ref to click, hover, drag, type, press_key, select_option, upload_file, scroll or wait_for. Refs stay valid until the page navigates (a later snapshot keeps the ref of an element that is still there). Prefer this over get_tab_html and screenshots.',
    inputSchema: obj({ tabId, maxChars: maxChars(60_000) }, ["tabId"]),
  },
  {
    name: "screenshot_tab",
    title: "Screenshot a tab",
    readOnly: true,
    timeoutMs: 30_000,
    description:
      'Screenshot of a tab, returned as an image, WITHOUT switching tabs: background tabs are captured in place. Only if Chrome hands back a blank picture of a background tab is the tab activated for a moment and the previously active tab restored (the result says which way it went: "background", "screencast" or "activated"). fullPage captures the whole scrollable page (up to 16384 px tall).',
    inputSchema: obj(
      {
        tabId,
        format: { type: "string", enum: ["png", "jpeg"], default: "png" },
        quality: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 80,
          description: "JPEG quality (ignored for png).",
        },
        fullPage: {
          type: "boolean",
          default: false,
          description: "The whole page instead of the visible part.",
        },
      },
      ["tabId"],
    ),
  },
  {
    name: "click",
    title: "Click",
    readOnly: false,
    description:
      "Click like a user: real mouse events from Chrome (isTrusted true). Target: a ref from snapshot (best), a CSS selector (top frame), or viewport coordinates x, y. The element is scrolled into view and clicked in the middle of its box. button left (default), right or middle; clickCount 2 for a double click; modifiers held during the click. If the click opens a JavaScript dialog, the result says so: answer it with handle_dialog.",
    inputSchema: obj(
      {
        tabId,
        ...target,
        x: {
          type: "number",
          minimum: 0,
          maximum: 100000,
          description:
            "Viewport x (CSS pixels), with y, instead of a ref or selector.",
        },
        y: { type: "number", minimum: 0, maximum: 100000 },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
        },
        clickCount: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          default: 1,
          description: "2 for a double click.",
        },
        modifiers,
      },
      ["tabId"],
    ),
  },
  {
    name: "hover",
    title: "Hover",
    readOnly: false,
    description:
      "Move the mouse over an element (ref or selector) or to viewport coordinates x, y: real mouse events, so :hover styles and mouseover handlers react.",
    inputSchema: obj(
      {
        tabId,
        ...target,
        x: { type: "number", minimum: 0, maximum: 100000 },
        y: { type: "number", minimum: 0, maximum: 100000 },
      },
      ["tabId"],
    ),
  },
  {
    name: "drag",
    title: "Drag and drop",
    readOnly: false,
    description:
      "Drag from one element (ref / selector / x,y) to another (toRef / toSelector / toX,toY) with real mouse events: press, move in steps, release. HTML5 drag and drop (draggable elements) is handled as well.",
    inputSchema: obj(
      {
        tabId,
        ...target,
        x: { type: "number", minimum: 0, maximum: 100000 },
        y: { type: "number", minimum: 0, maximum: 100000 },
        toRef: ref,
        toSelector: selector,
        toX: { type: "number", minimum: 0, maximum: 100000 },
        toY: { type: "number", minimum: 0, maximum: 100000 },
      },
      ["tabId"],
    ),
  },
  {
    name: "type",
    title: "Type into a field",
    readOnly: false,
    timeoutMs: 30_000,
    description:
      "Type text into an input, textarea or contenteditable element (ref or selector) the way a user does: Chrome inserts the text (trusted input events), so React-style controlled inputs see it. Replaces the current value unless append is true. slowly sends one key press per character (for pages that react to each key; at most 2000 characters). submit presses Enter afterwards.",
    inputSchema: obj(
      {
        tabId,
        ...target,
        text: { type: "string", maxLength: 100000 },
        append: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
        slowly: { type: "boolean", default: false },
      },
      ["tabId", "text"],
    ),
  },
  {
    name: "press_key",
    title: "Press a key",
    readOnly: false,
    description:
      'Press a key or a shortcut with real keyboard events: "Enter", "Escape", "Tab", "ArrowDown", "Backspace", "a", "Meta+A", "Control+Shift+K", "Shift+Tab". Modifiers: Shift, Control (Ctrl), Alt (Option), Meta (Cmd), ControlOrMeta. Goes to the focused element, or first focuses ref / selector. repeat presses it several times.',
    inputSchema: obj(
      {
        tabId,
        key: { type: "string", minLength: 1, maxLength: 60 },
        ...target,
        repeat: { type: "integer", minimum: 1, maximum: 50, default: 1 },
      },
      ["tabId", "key"],
    ),
  },
  {
    name: "select_option",
    title: "Choose in a <select>",
    readOnly: false,
    description:
      "Choose options of a native <select> element (ref or selector) by value or visible label; several for a multiple select. Fires input and change like a user choice. For custom dropdowns, click them instead.",
    inputSchema: obj(
      {
        tabId,
        ...target,
        values: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", maxLength: 1000 },
          description: "Option values or labels.",
        },
      },
      ["tabId", "values"],
    ),
  },
  {
    name: "upload_file",
    title: "Upload files",
    readOnly: false,
    description:
      'Put local files into an <input type="file"> (ref or selector), as if the user picked them: the page gets input and change events. paths are absolute paths on this computer; the MCP server checks that they exist. The files are then the page\'s to send wherever it sends them.',
    inputSchema: obj(
      {
        tabId,
        ...target,
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "string",
            minLength: 2,
            maxLength: 4096,
            pattern: "^/",
          },
          description: "Absolute file paths.",
        },
      },
      ["tabId", "paths"],
    ),
  },
  {
    name: "scroll",
    title: "Scroll",
    readOnly: false,
    description:
      "Scroll the top frame: bring an element into view (ref or selector), jump to the top or bottom (to), or scroll by pixels (dx, dy).",
    inputSchema: obj(
      {
        tabId,
        ...target,
        to: { type: "string", enum: ["top", "bottom"] },
        dx: { type: "number", minimum: -100000, maximum: 100000 },
        dy: { type: "number", minimum: -100000, maximum: 100000 },
      },
      ["tabId"],
    ),
  },
  {
    name: "wait_for",
    title: "Wait for the page",
    readOnly: true,
    timeoutMs: 35_000,
    description:
      "Wait until text appears in the page (text), disappears (textGone), or an element (ref or selector) becomes visible or hidden (state). Gives up after timeout milliseconds (default 5000, at most 30000) with an error.",
    inputSchema: obj(
      {
        tabId,
        text: { type: "string", minLength: 1, maxLength: 1000 },
        textGone: { type: "string", minLength: 1, maxLength: 1000 },
        ...target,
        state: {
          type: "string",
          enum: ["visible", "hidden"],
          default: "visible",
          description: "For ref or selector.",
        },
        timeout: {
          type: "integer",
          minimum: 100,
          maximum: 30000,
          default: 5000,
        },
      },
      ["tabId"],
    ),
  },
  {
    name: "run_js",
    title: "Run JavaScript",
    readOnly: false,
    timeoutMs: 30_000,
    description:
      'Run JavaScript in the page\'s own world (page variables visible) of the top frame. `code` is either a bare expression (`document.title`, `({a: 1})`; its value comes back) or a function body (use `return` to give a value back; `a; b` style code without `return` gives undefined); with awaitPromise (default) it may use await and the value is awaited. The value comes back as JSON (returnByValue, default) or as a short description of the object (returnByValue false). Works on pages whose Content-Security-Policy forbids eval. Errors come back as "Name: message".',
    inputSchema: obj(
      {
        tabId,
        code: { type: "string", minLength: 1, maxLength: 200000 },
        awaitPromise: { type: "boolean", default: true },
        returnByValue: { type: "boolean", default: true },
        world: {
          type: "string",
          enum: ["MAIN", "ISOLATED"],
          default: "MAIN",
          description: "Only MAIN is supported (see the SplitSession docs).",
        },
        maxChars: maxChars(20_000),
      },
      ["tabId", "code"],
    ),
  },
  {
    name: "handle_dialog",
    title: "Answer a JavaScript dialog",
    readOnly: false,
    description:
      "Answer the alert / confirm / prompt / beforeunload dialog that is open in a tab (tool results and errors say when one is): accept true = OK, false = Cancel; promptText is typed into a prompt.",
    inputSchema: obj(
      {
        tabId,
        accept: { type: "boolean" },
        promptText: { type: "string", maxLength: 10000 },
      },
      ["tabId", "accept"],
    ),
  },
  {
    name: "console_messages",
    title: "Console messages",
    readOnly: true,
    description:
      "Console output and uncaught errors of a tab, recorded while `watch` runs on it (SplitSession records the console only then: enabling it is visible to pages that look for debuggers). Browser messages (CSP violations, failed loads) are also recorded during other tools. Each entry has a seq; pass since = the last seq you saw to get only newer ones.",
    inputSchema: obj(
      {
        tabId,
        since: { type: "integer", minimum: 0, default: 0 },
        level: {
          type: "string",
          enum: ["all", "error", "warning", "info", "log", "debug"],
          default: "all",
        },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      ["tabId"],
    ),
  },
  {
    name: "network_requests",
    title: "Network requests",
    readOnly: true,
    description:
      "Requests a tab made while SplitSession was attached to it (during any tool, the 5 s after it, and the whole time `watch` runs): method, url, type, status, size, timing, failure. Use watch first to record a whole flow. filter keeps the URLs containing that text. Cookie and authorization headers are never shown (includeHeaders shows the rest). Each entry has a seq for since.",
    inputSchema: obj(
      {
        tabId,
        since: { type: "integer", minimum: 0, default: 0 },
        filter: { type: "string", minLength: 1, maxLength: 500 },
        includeHeaders: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      ["tabId"],
    ),
  },
  {
    name: "watch",
    title: "Watch a tab (console and network)",
    readOnly: true,
    description:
      'Keep SplitSession attached to a tab for some minutes (default 5, at most 30) and record its console and network for console_messages / network_requests, e.g. to debug the user\'s own site. Chrome shows its "started debugging this browser" bar while it lasts. stop: true ends it.',
    inputSchema: obj(
      {
        tabId,
        minutes: { type: "integer", minimum: 1, maximum: 30, default: 5 },
        stop: { type: "boolean", default: false },
      },
      ["tabId"],
    ),
  },
  {
    name: "resize_viewport",
    title: "Resize the viewport",
    readOnly: false,
    description:
      "Make the page think its viewport is width x height CSS pixels (e.g. 390 x 844 for a phone), without touching the window. It lasts until clear: true, the bridge is switched off, or the tab closes (SplitSession stays attached meanwhile).",
    inputSchema: obj(
      {
        tabId,
        width: { type: "integer", minimum: 100, maximum: 5000 },
        height: { type: "integer", minimum: 100, maximum: 5000 },
        clear: {
          type: "boolean",
          default: false,
          description: "Back to the real size.",
        },
      },
      ["tabId"],
    ),
  },
];

// Pure annotation: the extension's Lite build imports this module through dead branches only, and must not keep `TOOLS` alive.
export const TOOL_NAMES: readonly string[] = /* @__PURE__ */ TOOLS.map(
  (t) => t.name,
);
export const toolByName = (name: string): ToolSpec | undefined =>
  TOOLS.find((t) => t.name === name);

/** The extension's deadline for one call of `name`. The host waits `HOST_MARGIN_MS` longer, the MCP server longer still. */
export const toolTimeoutMs = (name: string): number =>
  toolByName(name)?.timeoutMs ?? TOOL_TIMEOUT_MS;
export const HOST_MARGIN_MS = 5_000;
