// Static root import uses Pi's official extension loader alias/virtual module,
// so cleanup and the delegated native transport share the SAME SDK cache.
import * as piAi from "@earendil-works/pi-ai";
import { installPiSpeed } from "./pi-speed-runtime.mjs";
export default function stepsembleSpeed(pi) {
  installPiSpeed(pi, { nativeOptions: { cleanupSessionResources: piAi.cleanupSessionResources } });
}
