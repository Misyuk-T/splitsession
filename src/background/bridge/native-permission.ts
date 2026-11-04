import { browser } from "wxt/browser";

import { NATIVE_MESSAGING } from "../../core/bridge-consent";

type Browser = typeof browser;
type PermissionsApi = Pick<Browser["permissions"], "contains" | "remove">;

/**
 * Whether Chrome has granted `nativeMessaging` (always, for the unpacked Full, which declares it; in the store build only
 * after the user said yes in Chrome's prompt, which the options page raises: src/ui/useBridge.ts). A missing or failing
 * permissions API counts as "not granted".
 */
export async function hasNativeMessaging(
  b: { permissions?: Pick<PermissionsApi, "contains"> } = browser,
): Promise<boolean> {
  try {
    return !!(await b.permissions?.contains({
      permissions: [NATIVE_MESSAGING],
    }));
  } catch {
    return false;
  }
}

/**
 * The bridge went off: give `nativeMessaging` back, so the store build is Lite's permission set again. Only when the manifest
 * lists it as optional (the unpacked Full declares it as required and cannot give it up). Chrome may grant it again without
 * asking, so this is tidiness, not a lock; the settings guard (consent.ts) is what keeps the bridge off.
 */
export async function releaseNativeMessaging(b: {
  permissions?: Pick<PermissionsApi, "remove">;
  runtime: Pick<Browser["runtime"], "getManifest">;
}): Promise<boolean> {
  const optional = b.runtime.getManifest().optional_permissions ?? [];
  if (!(optional as string[]).includes(NATIVE_MESSAGING)) return false;
  try {
    return !!(await b.permissions?.remove({
      permissions: [NATIVE_MESSAGING],
    }));
  } catch {
    return false;
  }
}

/**
 * Chrome took permissions back (the user in chrome://extensions, a policy, or our own `releaseNativeMessaging`). If that was
 * `nativeMessaging` and the bridge is on, it goes off. The grant is looked at again first: our own `remove` after a switch-off,
 * or a quick off and on, may report after the permission was given anew.
 */
export async function handlePermissionRemoved(
  removed: { permissions?: string[] },
  d: {
    bridgeOn(): boolean;
    has(): Promise<boolean>;
    switchOff(): Promise<unknown>;
  },
): Promise<void> {
  if (!removed.permissions?.includes(NATIVE_MESSAGING)) return;
  if (!d.bridgeOn() || (await d.has())) return;
  await d.switchOff();
}
