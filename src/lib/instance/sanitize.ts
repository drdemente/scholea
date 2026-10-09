/**
 * The gate every instance setting passes before it reaches the interface or a
 * stylesheet, whether it just arrived from the backend or was read back from
 * this device. The settings are written by an organisation's administrator and
 * shown to everyone signed in there, so nothing is trusted as it comes: text is
 * cleaned and capped, and an accent colour, support address or study-type id
 * that is not exactly what it should be is dropped.
 *
 * Pure functions. The rules for when a snapshot exists at all live here too:
 * the instance snapshot exists on a device if and only if an account is signed
 * in on it. A guest has no relationship with the instance, so no request is
 * made on their behalf and no instance policy applies to them.
 */
import type { SessionPhase } from "@/lib/account/types";
import { parseHexColor } from "./accent";

export type { SessionPhase };

/** The public settings of the instance this build talks to, after cleaning. */
export interface PublicInstance {
  /** The organisation's name. Empty when none was set. */
  orgName: string;
  /** A plain email address, or empty. */
  supportEmail: string;
  /** Plain text, possibly a few lines. Never HTML or Markdown. Empty when none. */
  footerContact: string;
  /** Lower-case `#rrggbb`, or empty for the stock palette. */
  accent: string;
  /** Study-type ids offered for new projects. `null` means every type. */
  enabledStudyTypes: string[] | null;
}

// Limits, matching what the backend accepts (counted in characters, as there).
export const ORG_NAME_MAX = 200;
export const SUPPORT_EMAIL_MAX = 320;
export const FOOTER_CONTACT_MAX = 500;
export const FOOTER_CONTACT_MAX_LINES = 8;
export const STUDY_TYPES_MAX = 100;

/** How often a signed-in app asks again when it comes online or back into view. */
export const REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * The backend's own default for the organisation name is the product name,
 * which says nothing about the organisation. It counts as "no name set".
 */
const PRODUCT_NAME = "scholea";

const KEYS = ["orgName", "supportEmail", "footerContact", "accent", "enabledStudyTypes"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Text ----------------------------------------------------------------------

/** Line and paragraph breaks in all their spellings. */
const BREAKS = /\r\n?|[\u2028\u2029]/g;
/**
 * Control characters, and the characters that embed, override or isolate text
 * direction. None belongs in a name or a contact line, and the direction ones
 * can make text read differently from what was typed. Tab and line feed are
 * handled separately.
 */
const UNWANTED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Half of a character that needs two code units, left on its own. */
const BROKEN = /[\ud800-\udfff]/gu;

/** Keep at most `max` characters, never cutting one in half. */
function capTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
}

/** One line of plain text: breaks become spaces, runs of space collapse. */
function singleLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Far more than the backend would ever store: only there to bound the work.
  const text = value.slice(0, max * 8);
  return capTo(text.replace(BREAKS, " ").replace(UNWANTED, "").replace(BROKEN, "").replace(/\s+/g, " ").trim(), max);
}

/** A few lines of plain text: lines are trimmed and blank runs collapse to one. */
function fewLines(value: unknown, max: number, maxLines: number): string {
  if (typeof value !== "string") return "";
  const lines = value
    .slice(0, max * 8)
    .replace(BREAKS, "\n")
    .replace(UNWANTED, "")
    .replace(BROKEN, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());

  const kept: string[] = [];
  for (const line of lines) {
    const blank = line === "";
    // No blank line first, and never two in a row.
    if (blank && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    if (kept.length < maxLines) kept.push(line);
    // Past the limit nothing is thrown away: the rest joins the last line.
    else if (!blank) kept[kept.length - 1] = `${kept[kept.length - 1]} ${line}`.trim();
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return capTo(kept.join("\n"), max);
}

// --- Email ---------------------------------------------------------------------

/**
 * A plain address: the pattern browsers use for an email field, plus a dot in
 * the domain. No display name, no angle brackets, no list, nothing but ASCII.
 */
const PLAIN_ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function plainAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (address === "" || address.length > SUPPORT_EMAIL_MAX) return null;
  return PLAIN_ADDRESS.test(address) ? address : null;
}

/**
 * A `mailto:` link for an address, or `null` unless it is a plain address. The
 * part before the `@` is percent-encoded, so an address can never add a
 * subject, a body or further recipients to the link.
 */
export function safeMailto(email: string): string | null {
  const address = plainAddress(email);
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return `mailto:${encodeURIComponent(address.slice(0, at))}@${address.slice(at + 1)}`;
}

// --- Study types ---------------------------------------------------------------

const STUDY_TYPE_ID = /^[a-z0-9-]{1,64}$/;

/** The well-formed ids, once each, in order. `null` (every type) when none is. */
function studyTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  const end = Math.min(value.length, STUDY_TYPES_MAX * 10);
  for (let i = 0; i < end && ids.length < STUDY_TYPES_MAX; i += 1) {
    const id: unknown = value[i];
    if (typeof id === "string" && STUDY_TYPE_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

// --- The gate ------------------------------------------------------------------

/**
 * Clean a settings record. Text is trimmed and capped; an accent that is not a
 * hex colour, a support address that is not a plain address, and study-type
 * ids that are not well formed are dropped. `null` when `raw` is not a settings
 * record at all, so a bad answer never replaces a good snapshot.
 *
 * Cleaning something already clean changes nothing.
 */
export function sanitizeInstance(raw: unknown): PublicInstance | null {
  if (!isRecord(raw)) return null;
  if (!KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) return null;

  const orgName = singleLine(raw.orgName, ORG_NAME_MAX);
  return {
    orgName: orgName.toLowerCase() === PRODUCT_NAME ? "" : orgName,
    supportEmail: plainAddress(raw.supportEmail) ?? "",
    footerContact: fewLines(raw.footerContact, FOOTER_CONTACT_MAX, FOOTER_CONTACT_MAX_LINES),
    accent: parseHexColor(raw.accent) ?? "",
    enabledStudyTypes: studyTypes(raw.enabledStudyTypes),
  };
}

/**
 * The snapshot the app may act on. A cached snapshot counts only while someone
 * is signed in or a saved session is still being checked; a guest and a build
 * with no backend always get `null`, which is stock Scholea.
 */
export function resolveInstance(phase: SessionPhase, cached: PublicInstance | null): PublicInstance | null {
  return phase === "loading" || phase === "ready" ? cached : null;
}

/**
 * Whether to ask the backend for the settings now. Never in a build with no
 * backend, never for a guest, never while offline. Otherwise at most once per
 * `REFRESH_INTERVAL_MS`, unless `force` is set (signing in, and starting the
 * app already signed in). `fetchedAt` is 0 when nothing was fetched yet.
 */
export function shouldRefresh(i: {
  phase: SessionPhase;
  configured: boolean;
  online: boolean;
  now: number;
  fetchedAt: number;
  force?: boolean;
}): boolean {
  if (!i.configured || i.phase !== "ready" || !i.online) return false;
  if (i.force) return true;
  // Nothing fetched yet, or the clock went backwards: treat as stale.
  if (!(i.fetchedAt > 0) || i.fetchedAt > i.now) return true;
  return i.now - i.fetchedAt >= REFRESH_INTERVAL_MS;
}
