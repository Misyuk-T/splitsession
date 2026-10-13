/**
 * Edition flag, replaced by the bundler at build time (`define` in wxt.config.ts; `vitest.config.ts` for unit tests).
 * `true`: Full (agent bridge, agent activity, page-name features). `false`: Lite, where every
 * `if (__FULL__)` branch and the modules only those branches use are removed from the bundle.
 */
declare const __FULL__: boolean;
