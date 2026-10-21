// Fails when the Lite build contains anything of the Full edition's agent side: bridge / CDP markers in any shipped
// file, the three forbidden permissions in the manifest. Run by `pnpm build:lite` and `pnpm zip:lite`
// (and CI). The lists are deliberately written out here, not derived from wxt.config.ts: a check that reads the same
// source as the build cannot catch a mistake in it.
//
//   node scripts/check-lite.mjs [dir]        (default .output/lite/chrome-mv3)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.resolve(root, process.argv[2] ?? ".output/lite/chrome-mv3");

// The only extension IDs a copy may answer and ping (src/core/copies.ts), written out here on purpose: the Lite manifest's
// `externally_connectable` must be exactly this list, so a test hook (FACET_TEST_COPY_IDS) cannot leak into a release.
const COPY_IDS = [
  "hapfikidacgfgnnajkgnaednpgnhmffk", // Full
  "hhodioekcdmhpocjbkjnblmbmchddphf", // Lite on the Chrome Web Store
];
const FORBIDDEN_PERMISSIONS = ["nativeMessaging", "debugger", "userScripts"];
// [label, regex]: any hit in any text file of the bundle fails the check.
const MARKERS = [
  ["connectNative", /connectNative/],
  ["sendNativeMessage", /sendNativeMessage/],
  ["chrome.debugger / debugger API", /\.debugger\b|["'`]debugger["'`]/],
  ["CDP Input.dispatch* (Input.dispatchMouseEvent, ...)", /Input\.dispatch/],
  ["CDP Accessibility domain", /Accessibility\.(?:enable|getFullAXTree)/],
  ["CDP Page.captureScreenshot", /Page\.captureScreenshot/],
  ["CDP Runtime.evaluate", /Runtime\.evaluate/],
  ["CDP DOM.setFileInputFiles", /DOM\.setFileInputFiles/],
  ["native host name com.splitsession.bridge", /com\.splitsession\.bridge/],
  ["old native host name com.facet.bridge", /com\.facet\.bridge/],
  // Any native host name the bridge could be renamed to: `com.<vendor>.bridge`.
  ["native host name (com.<vendor>.bridge)", /["'`]com\.[\w-]+\.bridge["'`]/],
  // Bridge tool identifiers (src/bridge/spec.ts), as a bare word: quoted, an object key, or in a message.
  [
    "agent tool name (run_js / screenshot_tab / open_in_container / ...)",
    /\b(?:run_js|screenshot_tab|open_in_container|get_tab_html|get_tab_text|handle_dialog|resize_viewport|select_option|network_requests|console_messages)\b/,
  ],
  ["nativeMessaging", /nativeMessaging/],
  ["userScripts", /userScripts/],
  ["agent tool spec (bridge_info)", /bridge_info/],
  ["agent bridge setting", /agentBridge|agentActivity/],
  [
    "page-name settings (showNameToPages / titlePrefix)",
    /showNameToPages|titlePrefix/,
  ],
  ["data-ctr page marker", /data-ctr|dataset\.ctr/],
  ["agent bridge card styles", /fx-bridge/],
  ["CDP debugging handle (facetCdp)", /facetCdp/],
];
const TEXT = /\.(?:js|mjs|html|css|json|map|txt)$/;

const problems = [];
const walk = (d) =>
  readdirSync(d).flatMap((name) => {
    const p = path.join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

if (!existsSync(dir)) {
  console.error(
    `check-lite: ${path.relative(root, dir)} does not exist (build it first: pnpm build:lite)`,
  );
  process.exit(1);
}

const files = walk(dir);
let bytes = 0;
for (const file of files) {
  const rel = path.relative(dir, file);
  bytes += statSync(file).size;
  if (!TEXT.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const [label, re] of MARKERS) {
    const m = re.exec(text);
    if (m)
      problems.push(
        `${rel}: ${label} (…${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, " ")}…)`,
      );
  }
}

const manifestPath = path.join(dir, "manifest.json");
if (!existsSync(manifestPath)) problems.push("manifest.json is missing");
else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const field of ["permissions", "optional_permissions"]) {
    for (const permission of manifest[field] ?? [])
      if (FORBIDDEN_PERMISSIONS.includes(permission))
        problems.push(`manifest ${field}: "${permission}" is Full-only`);
  }
  if ("key" in manifest)
    problems.push(
      'manifest has a "key": Lite must not pin an extension ID (the Web Store assigns its own)',
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
    `check-lite: FAILED, the Lite bundle in ${path.relative(root, dir)} is not clean:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-lite: OK, ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, no bridge / CDP markers, no nativeMessaging / debugger / userScripts`,
);
