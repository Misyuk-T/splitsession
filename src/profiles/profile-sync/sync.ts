/**
 * Profile Manager — Future Synchronization Interfaces (AEGOX_multisession).
 *
 * This file defines the boundary a future cross-device sync module will use.
 * It deliberately implements NO network transport and NO cloud storage:
 * local `chrome.storage.local` remains the primary source of profile data.
 *
 * The snapshot type reuses the profile export format, so a future provider can
 * never send more than the export allows (no cookies, tokens or passwords).
 *
 * Pure TypeScript: no `fetch`, no `chrome.*`.
 *
 * Derived from SplitSession's export/import pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type {
  ProfileExportPackage,
} from "../profile-import-export/backup";
import {
  createProfileExportPackage,
  validateProfileExportPackage,
} from "../profile-import-export/backup";
import type { Profile, ProfileFolder } from "../profile-manager/profile";

/** Schema version of a sync snapshot (independent from the export version). */
export const PROFILE_SNAPSHOT_VERSION = 1;

/** A snapshot exchanged with a future sync provider. */
export interface ProfileSnapshot {
  schema: "aegox-multisession-profile-snapshot";
  schemaVersion: number;
  /** Monotonic local revision (0 when never synchronized). */
  revision: number;
  generatedAt: number;
  /** Same safe export payload used by manual export. */
  data: ProfileExportPackage;
}

/** Result of a provider pull. */
export interface SyncPullResult {
  snapshot: ProfileSnapshot | null;
  /** Server-side revision, when the provider exposes one. */
  remoteRevision: string | null;
}

/** Result of a provider push. */
export interface SyncPushResult {
  ok: boolean;
  remoteRevision: string | null;
  /** True when the provider rejected the push because it is newer remotely. */
  conflict: boolean;
  message?: string;
}

/** Provider capabilities; a future implementation must state what it supports. */
export interface SyncCapabilities {
  /** False until a real provider is implemented. */
  implemented: boolean;
  /** Whether the provider can merge rather than overwrite. */
  supportsMerge: boolean;
  /** Whether the provider stores data encrypted with a user-held key. */
  endToEndEncryption: boolean;
}

/**
 * Interface a future sync transport implements. Implementations are expected to
 * be added in a later module; none is included in this build.
 */
export interface ProfileSyncProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: SyncCapabilities;
  pull(since: string | null): Promise<SyncPullResult>;
  push(snapshot: ProfileSnapshot, remoteRevision: string | null): Promise<SyncPushResult>;
}

/** State exposed to the UI. */
export type SyncStatus =
  | "not-configured"
  | "local-only"
  | "disabled"
  | "conflict"
  | "error";

/** The default provider: makes the absence of sync explicit. */
export class NoopProfileSyncProvider implements ProfileSyncProvider {
  readonly id = "none";
  readonly label = "This device only";
  readonly capabilities: SyncCapabilities = {
    implemented: false,
    supportsMerge: false,
    endToEndEncryption: false,
  };

  async pull(): Promise<SyncPullResult> {
    return { snapshot: null, remoteRevision: null };
  }

  async push(): Promise<SyncPushResult> {
    return {
      ok: false,
      remoteRevision: null,
      conflict: false,
      message:
        "Cross-device synchronization is not implemented in this version. Profile data stays on this device.",
    };
  }
}

/**
 * Builds snapshots and validates incoming ones. Even when a provider is added,
 * local data remains authoritative until the user accepts a merge.
 */
export class ProfileSyncCoordinator {
  private revision = 0;
  private status: SyncStatus = "not-configured";
  private readonly now: () => number;

  constructor(
    private readonly provider: ProfileSyncProvider = new NoopProfileSyncProvider(),
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Current status. Never claims sync is active when it is not. */
  getStatus(): SyncStatus {
    if (!this.provider.capabilities.implemented) {
      return this.provider.id === "none" ? "not-configured" : "disabled";
    }
    return this.status;
  }

  /** Returns the provider's self-description (no secrets). */
  describeProvider(): { id: string; label: string; capabilities: SyncCapabilities } {
    return {
      id: this.provider.id,
      label: this.provider.label,
      capabilities: { ...this.provider.capabilities },
    };
  }

  /** Builds a snapshot from local data, using the safe export format. */
  createSnapshot(
    profiles: readonly Profile[],
    folders: readonly ProfileFolder[] = [],
  ): ProfileSnapshot {
    const data = createProfileExportPackage(profiles, folders, { now: this.now });
    return {
      schema: "aegox-multisession-profile-snapshot",
      schemaVersion: PROFILE_SNAPSHOT_VERSION,
      revision: this.revision,
      generatedAt: this.now(),
      data,
    };
  }

  /**
   * Validates a remote snapshot. Returns the validation errors; the caller must
   * ask the user before applying anything to local data.
   */
  validateSnapshot(raw: unknown): { valid: boolean; errors: string[] } {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as Record<string, unknown>).schema !==
        "aegox-multisession-profile-snapshot" ||
      (raw as Record<string, unknown>).schemaVersion !== PROFILE_SNAPSHOT_VERSION
    ) {
      return { valid: false, errors: ["Unsupported snapshot format or version."] };
    }
    const validation = validateProfileExportPackage(
      (raw as Record<string, unknown>).data,
    );
    return { valid: validation.valid, errors: validation.errors };
  }

  /** Records a successful sync revision (used by a future provider). */
  markSynced(revision: number): void {
    this.revision = Math.max(this.revision, revision);
    this.status = "local-only";
  }
}
