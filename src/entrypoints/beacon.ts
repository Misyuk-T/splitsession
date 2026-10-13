import { runBeacon } from "../content/beacon.isolated";

/** Built to /beacon.js; registered at runtime (ISOLATED world, document_start) by src/engine/content-scripts.ts. */
export default defineUnlistedScript(() => {
  runBeacon();
});
