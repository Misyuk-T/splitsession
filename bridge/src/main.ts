import { runHost } from './host';
import { runMcp } from './mcp';

declare const __VERSION__: string;

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'host') {
  void runHost(rest);
} else if (mode === 'mcp') {
  void runMcp().catch((error) => {
    process.stderr.write(`facet mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else if (mode === '--version' || mode === 'version') {
  process.stdout.write(`${__VERSION__}\n`);
} else {
  process.stderr.write('usage: facet-bridge.mjs host|mcp\n  host  launched by Chrome (Native Messaging)\n  mcp   stdio MCP server for an AI agent\n');
  process.exit(2);
}
