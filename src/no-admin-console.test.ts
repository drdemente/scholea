import { describe, expect, it } from "vitest";
import guide from "../docs/USER_GUIDE.md?raw";

// The app has no administration screens. Administering an instance means
// calling the backend's admin functions (supabase/), and whoever runs an
// instance does that from a tool of their own, never through this app. So
// nothing under src/ calls one of those functions or an Edge Function, and
// nothing the app ships words an administration screen.
//
// This keeps it that way. A change that brings such a screen or such a call
// back into the app fails here, before it reaches a build.

/** Everything the app ships from src/: its source, without the tests and their helpers. */
const SOURCES = Object.fromEntries(
  Object.entries(import.meta.glob(["./**/*.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>).filter(
    ([file]) => !/\.test\.tsx?$/.test(file) && !file.startsWith("./test/"),
  ),
);

/** The backend's own source, to learn the names of its admin functions from where they are defined. */
const MIGRATIONS = import.meta.glob("../supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every function the backend defines for administrators: `public.admin_*` and `public.master_*`. */
function adminFunctions(sql: string[]): string[] {
  const names = new Set<string>();
  for (const text of sql) {
    for (const m of text.matchAll(/\bfunction\s+public\.((?:admin|master)_[a-z0-9_]+)\s*\(/gi)) names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

/** The words of an administration screen. A build must hold none of them. */
const SCREEN_WORDS = ["Administrator sign-in", "Invite user", "Audit log"];

/** A call to an Edge Function. The app has none: the only Edge Function is the admin one. */
const EDGE_CALL = /\.functions\s*\.\s*invoke\s*\(|functions\/v1\//;

const NAMES = adminFunctions(Object.values(MIGRATIONS));
const byName = new RegExp(`\\b(?:${NAMES.join("|")})\\b`, "g");

/** What a text holds that belongs to administration, as "what: where". */
function findings(file: string, text: string): string[] {
  const found: string[] = [];
  for (const name of text.match(byName) ?? []) found.push(`${file}: ${name}`);
  if (EDGE_CALL.test(text)) found.push(`${file}: a call to an Edge Function`);
  for (const words of SCREEN_WORDS) if (text.includes(words)) found.push(`${file}: "${words}"`);
  return found;
}

describe("the app has no administration screens", () => {
  it("looks at the whole app, and knows the backend's admin functions by name", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain("./App.tsx");
    expect(files).toContain("./lib/account/session-store.ts");
    expect(files).toContain("./features/auth/AccountMenu.tsx");
    expect(files.some((f) => f.includes(".test."))).toBe(false);

    expect(Object.keys(MIGRATIONS).length).toBeGreaterThan(10);
    expect(NAMES.length).toBeGreaterThan(10);
    expect(NAMES).toContain("admin_list_users");
    expect(NAMES).toContain("admin_update_settings");
    expect(NAMES).toContain("master_set_role");
    // A role and an error code are not functions.
    expect(NAMES).not.toContain("master_admin");
    expect(guide.length).toBeGreaterThan(1000);
  });

  it("recognises a call, an Edge Function and a screen when it sees one", () => {
    expect(findings("a.ts", 'await client.rpc("admin_list_users", { p_q: q });')).toEqual(["a.ts: admin_list_users"]);
    expect(findings("b.ts", 'supabase.rpc("master_set_role")')).toEqual(["b.ts: master_set_role"]);
    expect(findings("c.ts", 'client.functions.invoke("admin", { body })')).toEqual(["c.ts: a call to an Edge Function"]);
    expect(findings("d.ts", "fetch(`${url}/functions/v1/admin`)")).toEqual(["d.ts: a call to an Edge Function"]);
    expect(findings("e.tsx", "<h1>Administrator sign-in</h1>")).toEqual(['e.tsx: "Administrator sign-in"']);
    expect(findings("f.tsx", "<button>Invite user</button> <h2>Audit log</h2>")).toEqual(['f.tsx: "Invite user"', 'f.tsx: "Audit log"']);
    // What the app does hold: the roles an account can have, and the backend's error codes.
    expect(findings("g.ts", 'type InstanceRole = "researcher" | "supervisor" | "admin" | "master_admin"; const code = "last_master_admin";')).toEqual([]);
    expect(findings("h.ts", 'await client.rpc("my_account"); await client.rpc("get_public_instance");')).toEqual([]);
  });

  it("has no console folder", () => {
    const files = Object.keys(SOURCES).filter((f) => f.startsWith("./features/admin/") || f.startsWith("./lib/admin/"));
    expect(files).toEqual([]);
  });

  it("calls no admin function and no Edge Function, and words no administration screen", () => {
    const found: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) found.push(...findings(file.replace("./", "src/"), source));
    expect(found).toEqual([]);
  });

  it("ships a User Guide that does the same (it is built into Help)", () => {
    expect(findings("docs/USER_GUIDE.md", guide)).toEqual([]);
  });
});
