// Fails when the Chrome Web Store package of Full is not what the store item may receive: a `key` (the store rejects it,
// and it would also mean a test key leaked in), the Full edition's name, a required permission beyond Lite's (the update
// from Lite would disable the extension: `debugger` and `nativeMessaging` must not be in `permissions`; `nativeMessaging`
// must be optional), DevTools-protocol code in the bundle (basic mode has none), a copy-ID list other than the two known
// IDs, or a bundle without the agent bridge and its consent gate. Run by `pnpm build:store` and
// `pnpm zip:store` (and CI). The values are written out here, not derived from wxt.config.ts: a check that reads the same
// source as the build cannot catch a mistake in it.
//
//   node scripts/check-store.mjs [dir]        (default .output/store/chrome-mv3)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.resolve(root, process.argv[2] ?? ".output/store/chrome-mv3");

const NAME = "SplitSession: Multiple Logins per Site";
// The only extension IDs a copy may answer and ping (src/core/copies.ts): exactly these, so a test hook
// (FACET_TEST_COPY_IDS) cannot leak into a release.
const COPY_IDS = [
  "hapfikidacgfgnnajkgnaednpgnhmffk", // Full, unpacked (pinned key)
  "hhodioekcdmhpocjbkjnblmbmchddphf", // the Chrome Web Store item
];
// The permission increase over Lite 0.1.x that would disable the store item on update (docs/decisions.md, "The store item
// becomes Full"). `debugger` cannot be optional, so basic mode has none; `nativeMessaging` is asked for at runtime.
const FORBIDDEN_REQUIRED_PERMISSIONS = ["nativeMessaging", "debugger"];
const OPTIONAL_PERMISSIONS = ["nativeMessaging"];
// Removed 2026-10-13 (docs/decisions.md); must not come back unnoticed in the store package.
const FORBIDDEN_PERMISSIONS = ["userScripts", "management", "debugger"];
// [label, regex]: each must occur in some text file of the bundle.
const REQUIRED_MARKERS = [
  // The consent record (src/core/bridge-consent.ts): without it the switch could turn on without the disclosure.
  ["agent bridge consent key (agentBridgeConsent)", /agentBridgeConsent/],
  ["agent bridge disclosure (Allow agent access)", /Allow agent access/],
  ["native host name com.splitsession.bridge", /com\.splitsession\.bridge/],
];
// [label, regex]: none may occur in any text file of the bundle (same list as scripts/check-lite.mjs): the DevTools-protocol
// code is not in the store build.
const CDP_MARKERS = [
  ["chrome.debugger / debugger API", /\.debugger\b|["'`]debugger["'`]/],
  ["CDP Input.dispatch* (Input.dispatchMouseEvent, ...)", /Input\.dispatch/],
  ["CDP Accessibility domain", /Accessibility\.(?:enable|getFullAXTree)/],
  ["CDP Page.captureScreenshot", /Page\.captureScreenshot/],
  ["CDP Page history (getNavigationHistory)", /Page\.getNavigationHistory/],
  ["CDP Runtime.evaluate", /Runtime\.evaluate/],
  ["CDP DOM.setFileInputFiles", /DOM\.setFileInputFiles/],
  ["CDP debugging handle (facetCdp)", /facetCdp/],
  // The e2e hook that pretends the worker predates the nativeMessaging grant (FACET_TEST_GRANT_NM builds only).
  [
    "test hook (__facetTestNmHidden, facetNativeRestart)",
    /__facetTestNmHidden|facetNativeRestart/,
  ],
];
const TEXT = /\.(?:js|mjs|html|css|json|txt)$/;

const problems = [];
const walk = (d) =>
  readdirSync(d).flatMap((name) => {
    const p = path.join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (!existsSync(dir)) {
  console.error(
    `check-store: ${path.relative(root, dir)} does not exist (build it first: pnpm build:store)`,
  );
  process.exit(1);
}

const files = walk(dir);
let bytes = 0;
const found = new Set();
for (const file of files) {
  bytes += statSync(file).size;
  if (file.endsWith(".map"))
    problems.push(`${path.relative(dir, file)}: source map in the package`);
  if (!TEXT.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const [label, re] of REQUIRED_MARKERS)
    if (re.test(text)) found.add(label);
  for (const [label, re] of CDP_MARKERS) {
    const m = re.exec(text);
    if (m)
      problems.push(
        `${path.relative(dir, file)}: ${label} (…${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, " ")}…)`,
      );
  }
}
for (const [label] of REQUIRED_MARKERS)
  if (!found.has(label)) problems.push(`bundle lacks the ${label}`);

const manifestPath = path.join(dir, "manifest.json");
if (!existsSync(manifestPath)) problems.push("manifest.json is missing");
else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if ("key" in manifest)
    problems.push(
      'manifest has a "key": the Web Store rejects it and assigns the item\'s own ID (a test key, FACET_TEST_KEY, must never reach a store build)',
    );
  if (manifest.name !== NAME)
    problems.push(
      `manifest name must be ${JSON.stringify(NAME)}, got ${JSON.stringify(manifest.name)}`,
    );
  if (/\(Full\)/i.test(`${manifest.name} ${manifest.short_name ?? ""}`))
    problems.push('manifest name or short_name says "(Full)"');
  if (
    typeof manifest.description !== "string" ||
    manifest.description.length > 132
  )
    problems.push("manifest description is missing or over 132 characters");
  const permissions = manifest.permissions ?? [];
  for (const permission of FORBIDDEN_REQUIRED_PERMISSIONS)
    if (permissions.includes(permission))
      problems.push(
        `manifest permissions: "${permission}" must not be required (the update from Lite would disable the extension; the test hook FACET_TEST_GRANT_NM must never reach a store build)`,
      );
  const optional = manifest.optional_permissions ?? [];
  if (
    JSON.stringify([...optional].sort()) !==
    JSON.stringify([...OPTIONAL_PERMISSIONS].sort())
  )
    problems.push(
      `manifest optional_permissions must be exactly [${OPTIONAL_PERMISSIONS.join(", ")}], got ${JSON.stringify(optional)}`,
    );
  for (const field of ["permissions", "optional_permissions"])
    for (const permission of manifest[field] ?? [])
      if (FORBIDDEN_PERMISSIONS.includes(permission))
        problems.push(
          `manifest ${field}: "${permission}" must not be requested`,
        );
  const ec = manifest.externally_connectable;
  if (
    !ec ||
    Object.keys(ec).some((k) => k !== "ids") ||
    !Array.isArray(ec.ids) ||
    JSON.stringify([...ec.ids].sort()) !== JSON.stringify([...COPY_IDS].sort())
  )
    problems.push(
      `manifest "externally_connectable" must be exactly { ids: [${COPY_IDS.join(", ")}] } (no matches), got ${JSON.stringify(ec)}`,
    );
}

if (problems.length > 0) {
  console.error(
    `check-store: FAILED, the store package in ${path.relative(root, dir)} is not ready:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-store: OK, ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, no key, no debugger, nativeMessaging optional only, no CDP code, agent bridge and consent gate present`,
);
