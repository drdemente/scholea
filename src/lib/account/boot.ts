/**
 * Starts the optional account layer, once, before the first render.
 *
 * The order matters. What the old self-hosted server client left on the device
 * goes first. Then the session starts listening to the backend client. Then
 * sync is tied to the session, so it starts and stops with it from here on,
 * and so do the account screens (someone who still owes a password is asked
 * for it). Last, the organisation's settings start following the session:
 * they exist on the device only while someone is signed in.
 *
 * In a build with no backend every step is inert: no account UI, no request.
 * Nothing here may stop the offline app from starting, so each step is on its
 * own and a failure is swallowed.
 */
import { bindSyncToSession } from "@/lib/collab/project-sync";
import { purgeLegacyKeys } from "@/lib/collab/links";
import { startInstanceSync } from "@/lib/instance/instance-store";
import { bindAuthUiToSession } from "./auth-ui";
import { useSession } from "./session-store";

let started = false;

function attempt(step: () => void): void {
  try {
    step();
  } catch {
    /* the research app works without an account */
  }
}

/** Call once from `main.tsx`, before the app renders. Safe to call again. */
export function initAccount(): void {
  if (started) return;
  started = true;
  attempt(() => purgeLegacyKeys());
  attempt(() => useSession.getState().init());
  attempt(() => bindSyncToSession());
  attempt(() => bindAuthUiToSession());
  // The snapshot kept from the last launch is already in the store, so
  // starting here, before the first render, puts its accent colour on the page
  // from the first frame.
  attempt(() => startInstanceSync());
}
