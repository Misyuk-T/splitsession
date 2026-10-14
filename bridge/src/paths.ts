import { homedir, platform } from "node:os";
import path from "node:path";

export const HOST_MANIFEST_FILE = "com.splitsession.bridge.json";
export const SOCKET_ENV = "FACET_BRIDGE_SOCKET";
/** Colon-separated directories searched for the host manifest (tests; default: every supported browser). */
export const MANIFEST_DIRS_ENV = "FACET_BRIDGE_MANIFEST_DIRS";

export type BrowserKey = "chrome" | "chromium" | "brave" | "edge" | "arc";
export const BROWSERS: readonly BrowserKey[] = [
  "chrome",
  "chromium",
  "brave",
  "edge",
  "arc",
];

/** Browsers that exist on a platform (Arc is macOS only). */
export const browsersFor = (plat: string = platform()): BrowserKey[] =>
  BROWSERS.filter((b) => b !== "arc" || plat === "darwin");

/**
 * Per-user application data: `~/Library/Application Support` on macOS, the XDG config directory elsewhere
 * (`$XDG_CONFIG_HOME`, else `~/.config`; Chrome itself follows the same variable).
 */
export const appSupport = (
  home: string,
  plat: string = platform(),
  env: NodeJS.ProcessEnv = process.env,
) =>
  plat === "darwin"
    ? path.join(home, "Library", "Application Support")
    : path.join(
        env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
          ? env.XDG_CONFIG_HOME
          : path.join(home, ".config"),
      );

/** Directory of the Unix socket: private to the user (0700). */
export function socketDir(
  home: string = homedir(),
  plat: string = platform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(appSupport(home, plat, env), "SplitSession");
}

/**
 * Where the installer puts the host program Chrome starts. Outside ~/Documents on purpose: macOS asks (or refuses) when
 * a program started by Chrome touches a protected folder such as Documents, Desktop or Downloads, and the host must
 * start silently every time.
 */
export function hostDir(
  home: string = homedir(),
  plat: string = platform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(socketDir(home, plat, env), "host");
}

export function socketPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env[SOCKET_ENV] || path.join(socketDir(home), "bridge.sock");
}

/** `NativeMessagingHosts` directory of a browser, for the current user. */
export function manifestDir(
  browser: BrowserKey,
  home: string = homedir(),
  plat: string = platform(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = appSupport(home, plat, env);
  const rel: Record<BrowserKey, string[]> =
    plat === "darwin"
      ? {
          chrome: ["Google", "Chrome"],
          chromium: ["Chromium"],
          brave: ["BraveSoftware", "Brave-Browser"],
          edge: ["Microsoft Edge"],
          arc: ["Arc", "User Data"],
        }
      : {
          chrome: ["google-chrome"],
          chromium: ["chromium"],
          brave: ["BraveSoftware", "Brave-Browser"],
          edge: ["microsoft-edge"],
          arc: [], // not available outside macOS
        };
  return path.join(base, ...rel[browser], "NativeMessagingHosts");
}

export function manifestSearchDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const override = env[MANIFEST_DIRS_ENV];
  if (override) return override.split(path.delimiter).filter(Boolean);
  return browsersFor().map((b) => manifestDir(b, home, platform(), env));
}
