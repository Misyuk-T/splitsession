import { decideRule, findRule, hasCtrMarker, ruleKeyOf, type ContainerId, type DomainRule } from '../core';
import type { ExemptionManager } from './exemption-manager';

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);
/** A tab opened from a container page is assigned asynchronously, and OAuth hops follow quickly: it is not judged for this long. */
const CHILD_GRACE_MS = 5_000;
/** At most this many rule actions per tab within the window: a loop guard of last resort. */
const ACTION_LIMIT = 4;
const ACTION_WINDOW_MS = 10_000;

export interface RuleEngineDeps {
  rules(): readonly DomainRule[];
  /** Container of a tab, or null for a plain tab. */
  containerOf(tabId: number): ContainerId | null;
  /**
   * The container a `#ctr=` marker of this navigation puts the tab in, or null when SplitSession ignores the marker (no such
   * container, tab already in one, navigation started by a page). The engine handles honoured markers itself.
   */
  markerContainer(details: NavigationDetails): Promise<ContainerId | null>;
  /**
   * Moves the tab into the container by opening `url` in a FRESH tab at the same place (no `window.opener`, no
   * document another context could script) and closing the old one. `onCreated` runs with the new tab's ID once it is
   * in the container and before it navigates. Resolves with the new tab's ID.
   */
  replaceTab(tabId: number, containerId: ContainerId, url: string, onCreated: (newTabId: number) => void): Promise<number>;
  navigate(tabId: number, url: string): Promise<void>;
  chooseUrl(url: string, tabId: number): string;
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  now?(): number;
}

export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  documentLifecycle?: string;
  timeStamp?: number;
}

/**
 * Domain rules (Firefox "Always open in" / "Ask"): when the main frame of a tab starts a navigation to a site that has
 * a rule, move the tab into the right container (the address is opened in a fresh tab of the container and the old
 * tab is closed, like Firefox's Multi-Account Containers: a tab that stays alive keeps its `window.opener`, and the
 * opener could then read the container's cookies and storage) or send it to the choose page.
 *
 * Loop safety: the new tab is placed in the container before it navigates, so its navigation finds it in the right
 * container (decision "none"); every deliberate placement exempts the next navigation (see `Exemptions`); and a
 * per-tab action limit, whose history the new tab inherits, stops anything else. The first request, the one that triggered the rule, has already left as the real profile
 * (docs/limits.md).
 */
export class DomainRuleEngine {
  private readonly actions = new Map<number, number[]>();
  private readonly children = new Map<number, { container: ContainerId; at: number }>();
  private readonly now: () => number;

  constructor(
    private readonly exemptions: ExemptionManager,
    private readonly deps: RuleEngineDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** A page of a container tab opened `child`: the engine's own copy of the inheritance, to close the race with it. */
  noteChildOfContainerTab(child: number, parent: number): void {
    const container = this.deps.containerOf(parent);
    if (container !== null) this.children.set(child, { container, at: this.now() });
  }

  forgetTab(tabId: number): void {
    this.actions.delete(tabId);
    this.children.delete(tabId);
  }

  async handleBeforeNavigate(details: NavigationDetails): Promise<'moved' | 'asked' | 'skipped'> {
    const { tabId, frameId, url } = details;
    if (tabId < 0 || frameId !== 0 || details.documentLifecycle === 'prerender' || !isHttpUrl(url)) return 'skipped';
    const site = ruleKeyOf(url);
    if (site === null) return 'skipped';

    // An explicit `#ctr=` marker SplitSession honours wins over any rule, now and for the navigation SplitSession repeats without
    // it. A marker SplitSession ignores is just part of the URL.
    if (hasCtrMarker(url)) {
      const container = await this.deps.markerContainer(details);
      if (container !== null) {
        this.exemptions.markPlacement(tabId, container);
        return 'skipped';
      }
    }

    const current = this.deps.containerOf(tabId);
    const child = this.children.get(tabId);
    if (child) {
      if (this.now() - child.at > CHILD_GRACE_MS) this.children.delete(tabId);
      // A tab opened by a container page is its parent's business for its first moments (OAuth popups!): while it is
      // being assigned the parent's container (the registry already says so before the placement event fires) and
      // while it keeps it, it is not judged. Moved elsewhere in the meantime, it is a tab like any other.
      else if (current === null || current === child.container) return 'skipped';
    }

    const exempt = this.exemptions.check(tabId, current, site);
    const rule = findRule(this.deps.rules(), url);
    if (!rule || exempt) return 'skipped';
    const decision = decideRule(rule, current);
    if (decision.kind === 'none') return 'skipped';
    if (!this.allowAction(tabId)) {
      this.deps.log('warn', `domain rules: too many actions on tab ${tabId}, leaving it alone`, url);
      return 'skipped';
    }

    if (decision.kind === 'ask') {
      this.deps.log('info', `domain rule: ask for ${site} in tab ${tabId}`);
      await this.deps.navigate(tabId, this.deps.chooseUrl(url, tabId));
      return 'asked';
    }

    this.deps.log('info', `domain rule: ${site} -> ${decision.containerId} in tab ${tabId}`);
    const history = this.actions.get(tabId) ?? [];
    await this.deps.replaceTab(tabId, decision.containerId, url, (newTabId) => {
      // The repeated navigation is the placement's own: it must not be judged again. The new tab carries the old
      // one's action history, or a chain of client-side redirects between ruled sites would never meet the limit.
      this.exemptions.markSite(newTabId, decision.containerId, site);
      this.actions.set(newTabId, [...history]);
    });
    return 'moved';
  }

  private allowAction(tabId: number): boolean {
    const now = this.now();
    const recent = (this.actions.get(tabId) ?? []).filter((t) => now - t < ACTION_WINDOW_MS);
    if (recent.length >= ACTION_LIMIT) {
      this.actions.set(tabId, recent);
      return false;
    }
    recent.push(now);
    this.actions.set(tabId, recent);
    return true;
  }
}
