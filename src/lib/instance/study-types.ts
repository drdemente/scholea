/**
 * The organisation's study-type allow-list. It controls what the "New study"
 * chooser offers a signed-in person, and nothing else: existing projects of any
 * type keep opening, editing and syncing, and a guest is offered every type.
 *
 * Ids are plain registry strings. The registry lives in the app, not on the
 * backend, so a list can name ids this version does not know; those are
 * ignored, and a list that names none it knows restricts nothing.
 *
 * Pure functions with no runtime imports, so the offline core can use them
 * without pulling in the account layer.
 */
import type { FamilyGroup } from "@/lib/study/registry";

/**
 * The ids that may be offered, or `null` for "no restriction": when the
 * organisation set no list, when the list names none of the known ids, or when
 * it names all of them.
 */
export function effectiveAllowList(enabled: string[] | null, knownIds: readonly string[]): ReadonlySet<string> | null {
  if (!Array.isArray(enabled)) return null;
  const known = new Set(knownIds);
  const allowed = new Set<string>();
  for (const id of enabled) {
    if (typeof id === "string" && known.has(id)) allowed.add(id);
  }
  if (allowed.size === 0 || allowed.size === known.size) return null;
  return allowed;
}

/** Whether a new project of this type may be started. */
export function isStudyTypeAllowed(id: string, allow: ReadonlySet<string> | null): boolean {
  return allow === null || allow.has(id);
}

/** The chooser's groups with only the allowed types, and no empty family. */
export function filterFamilies(groups: FamilyGroup[], allow: ReadonlySet<string> | null): FamilyGroup[] {
  if (allow === null) return groups;
  return groups
    .map((group) => ({ ...group, configs: group.configs.filter((config) => allow.has(config.id)) }))
    .filter((group) => group.configs.length > 0);
}
