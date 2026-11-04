/**
 * Edition flag, replaced by the bundler at build time (`define` in wxt.config.ts; `vitest.config.ts` for unit tests).
 * `true`: Full (agent bridge, agent activity, page-name features). `false`: Lite, where every
 * `if (__FULL__)` branch and the modules only those branches use are removed from the bundle.
 */
declare const __FULL__: boolean;

/**
 * `true`: the build contains the DevTools-protocol code ("full hands": trusted input, background screenshots, run_js,
 * console and network capture) and the manifest has `debugger`. `false` in Lite (where `__FULL__` is false too) and in the
 * store build of Full, the agent bridge's "basic mode" (docs/agents.md). Implies `__FULL__`.
 */
declare const __CDP__: boolean;

/**
 * Extra extension IDs the duplicate-copy detection pings and answers (build-time; empty in every release build). Only
 * the e2e spec duplicate-copies.spec.ts sets it, through FACET_TEST_COPY_IDS (wxt.config.ts).
 */
declare const __EXTRA_COPY_IDS__: readonly string[];
