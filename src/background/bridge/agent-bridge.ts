import type { browser } from "wxt/browser";

import {
  type ExtensionToHost,
  HOST_NAME,
  type HostToExtension,
  MULTI_PROFILE_PROTOCOL,
  PING_TOOL,
  PROTOCOL_VERSION,
  SESSION_TOOL,
  SWITCHED_OFF,
  type ToolResult,
} from "../../bridge/protocol";
import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { Logger } from "../log";
import { newProfileKey } from "./profile-key";
import type { ActionMeta } from "./router";

type Browser = typeof browser;

/** One finished tool call, for the popup's short list of what the agent just did. Never page content. */
export interface RecentAction {
  at: number;
  tool: string;
  ok: boolean;
  /** The tab the tool worked on, when it had one: its title (our own marks removed) and site. */
  title: string | null;
  host: string | null;
}

/** How many of the latest actions the popup shows. */
export const RECENT_ACTIONS = 5;

export type BridgeStatus =
  "off" | "connecting" | "connected" | "host-missing" | "busy" | "error";

export interface BridgeState {
  status: BridgeStatus;
  /** Why the status is `error`, `host-missing` or `busy`. */
  error: string | null;
  /** Tool calls handled since the bridge was last switched on. */
  actions: number;
  lastTool: string | null;
  lastAt: number | null;
  /** The latest actions, newest first (at most `RECENT_ACTIONS`). */
  recent: RecentAction[];
  /** The name the user gave this Chrome profile (empty: none): "Connected as …". */
  profileLabel: string;
  /** This profile's bridge key (the name of its socket; the agent can address the profile by it). */
  profileKey: string | null;
  /** How many Chrome profiles have the bridge on (this one included), as the host counts them; null: unknown (older host). */
  profiles: number | null;
  /**
   * The host is older than this extension (protocol 1, npm 0.1.x): it works, but for one Chrome profile at a time. Also set
   * when such a host said "busy" (another profile holds its one socket).
   */
  hostOutdated: boolean;
}

export const BRIDGE_STATE_KEY = "bridgeState";
export const BRIDGE_ALARM = "facet-bridge-retry";

/** This Chrome profile's identity for the bridge (`chrome.storage.local`). */
export interface ProfileIdentity {
  /** The stored key; made and stored on first use. */
  key(): Promise<string>;
  /** A new key, stored: another profile carries the same one. */
  renewKey(): Promise<string>;
  label(): Promise<string>;
}

/** Tests and a missing storage: a key for this worker's life, no label. */
const memoryIdentity = (): ProfileIdentity => {
  let key = newProfileKey();
  return {
    key: async () => key,
    renewKey: async () => {
      key = newProfileKey();
      return key;
    },
    label: async () => "",
  };
};

/** What the connection needs from the router. */
export interface ToolRunner {
  run(tool: string, args: unknown, meta: ActionMeta): Promise<ToolResult>;
  /** No agent is connected any more: let go of whatever it left behind (viewport overrides, debugger sessions). */
  release?(): Promise<void>;
}

interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** How often a profile that found the bridge held by another profile looks again (it is cheap: the host answers and exits). */
const BUSY_RETRY_MS = 10_000;
/**
 * A host for this profile key is still running: normally the previous one, leaving after a quick off and on, so look again
 * soon. Found twice in a row, the key is taken by another profile (a copied profile directory): make a new one.
 */
const SAME_PROFILE_RETRY_MS = 1_000;
const SAME_PROFILE_TRIES = 2;
/** After the last MCP client has gone, how long the agent's leftovers (viewport overrides, debugger sessions) stay. */
export const RELEASE_GRACE_MS = 10_000;

/** Keepalive and session bookkeeping of the host: never an agent action, so never run, counted or listed. */
const isInternalTool = (tool: unknown): boolean =>
  tool === PING_TOOL ||
  tool === SESSION_TOOL ||
  (typeof tool === "string" && tool.startsWith("__"));

const IDLE: BridgeState = {
  status: "off",
  error: null,
  actions: 0,
  lastTool: null,
  lastAt: null,
  recent: [],
  profileLabel: "",
  profileKey: null,
  profiles: null,
  hostOutdated: false,
};

/**
 * The extension's end of the agent bridge. While the setting is on it keeps a Native Messaging port to the host
 * (`com.splitsession.bridge`), answers the host's tool requests through the router, and publishes its state (`storage.session`
 * key `bridgeState`) for the popup and the options page. Off: no port, no host process.
 */
export class AgentBridge {
  private enabled = false;
  private port: PortLike | null = null;
  private runner: ToolRunner | null = null;
  private current: BridgeState = { ...IDLE };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** The host's own explanation, when it exits right after telling us why. */
  private lastFatal: string | null = null;
  /** Set when the host said another Chrome profile holds the socket; read when its port closes. */
  private lastBusy: string | null = null;
  /** The host said a host for this very key is running (protocol 2); counts consecutive times. */
  private sameProfile = 0;
  private sameProfilePending = false;
  private profileKey: string | null = null;
  /** Aborted when the switch goes off or the connection is dropped: tools still running stop before their next step. */
  private abort = new AbortController();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded: Promise<void>;

  constructor(
    private readonly b: Browser,
    private readonly area: StorageAreaLike,
    private readonly log: Logger,
    private readonly identity: ProfileIdentity = memoryIdentity(),
  ) {
    this.loaded = this.load();
  }

  /** The user renamed this profile (options page): "Connected as …" follows at once. */
  labelChanged(label: string): void {
    this.publish({ profileLabel: label });
  }

  setRunner(runner: ToolRunner): void {
    this.runner = runner;
  }

  state(): BridgeState {
    return { ...this.current };
  }

  private async load(): Promise<void> {
    try {
      const stored = (await this.area.get(BRIDGE_STATE_KEY))[
        BRIDGE_STATE_KEY
      ] as Partial<BridgeState> | undefined;
      if (stored && typeof stored.actions === "number")
        this.current = {
          ...IDLE,
          actions: stored.actions,
          lastTool: stored.lastTool ?? null,
          lastAt: stored.lastAt ?? null,
          recent: Array.isArray(stored.recent)
            ? stored.recent
                .filter((r) => !isInternalTool(r?.tool))
                .slice(0, RECENT_ACTIONS)
            : [],
        };
    } catch {
      /* session storage unavailable: counters start from zero */
    }
    try {
      this.profileKey = await this.identity.key();
      this.current = {
        ...this.current,
        profileKey: this.profileKey,
        profileLabel: await this.identity.label(),
      };
    } catch (error) {
      this.log("warn", "agent bridge: no profile key", String(error));
    }
  }

  private publish(patch: Partial<BridgeState>): void {
    this.current = { ...this.current, ...patch };
    void this.area.set({ [BRIDGE_STATE_KEY]: this.current }).catch(() => {});
  }

  /**
   * Make the connection match the setting. `fresh`: the user has just switched it on (the action counter restarts);
   * a worker restart with the setting already on calls this without it and keeps counting.
   */
  async sync(enabled: boolean, fresh = false): Promise<void> {
    await this.loaded;
    if (!enabled) {
      this.enabled = false;
      this.cancelRelease();
      this.abort.abort();
      this.teardown();
      this.attempt = 0;
      this.sameProfile = 0;
      void this.b.alarms.clear(BRIDGE_ALARM);
      this.publish({
        status: "off",
        error: null,
        profiles: null,
        hostOutdated: false,
      });
      this.log("info", "agent bridge off");
      return;
    }
    if (this.enabled && this.port) return;
    this.enabled = true;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    if (fresh)
      this.publish({ actions: 0, lastTool: null, lastAt: null, recent: [] });
    // A worker that was stopped and comes back (or a retry that must survive the worker stopping) is woken by this.
    void this.b.alarms.create(BRIDGE_ALARM, { periodInMinutes: 1 });
    this.log("info", "agent bridge on");
    this.connect();
  }

  /** The "check again" button and the periodic alarm. */
  retry(): void {
    if (!this.enabled || this.port) return;
    this.connect();
  }

  handleAlarm(name: string): void {
    if (name === BRIDGE_ALARM) this.retry();
  }

  private connect(): void {
    this.clearTimers();
    // A profile waiting for the other one to let go stays "busy" between looks instead of flickering.
    if (this.current.status !== "busy")
      this.publish({ status: "connecting", error: null });
    let port: PortLike;
    try {
      port = this.b.runtime.connectNative(HOST_NAME) as unknown as PortLike;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => this.onMessage(port, message));
    port.onDisconnect.addListener(() => this.onDisconnect(port));
    // Protocol 2: the first message names this profile, and the host serves it on a socket of its own. A 0.1.x host
    // ignores it and takes the one shared socket (then `ready` says version 1).
    if (this.profileKey) {
      try {
        port.postMessage({
          type: "hello",
          version: PROTOCOL_VERSION,
          profileKey: this.profileKey,
        } satisfies ExtensionToHost);
      } catch {
        /* the port is already gone: onDisconnect tells */
      }
    }
    // Chrome opens the port even when the host does not exist; "not found" arrives as a disconnect. A host that starts
    // but never says ready is given up on.
    this.connectTimer = setTimeout(() => {
      if (this.port === port && this.current.status !== "connected") {
        this.teardown();
        this.fail("the host started but did not answer");
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private onMessage(port: PortLike, raw: unknown): void {
    if (this.port !== port || typeof raw !== "object" || raw === null) return;
    const message = raw as HostToExtension;
    if (message.type === "ready") {
      this.clearTimers();
      this.attempt = 0;
      this.sameProfile = 0;
      const version = typeof message.version === "number" ? message.version : 1;
      this.publish({
        status: "connected",
        error: null,
        hostOutdated: version < MULTI_PROFILE_PROTOCOL,
        profiles:
          version < MULTI_PROFILE_PROTOCOL ? null : this.current.profiles,
      });
      this.log("info", "agent bridge connected", {
        protocol:
          version === PROTOCOL_VERSION ? "ok" : `host speaks ${version}`,
      });
    } else if (message.type === "fatal") {
      this.lastFatal = String(message.message).slice(0, 300);
    } else if (message.type === "busy" && message.code === "same-profile") {
      // Protocol 2: our own socket is held. Usually the previous host of this profile on its way out.
      this.clearTimers();
      this.sameProfile += 1;
      this.sameProfilePending = true;
      this.log("warn", "agent bridge: this profile's socket is in use", {
        tries: this.sameProfile,
      });
    } else if (message.type === "busy") {
      // Only a 0.1.x host says "busy" without a code: it has one socket for every profile.
      this.clearTimers();
      this.lastBusy = String(message.reason).slice(0, 200);
      this.publish({
        status: "busy",
        error: this.lastBusy,
        hostOutdated: true,
      });
      this.log("warn", "agent bridge busy", this.lastBusy);
    } else if (
      message.type === "profiles" &&
      typeof message.count === "number"
    ) {
      this.publish({ profiles: message.count });
    } else if (
      message.type === "clients" &&
      typeof message.count === "number"
    ) {
      if (message.count > 0) this.cancelRelease();
      else this.scheduleRelease();
    } else if (message.type === "request" && typeof message.id === "number") {
      this.cancelRelease(); // somebody is working
      void this.serve(port, message.id, message.tool, message.args);
    }
  }

  private async serve(
    port: PortLike,
    id: number,
    tool: string,
    args: unknown,
  ): Promise<void> {
    if (isInternalTool(tool)) {
      try {
        port.postMessage({
          type: "response",
          id,
          ok: true,
          result: { content: [{ type: "text", text: "pong" }] },
        } satisfies ExtensionToHost);
      } catch {
        /* the host is gone: nothing to answer */
      }
      return;
    }
    const started = Date.now();
    const meta: ActionMeta = { signal: this.abort.signal };
    let reply: ExtensionToHost;
    try {
      if (!this.runner)
        throw new Error(
          "the SplitSession background is still starting; try again",
        );
      // Switched off (or reconnecting) between the request arriving and now: do nothing at all.
      if (!this.enabled || this.port !== port || meta.signal!.aborted)
        throw new Error(SWITCHED_OFF);
      const result = await this.runner.run(String(tool), args, meta);
      reply = { type: "response", id, ok: true, result };
    } catch (error) {
      reply = {
        type: "response",
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // The action log: what was done to which tab and whether it worked. Never what the page said.
    this.log(reply.ok ? "info" : "warn", "agent action", {
      tool: String(tool),
      tabId: meta.tabId ?? null,
      host: meta.host ?? null,
      ok: reply.ok,
      ms: Date.now() - started,
      ...(reply.ok ? {} : { error: reply.error.slice(0, 120) }),
    });
    const entry: RecentAction = {
      at: started,
      tool: String(tool),
      ok: reply.ok,
      title: meta.title ?? null,
      host: meta.host ?? null,
    };
    this.publish({
      actions: this.current.actions + 1,
      lastTool: String(tool),
      lastAt: Date.now(),
      recent: [entry, ...this.current.recent].slice(0, RECENT_ACTIONS),
    });
    if (this.port !== port) return; // switched off or reconnected while the tool ran: the answer has no reader
    try {
      port.postMessage(reply);
    } catch (error) {
      this.log("warn", "agent bridge: could not send a reply", String(error));
    }
  }

  /** Every MCP client has gone: after a short grace (a restarting client comes back), the runner lets go of what the agent left. */
  private scheduleRelease(): void {
    this.cancelRelease();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      void this.runner
        ?.release?.()
        .catch((error) =>
          this.log("warn", "agent bridge: release failed", String(error)),
        );
      this.log(
        "info",
        "agent bridge: no agent connected; viewport overrides and debugger sessions released",
      );
    }, RELEASE_GRACE_MS);
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private onDisconnect(port: PortLike): void {
    if (this.port !== port) return; // our own teardown
    this.scheduleRelease(); // the host is gone, and with it every client
    const reason =
      this.lastFatal ?? this.b.runtime.lastError?.message ?? "the host exited";
    this.lastFatal = null;
    this.port = null;
    this.clearTimers();
    // Requests of the dropped connection have no reader any more: stop them, and give the next connection a fresh signal.
    this.abort.abort();
    this.abort = new AbortController();
    if (!this.enabled) return;
    if (this.sameProfilePending) {
      this.sameProfilePending = false;
      if (this.sameProfile >= SAME_PROFILE_TRIES) {
        // Still held after a pause: another profile has this key. This profile takes a new one.
        this.sameProfile = 0;
        void this.identity.renewKey().then(
          (key) => {
            this.profileKey = key;
            this.publish({ profileKey: key });
            this.log(
              "warn",
              "agent bridge: profile key was in use elsewhere; made a new one",
            );
            if (this.enabled && !this.port) this.connect();
          },
          (error) => this.fail(String(error)),
        );
        return;
      }
      this.retryTimer = setTimeout(() => this.retry(), SAME_PROFILE_RETRY_MS);
      return;
    }
    if (this.lastBusy) {
      this.lastBusy = null;
      this.retryTimer = setTimeout(() => this.retry(), BUSY_RETRY_MS);
      return; // status stays "busy": the other profile has the bridge, and the alarm and the button look again as well
    }
    if (/not found/i.test(reason)) {
      this.publish({ status: "host-missing", error: reason });
      this.log("warn", "agent bridge: host not installed", reason);
      return; // the alarm and the "check again" button look again
    }
    this.fail(reason);
  }

  private fail(reason: string): void {
    this.publish({ status: "error", error: reason });
    this.log("warn", "agent bridge error", reason);
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => this.retry(), wait);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.retryTimer = this.connectTimer = null;
  }

  private teardown(): void {
    this.clearTimers();
    this.lastBusy = null;
    this.sameProfilePending = false;
    const port = this.port;
    this.port = null;
    if (!port) return;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
  }
}
