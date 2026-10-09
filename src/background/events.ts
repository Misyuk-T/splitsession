import type { Container, ContainerId } from '../core';

/** What the engine tells the Stage C modules (tab groups, badges, domain rules). Emitted by `Facet`. */
export type FacetEvent =
  | { type: 'tab-assigned'; tabId: number; containerId: ContainerId }
  /** Also emitted when a tab is closed; the tab may already be gone. */
  | { type: 'tab-unassigned'; tabId: number; containerId: ContainerId }
  | { type: 'tab-replaced'; added: number; removed: number }
  | { type: 'container-updated'; container: Container; renamed: boolean; recolored: boolean }
  | { type: 'container-deleted'; id: ContainerId };

export type FacetEventListener = (event: FacetEvent) => void;

/** Synchronous fan-out. A listener that throws never affects the engine or the other listeners. */
export class FacetEvents {
  private readonly listeners = new Set<FacetEventListener>();

  on(listener: FacetEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: FacetEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[facet] event listener failed', error);
      }
    }
  }
}
