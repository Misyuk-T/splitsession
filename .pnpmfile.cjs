// TypeScript 7 (the native compiler) ships no JavaScript compiler API, which typescript-eslint needs to parse code.
// `tsc` and the type-check stay on TypeScript 7; the lint tooling gets its own private TypeScript 5.x through this hook
// (docs/decisions.md, "Lint and format"). Drop the hook when typescript-eslint supports TypeScript 7.
const LINT_TYPESCRIPT = "npm:typescript@5.9.3";
const LINT_PACKAGES =
  /^(@typescript-eslint\/|eslint-plugin-import$|eslint-module-utils$|eslint-import-resolver-typescript$|eslint-config-airbnb-typescript$|ts-api-utils$)/;

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (!LINT_PACKAGES.test(pkg.name)) return pkg;
      const mentionsTypescript = [
        pkg.peerDependencies,
        pkg.peerDependenciesMeta,
        pkg.dependencies,
        pkg.optionalDependencies,
      ].some((field) => field && "typescript" in field);
      if (!mentionsTypescript) return pkg;
      for (const field of [
        pkg.peerDependencies,
        pkg.peerDependenciesMeta,
        pkg.optionalDependencies,
      ])
        if (field) delete field.typescript;
      pkg.dependencies = { ...pkg.dependencies, typescript: LINT_TYPESCRIPT };
      return pkg;
    },
  },
};
