/**
 * Profile Manager — Public entry point (AEGOX_multisession, Module 03).
 *
 * Import from `src/profiles` rather than reaching into subfolders. Every module
 * here is browser-neutral; browser wiring lives in the UI/background layer.
 */

export * from "./profile-manager/profile";
export * from "./profile-manager/profile-manager";
export * from "./profile-association/association";
export * from "./profile-protection/protection";
export * from "./profile-duplicate/duplicate-detector";
export {
  WebsiteRulesManager,
  PROFILE_WEBSITE_RULES_KEY,
  extractDomain,
  domainMatches,
} from "./profile-rules/website-rules";
export type {
  WebsiteCheck,
  WebsiteMode,
  WebsiteRuleAction,
} from "./profile-rules/website-rules";
export * from "./profile-temporary/temporary";
export * from "./profile-import-export/backup";
export * from "./profile-navigation/navigation";
export * from "./profile-stats/stats";
export * from "./profile-lifecycle/deletion";
export * from "./profile-sync/sync";
