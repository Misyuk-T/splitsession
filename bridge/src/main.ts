import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  install,
  parseArgs,
  resolveClients,
  status,
  uninstall,
  USAGE,
  UsageError,
} from "./cli";
import { runHost } from "./host";
import { runMcp } from "./mcp";

declare const __VERSION__: string;

const [mode, ...rest] = process.argv.slice(2);

if (mode === "host") {
  void runHost(rest);
} else if (mode === "mcp") {
  void runMcp().catch((error) => {
    process.stderr.write(
      `splitsession mcp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
} else if (mode === "--version" || mode === "version" || mode === "-v") {
  process.stdout.write(`${__VERSION__}\n`);
} else if (
  mode === undefined ||
  mode === "--help" ||
  mode === "-h" ||
  mode === "help"
) {
  process.stdout.write(USAGE);
  process.exit(mode === undefined ? 2 : 0);
} else {
  try {
    const options = parseArgs([mode, ...rest]);
    const env = {
      log: (line: string) => process.stdout.write(`${line}\n`),
      sourceEntry: fileURLToPath(import.meta.url),
      version: __VERSION__,
    };
    if (options.command === "install") {
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const rl = interactive
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
      void resolveClients(options, {
        ...env,
        interactive,
        ask: (question) => (rl ? rl.question(question) : Promise.resolve("")),
      })
        .then((clients) => {
          process.exitCode = install({ ...options, clients }, env);
        })
        .finally(() => rl?.close());
    } else if (options.command === "uninstall")
      process.exitCode = uninstall(options, env);
    else
      void status(options, env).then((code) => {
        process.exitCode = code;
      });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`splitsession-bridge: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}
