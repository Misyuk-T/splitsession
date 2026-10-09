import type { StorageAreaLike } from './storage/storage-area';
import type { ServiceWorkerPolicy } from './sw-policy';

export const STRICT_STATE_KEY = 'strictMode';

interface StoredState {
  /** When the user agreed to remove and block service workers; null = not (yet) agreed since strict mode was enabled. */
  consentAt: number | null;
  /** The popup / options page should open the consent dialog by itself (first container, install, update, enabling). */
  prompt: boolean;
}

/** What the interface needs to know about strict mode. */
export interface StrictModeStatus {
  /** The `strictMode` setting. */
  enabled: boolean;
  consentAt: number | null;
  /** Enabled and agreed: every service worker was removed and registration is refused on every site. */
  active: boolean;
  /** Enabled, not agreed, and there are containers: show the persistent warning. */
  needsConsent: boolean;
  /** Open the consent dialog without being asked (cleared by "Not now" or by agreeing). */
  prompt: boolean;
}

const normalize = (raw: unknown): StoredState => {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    consentAt: typeof source.consentAt === 'number' && Number.isFinite(source.consentAt) ? source.consentAt : null,
    prompt: source.prompt === true,
  };
};

/**
 * Strict mode (default on): a real-profile service worker can answer a container tab's first request on a site
 * before Facet gets to remove it (removal is asynchronous, the navigation is not). With the user's consent Facet
 * removes every service worker of the profile once and refuses new registrations on every site in every tab (the
 * shim's guard mode), so no such worker exists. Consent is explicit because it costs push notifications and offline
 * mode of every site in this profile. Until it is given, containers work with the per-site policy and the popup
 * shows a warning.
 */
export class StrictMode {
  private state: StoredState = { consentAt: null, prompt: false };
  private enabled = true;

  constructor(
    private readonly area: StorageAreaLike,
    private readonly sw: ServiceWorkerPolicy,
    private readonly containerCount: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the stored state; returns whether the guard should be on (call before `sw.load`). */
  async load(enabled: boolean): Promise<boolean> {
    this.enabled = enabled;
    this.state = normalize((await this.area.get(STRICT_STATE_KEY))[STRICT_STATE_KEY]);
    return this.active;
  }

  get active(): boolean {
    return this.enabled && this.state.consentAt !== null;
  }

  status(): StrictModeStatus {
    return {
      enabled: this.enabled,
      consentAt: this.state.consentAt,
      active: this.active,
      needsConsent: this.enabled && this.state.consentAt === null && this.containerCount() > 0,
      prompt: this.enabled && this.state.consentAt === null && this.state.prompt,
    };
  }

  /** The `strictMode` setting changed. Turning it off forgets the consent; turning it on asks again. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    await this.save(enabled ? { consentAt: null, prompt: true } : { consentAt: null, prompt: false });
    await this.sw.setGuard(this.active);
  }

  /** The user agreed: remove every service worker, then refuse registrations everywhere. */
  async grant(): Promise<StrictModeStatus> {
    if (!this.enabled) throw new Error('strict mode is off');
    await this.sw.removeAll();
    await this.save({ consentAt: this.now(), prompt: false });
    await this.sw.setGuard(true);
    return this.status();
  }

  /** "Not now": stop opening the dialog by itself (the warning stays). */
  async dismissPrompt(): Promise<StrictModeStatus> {
    if (this.state.prompt) await this.save({ ...this.state, prompt: false });
    return this.status();
  }

  /** A container was created: the first one makes the interface ask. */
  async containerCreated(): Promise<void> {
    if (this.enabled && this.state.consentAt === null && this.containerCount() === 1 && !this.state.prompt) {
      await this.save({ ...this.state, prompt: true });
    }
  }

  /** Install or update: ask again if containers exist without consent; with consent, sweep workers again. */
  async installed(reason: string): Promise<void> {
    if (reason !== 'install' && reason !== 'update') return;
    if (this.active) {
      await this.sw.removeAll().catch(() => {});
      return;
    }
    if (this.enabled && this.containerCount() > 0 && !this.state.prompt) await this.save({ ...this.state, prompt: true });
  }

  /**
   * Browser start: pages restored before Facet's content scripts were registered (or tabs open since before the
   * install) could have registered workers without the shim. Sweep again.
   */
  async startup(): Promise<void> {
    if (this.active) await this.sw.removeAll().catch(() => {});
  }

  private async save(next: StoredState): Promise<void> {
    this.state = next;
    await this.area.set({ [STRICT_STATE_KEY]: next });
  }
}
