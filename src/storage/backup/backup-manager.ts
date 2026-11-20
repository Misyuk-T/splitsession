/**
 * Session Core — Backup Manager (AEGOX_multisession).
 *
 * Export/import of session configuration and rules. Normal exports never include
 * cookies, tokens or website credentials. Encrypted backups can include sensitive
 * data when the user opts in.
 *
 * All imported files are validated before any change is made.
 * Format versioning is enforced.
 *
 * Derived from SplitSession's export/import pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

/** Current export format version. */
export const EXPORT_FORMAT_VERSION = 1;

/** Maximum export file size (bytes). */
export const MAX_EXPORT_SIZE = 20 * 1024 * 1024; // 20 MB

/** What an export package contains. */
export interface ExportPackage {
  format: "aegox-multisession-export";
  version: number;
  exportedAt: number;
  /** Session configurations (no cookies, no tokens, no credentials). */
  sessions: Array<{
    id: string;
    name: string;
    domain: string | null;
    profileId: string;
    state: "active" | "paused" | "expired" | "archived" | "closed";
    persistent: boolean;
    restorable: boolean;
  }>;
  /** Persistence settings. */
  persistence: {
    restorationPolicy: "all" | "selected" | "none";
    selectedSessionIds: string[];
    autoRestore: boolean;
  };
  /** Optional: encrypted vault entries (only if user opts in). */
  vaultEntries?: Array<{
    createdAt: number;
    ciphertext: string;
    iv: string;
    version: number;
  }>;
  /** Whether the export includes sensitive vault data. */
  includesSensitiveData: boolean;
}

/** Validation result for an import file. */
export interface ImportValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Preview of what will be imported (before any changes). */
  preview?: {
    sessionsToCreate: number;
    sessionsToUpdate: number;
    sessionsToSkip: number;
    hasVaultData: boolean;
  };
}

/**
 * Validates an exported package before import.
 * Rejects the entire file on the first problem (strict validation).
 */
export function validateExportPackage(raw: unknown): ImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ["Export file must be a JSON object."],
      warnings,
    };
  }

  const pkg = raw as Record<string, unknown>;

  if (pkg.format !== "aegox-multisession-export") {
    errors.push("Unknown export format.");
  }

  if (typeof pkg.version !== "number" || pkg.version !== EXPORT_FORMAT_VERSION) {
    errors.push(
      `Unsupported export version: ${pkg.version}. Expected ${EXPORT_FORMAT_VERSION}.`,
    );
  }

  if (typeof pkg.exportedAt !== "number") {
    errors.push("Missing or invalid exportedAt timestamp.");
  }

  if (!Array.isArray(pkg.sessions)) {
    errors.push("Missing sessions array.");
  } else {
    for (let i = 0; i < pkg.sessions.length; i++) {
      const s = pkg.sessions[i];
      if (typeof s !== "object" || s === null) {
        errors.push(`Session at index ${i} is not an object.`);
        continue;
      }
      const session = s as Record<string, unknown>;
      if (typeof session.id !== "string" || session.id === "") {
        errors.push(`Session at index ${i} missing valid id.`);
      }
      if (typeof session.name !== "string" || session.name === "") {
        errors.push(`Session at index ${i} missing valid name.`);
      }
      if (
        session.state !== undefined &&
        !["active", "paused", "expired", "archived", "closed"].includes(
          session.state as string,
        )
      ) {
        errors.push(`Session at index ${i} has invalid state.`);
      }
    }
  }

  if (pkg.vaultEntries !== undefined) {
    if (!Array.isArray(pkg.vaultEntries)) {
      errors.push("vaultEntries must be an array if present.");
    } else {
      warnings.push(
        "Export contains encrypted vault entries. These will be restored as-is.",
      );
    }
  }

  const valid = errors.length === 0;

  let preview: ImportValidation["preview"] | undefined;
  if (valid && Array.isArray(pkg.sessions)) {
    preview = {
      sessionsToCreate: pkg.sessions.length,
      sessionsToUpdate: 0,
      sessionsToSkip: 0,
      hasVaultData: Boolean(pkg.includesSensitiveData),
    };
  }

  return { valid, errors, warnings, preview };
}

/**
 * Serializes a session list and persistence state into an export package.
 * Never includes raw cookies, tokens or website credentials.
 */
export function createExportPackage(
  sessions: Array<{
    id: string;
    name: string;
    domain: string | null;
    profileId: string;
    state: "active" | "paused" | "expired" | "archived" | "closed";
    persistent: boolean;
    restorable: boolean;
  }>,
  persistence: {
    restorationPolicy: "all" | "selected" | "none";
    selectedSessionIds: string[];
    autoRestore: boolean;
  },
  options: { includeVault?: boolean } = {},
): ExportPackage {
  return {
    format: "aegox-multisession-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: Date.now(),
    sessions,
    persistence,
    includesSensitiveData: options.includeVault === true,
    ...(options.includeVault === true ? { vaultEntries: [] } : {}),
  };
}

/**
 * Parses an export package from a JSON string.
 * Returns the parsed object or throws on invalid JSON.
 */
export function parseExportPackage(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON in export file: ${error}`);
  }
}
