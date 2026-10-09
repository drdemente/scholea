import { create } from "zustand";
import type { CollaboratorRole } from "@/lib/db/schema";

/**
 * The local collaborator identity — who "you" are for attribution in the
 * contribution ledger, comments, and supervisor sign-offs. Works fully offline
 * (no account needed). Signing in to an account fills in the name from that
 * account, and signing out blanks it (see `resetIdentity`).
 * Persisted to localStorage so attribution survives reloads.
 */
const KEY = "scholea.identity";

interface Stored {
  name: string;
  role: CollaboratorRole;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    /* ignore */
  }
  return { name: "", role: "researcher" };
}

interface IdentityState {
  name: string;
  role: CollaboratorRole;
  setName: (name: string) => void;
  setRole: (role: CollaboratorRole) => void;
  /** True once the user has named themselves (needed to attribute work). */
  isSet: () => boolean;
}

export const useIdentity = create<IdentityState>((set, get) => {
  const initial = read();
  const persist = (s: Stored) => localStorage.setItem(KEY, JSON.stringify(s));
  return {
    name: initial.name,
    role: initial.role,
    setName: (name) => {
      set({ name });
      persist({ name, role: get().role });
    },
    setRole: (role) => {
      set({ role });
      persist({ name: get().name, role });
    },
    isSet: () => get().name.trim() !== "",
  };
});

/**
 * Blank the local identity (name and role). Used when the account that seeded
 * it signs out, so nothing carries over to whoever uses this device next.
 */
export function resetIdentity(): void {
  useIdentity.setState({ name: "", role: "researcher" });
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Actor label for the audit log — the identity name, or a sensible default. */
export function actorName(): string {
  const n = useIdentity.getState().name.trim();
  return n || "local";
}
