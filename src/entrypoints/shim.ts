import { runShim } from '../content/shim.main';

/** Built to /shim.js; registered at runtime (MAIN world, document_start, after the beacon). */
export default defineUnlistedScript(() => {
  runShim();
});
