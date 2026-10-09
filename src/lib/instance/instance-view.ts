/**
 * What the research app says about the organisation behind the signed-in
 * account: its name beside the wordmark and in the account menu, its contact
 * details in Help and Settings, and the note in the "New study" chooser. Pure
 * functions over the cleaned snapshot, so the wording and the rules for leaving
 * a line out are unit-tested without a screen.
 *
 * `instance` is always the value `useInstance` holds: `null` for a guest, for a
 * build with no backend and before anything was fetched, which is stock Scholea.
 * The product keeps its own name throughout; the organisation's name goes
 * beside it and never replaces it.
 */
import { STUDY_CONFIGS } from "@/lib/study/registry";
import { safeMailto, type PublicInstance } from "./sanitize";
import { effectiveAllowList } from "./study-types";

/** The organisation's name, or empty when none is set. */
export function orgNameOf(instance: PublicInstance | null): string {
  return instance?.orgName ?? "";
}

// --- Account menu ----------------------------------------------------------------

/** The line under the person's name in the account menu. `null` when no name is set. */
export function signedInLine(instance: PublicInstance | null): string | null {
  const name = orgNameOf(instance);
  return name ? `Signed in to ${name}` : null;
}

export const SUPPORT_ITEM_LABEL = "Contact support";

// --- Contact details ---------------------------------------------------------------

/** A support address and the only link that may be made from it. */
export interface SupportContact {
  email: string;
  /** A `mailto:` link from `safeMailto`. */
  href: string;
}

/** The support address as a link, or `null` when there is none that can be one. */
export function supportContact(instance: PublicInstance | null): SupportContact | null {
  const email = instance?.supportEmail ?? "";
  const href = email ? safeMailto(email) : null;
  return href ? { email, href } : null;
}

/** What the organisation gave for getting in touch. */
export interface ContactView {
  /** Empty when none is set. */
  orgName: string;
  support: SupportContact | null;
  /** Plain text, possibly a few lines. Empty when none is set. */
  contact: string;
}

/**
 * Everything "About this workspace" shows, or `null` when the organisation set
 * none of it: the section is then left out altogether.
 */
export function contactView(instance: PublicInstance | null): ContactView | null {
  const view: ContactView = {
    orgName: orgNameOf(instance),
    support: supportContact(instance),
    contact: instance?.footerContact ?? "",
  };
  return view.orgName || view.support || view.contact ? view : null;
}

/**
 * The same for the bottom of the User Guide, which shows only how to get in
 * touch: `null` when there is neither a support address nor a contact line.
 */
export function helpContact(instance: PublicInstance | null): ContactView | null {
  const view = contactView(instance);
  return view && (view.support || view.contact) ? view : null;
}

/** What the bar at the bottom of the User Guide is called for a screen reader. */
export const HELP_CONTACT_LABEL = "Contact for this workspace";

/** The sentence in front of the support address. The address follows it as a link. */
export function supportLead(orgName: string): string {
  return `Questions about your account or this workspace? Contact ${orgName || "your administrator"}:`;
}

export const ABOUT_HEADING = "About this workspace";
export const ABOUT_CAPTION = "Provided by your organisation's Scholea administrator.";
export const ABOUT_LABEL = { orgName: "Organisation", support: "Support", contact: "Contact" } as const;

// --- "New study" chooser -------------------------------------------------------------

/** Every study type this version of the app can run, by registry id. */
const KNOWN_STUDY_TYPES: readonly string[] = STUDY_CONFIGS.map((config) => config.id);

/**
 * The study types a new project may be started with, or `null` for all of them:
 * a guest, an organisation that set no list, and a list that names nothing this
 * version knows. It limits new projects only. Existing ones keep working.
 */
export function newStudyAllowList(instance: PublicInstance | null): ReadonlySet<string> | null {
  return effectiveAllowList(instance?.enabledStudyTypes ?? null, KNOWN_STUDY_TYPES);
}

/** The note in the chooser while the list is limited. `null` when it is not. */
export function chooserNote(instance: PublicInstance | null): string | null {
  const allow = newStudyAllowList(instance);
  if (allow === null) return null;
  const who = orgNameOf(instance) || "Your organisation";
  return `${who} has made ${allow.size} of ${KNOWN_STUDY_TYPES.length} study types available for new projects. Existing projects are not affected.`;
}
