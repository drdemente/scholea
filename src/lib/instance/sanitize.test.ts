import { describe, expect, it } from "vitest";
import {
  FOOTER_CONTACT_MAX,
  FOOTER_CONTACT_MAX_LINES,
  ORG_NAME_MAX,
  REFRESH_INTERVAL_MS,
  STUDY_TYPES_MAX,
  SUPPORT_EMAIL_MAX,
  resolveInstance,
  safeMailto,
  sanitizeInstance,
  shouldRefresh,
  type PublicInstance,
  type SessionPhase,
} from "./sanitize";

const STOCK: PublicInstance = { orgName: "", supportEmail: "", footerContact: "", accent: "", enabledStudyTypes: null };

const CLEAN: PublicInstance = {
  orgName: "Riverside Institute of Health Research",
  supportEmail: "research-support@riverside.example",
  footerContact: "Research Office, Room 4.12\nMonday to Friday, 9 to 5",
  accent: "#1a7f5a",
  enabledStudyTypes: ["systematic-review", "rct", "cohort"],
};

const PHASES: readonly SessionPhase[] = ["unconfigured", "loading", "anon", "ready"];

describe("sanitizeInstance", () => {
  it("uses the backend's own limits", () => {
    // From the instance_settings checks and admin_update_settings in supabase/migrations.
    expect({ ORG_NAME_MAX, SUPPORT_EMAIL_MAX, FOOTER_CONTACT_MAX, STUDY_TYPES_MAX }).toEqual({
      ORG_NAME_MAX: 200,
      SUPPORT_EMAIL_MAX: 320,
      FOOTER_CONTACT_MAX: 500,
      STUDY_TYPES_MAX: 100,
    });
    expect(FOOTER_CONTACT_MAX_LINES).toBe(8);
  });

  it("passes a clean record through unchanged", () => {
    expect(sanitizeInstance(CLEAN)).toEqual(CLEAN);
    expect(sanitizeInstance(JSON.parse(JSON.stringify(CLEAN)))).toEqual(CLEAN);
  });

  it("reads a backend that was never configured as stock Scholea", () => {
    // Exactly what a fresh backend answers: its default name is the product's own.
    const fresh = { accent: "", orgName: "Scholea", supportEmail: "", footerContact: "", enabledStudyTypes: null };
    expect(sanitizeInstance(fresh)).toEqual(STOCK);
    expect(sanitizeInstance({ ...fresh, orgName: "  SCHOLEA " })?.orgName).toBe("");
    // A real name that merely starts with it is kept.
    expect(sanitizeInstance({ ...fresh, orgName: "Scholea at Riverside" })?.orgName).toBe("Scholea at Riverside");
  });

  it("is null for anything that is not a settings record", () => {
    for (const raw of [null, undefined, "", "Scholea", 42, true, [], [CLEAN], () => CLEAN]) {
      expect(sanitizeInstance(raw), String(raw)).toBeNull();
    }
    // An object with none of the five settings is some other answer, such as an error.
    expect(sanitizeInstance({})).toBeNull();
    expect(sanitizeInstance({ code: "42501", message: "permission denied", details: null, hint: null })).toBeNull();
    expect(sanitizeInstance({ instance: CLEAN })).toBeNull();
    // A list is not a record, even one that has been given a settings key.
    expect(sanitizeInstance(Object.assign([], { orgName: "Riverside" }))).toBeNull();
    expect(sanitizeInstance(Object.assign(() => 0, { orgName: "Riverside" }))).toBeNull();
  });

  it("fills in whatever is missing or of the wrong type, and returns exactly the five settings", () => {
    expect(sanitizeInstance({ orgName: "Riverside" })).toEqual({ ...STOCK, orgName: "Riverside" });
    const odd = sanitizeInstance({
      orgName: 7,
      supportEmail: ["a@b.example"],
      footerContact: { text: "x" },
      accent: 0xffffff,
      enabledStudyTypes: "all",
      sharedSources: ["pubmed"],
      role: "master_admin",
    });
    expect(odd).toEqual(STOCK);
    expect(Object.keys(odd as PublicInstance).sort()).toEqual(["accent", "enabledStudyTypes", "footerContact", "orgName", "supportEmail"]);
  });

  it("does not let a crafted record reach the prototype", () => {
    const crafted = JSON.parse('{"__proto__": {"polluted": true}, "orgName": "Riverside", "constructor": {"prototype": {"polluted": true}}}');
    const result = sanitizeInstance(crafted) as PublicInstance;
    expect(result).toEqual({ ...STOCK, orgName: "Riverside" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  describe("organisation name", () => {
    const nameOf = (orgName: unknown) => sanitizeInstance({ orgName })?.orgName;

    it("is trimmed to one line of plain text", () => {
      expect(nameOf("   Riverside   Institute  ")).toBe("Riverside Institute");
      expect(nameOf("Riverside\r\nInstitute\tof\nHealth")).toBe("Riverside Institute of Health");
      expect(nameOf("Riverside\rInstitute")).toBe("Riverside Institute");
      expect(nameOf("Riverside\u2028Institute")).toBe("Riverside Institute");
    });

    it("loses control characters and characters that reverse the reading direction", () => {
      expect(nameOf("River\u0000side\u0007 \u001b[31mInstitute\u009f")).toBe("Riverside [31mInstitute");
      expect(nameOf("\u202eetutitsnI\u202c \u2066Riverside\u2069\ufeff")).toBe("etutitsnI Riverside");
    });

    it("keeps markup as the plain text it is, for the interface to show as text", () => {
      expect(nameOf('<img src=x onerror="alert(1)">')).toBe('<img src=x onerror="alert(1)">');
    });

    it("keeps other scripts, joiners and emoji intact", () => {
      expect(nameOf("Universit\u00e9 de Montr\u00e9al")).toBe("Universit\u00e9 de Montr\u00e9al");
      const arabic = "\u062c\u0627\u0645\u0639\u0629 \u0627\u0644\u0642\u0627\u0647\u0631\u0629";
      expect(nameOf(arabic)).toBe(arabic);
      expect(nameOf("\u0646\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe("\u0646\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645");
      expect(nameOf("Lab \ud83e\uddea")).toBe("Lab \ud83e\uddea");
    });

    it("drops half a character left on its own, so the text is always well formed", () => {
      expect(nameOf("Lab \ud83e")).toBe("Lab");
      expect(nameOf("\uddeaLab \ud83e\uddea\ud83e")).toBe("Lab \ud83e\uddea");
    });

    it("is capped at the backend's limit, counted in characters and never splitting one", () => {
      expect(nameOf("a".repeat(ORG_NAME_MAX))).toHaveLength(ORG_NAME_MAX);
      expect(nameOf("a".repeat(ORG_NAME_MAX + 50))).toBe("a".repeat(ORG_NAME_MAX));
      // 200 emoji are 400 code units but 200 characters: all of them fit.
      const flask = "\ud83e\uddea";
      expect(nameOf(flask.repeat(ORG_NAME_MAX))).toBe(flask.repeat(ORG_NAME_MAX));
      const capped = nameOf(flask.repeat(ORG_NAME_MAX + 5)) as string;
      expect(Array.from(capped)).toHaveLength(ORG_NAME_MAX);
      expect(capped.endsWith(flask)).toBe(true);
      // A megabyte of text is cut down, not processed whole.
      expect(nameOf("x".repeat(1_000_000))).toHaveLength(ORG_NAME_MAX);
    });
  });

  describe("contact line", () => {
    const contactOf = (footerContact: unknown) => sanitizeInstance({ footerContact })?.footerContact;

    it("keeps its line breaks and tidies each line", () => {
      expect(contactOf("  Research Office \r\n\tRoom 4.12  \rMonday   to Friday\u2029Ring 5550 100 ")).toBe(
        "Research Office\nRoom 4.12\nMonday to Friday\nRing 5550 100",
      );
    });

    it("drops blank lines at either end and never keeps two in a row", () => {
      expect(contactOf("\n\n  \nOne\n\n\n\nTwo\n \n")).toBe("One\n\nTwo");
    });

    it("folds lines past the limit into the last one instead of losing them", () => {
      const lines = Array.from({ length: FOOTER_CONTACT_MAX_LINES + 3 }, (_, i) => `line ${i + 1}`);
      const result = contactOf(lines.join("\n")) as string;
      const kept = result.split("\n");
      expect(kept).toHaveLength(FOOTER_CONTACT_MAX_LINES);
      expect(kept[FOOTER_CONTACT_MAX_LINES - 1]).toBe(lines.slice(FOOTER_CONTACT_MAX_LINES - 1).join(" "));
      // A wall of line breaks cannot make the block tall.
      expect((contactOf("a\n".repeat(400)) as string).split("\n").length).toBeLessThanOrEqual(FOOTER_CONTACT_MAX_LINES);
    });

    it("is capped at the backend's limit", () => {
      expect(contactOf("b".repeat(FOOTER_CONTACT_MAX + 1))).toBe("b".repeat(FOOTER_CONTACT_MAX));
      const long = contactOf(`${"c".repeat(FOOTER_CONTACT_MAX - 1)}\n\nmore`) as string;
      expect(long).toBe("c".repeat(FOOTER_CONTACT_MAX - 1));
    });

    it("stays plain text: markup and Markdown are not interpreted or removed", () => {
      expect(contactOf("<b>Office</b> [site](javascript:alert(1))")).toBe("<b>Office</b> [site](javascript:alert(1))");
      expect(contactOf("A\u0000B\u202eC")).toBe("ABC");
    });
  });

  describe("accent", () => {
    const accentOf = (accent: unknown) => sanitizeInstance({ accent })?.accent;

    it("keeps a hex colour, as lower-case #rrggbb", () => {
      expect(accentOf("#1a7f5a")).toBe("#1a7f5a");
      expect(accentOf("#FFD400")).toBe("#ffd400");
      expect(accentOf("#FA0")).toBe("#ffaa00");
    });

    it("drops anything else", () => {
      for (const accent of ["red", "rgb(0,0,0)", "#12", "#fff;}", "#ffffff;} body{display:none}", "url(x)", "var(--violet-500)", 123, null, {}]) {
        expect(accentOf(accent), String(accent)).toBe("");
      }
    });
  });

  describe("support address", () => {
    const emailOf = (supportEmail: unknown) => sanitizeInstance({ supportEmail })?.supportEmail;

    it("keeps a plain address", () => {
      expect(emailOf("support@riverside.example")).toBe("support@riverside.example");
      expect(emailOf("  Research.Support+scholea@mail.riverside.example \n")).toBe("Research.Support+scholea@mail.riverside.example");
      expect(emailOf("o'brien@riverside.example")).toBe("o'brien@riverside.example");
    });

    it("drops what is not one, so a kept address always makes a link", () => {
      const refused: unknown[] = [
        "",
        "support",
        "support@",
        "@riverside.example",
        "support@localhost",
        "support@riverside",
        "support @riverside.example",
        "support@river side.example",
        "a@b.example, c@d.example",
        "a@b.example;c@d.example",
        "Support <support@riverside.example>",
        "<support@riverside.example>",
        "mailto:support@riverside.example",
        "javascript:alert(1)",
        "support@riverside.example?subject=hi",
        "support@riverside.example\nBcc: other@elsewhere.example",
        "support@@riverside.example",
        "support@-riverside.example",
        "support@riverside..example",
        "jos\u00e9@riverside.example",
        `${"a".repeat(SUPPORT_EMAIL_MAX)}@riverside.example`,
        42,
        null,
        ["support@riverside.example"],
      ];
      for (const supportEmail of refused) expect(emailOf(supportEmail), String(supportEmail)).toBe("");
      for (const kept of ["support@riverside.example", "o'brien@riverside.example", "a?b&c=d%e#f/g@riverside.example"]) {
        expect(safeMailto(emailOf(kept) as string), kept).not.toBeNull();
      }
    });
  });

  describe("study types", () => {
    const typesOf = (enabledStudyTypes: unknown) => sanitizeInstance({ enabledStudyTypes })?.enabledStudyTypes;

    it("null means every type", () => {
      expect(typesOf(null)).toBeNull();
    });

    it("keeps well-formed ids, once each, in order", () => {
      expect(typesOf(["rct", "cohort", "rct", "case-control"])).toEqual(["rct", "cohort", "case-control"]);
    });

    it("drops ids that are not well formed", () => {
      expect(typesOf(["rct", "RCT", "case control", "", "a".repeat(65), "rct;drop", "../x", 7, null, ["cohort"], { id: "cohort" }])).toEqual(["rct"]);
      expect(typesOf(["a".repeat(64)])).toEqual(["a".repeat(64)]);
    });

    it("means every type when nothing usable is listed, rather than none", () => {
      expect(typesOf([])).toBeNull();
      expect(typesOf(["Not An Id", 3])).toBeNull();
      expect(typesOf("all")).toBeNull();
      expect(typesOf({ 0: "rct", length: 1 })).toBeNull();
    });

    it("is capped", () => {
      const many = Array.from({ length: STUDY_TYPES_MAX + 40 }, (_, i) => `type-${i}`);
      expect(typesOf(many)).toEqual(many.slice(0, STUDY_TYPES_MAX));
      expect(typesOf(Array.from({ length: 200_000 }, () => "Not An Id"))).toBeNull();
    });
  });

  it("changes nothing when run again on its own output", () => {
    const samples: unknown[] = [
      CLEAN,
      { orgName: "Scholea" },
      { orgName: `  ${"\ud83e\uddea".repeat(300)}  `, footerContact: `${"line\n".repeat(40)}${"z".repeat(600)}` },
      { orgName: "a\u0000b\u202ec\r\nd", footerContact: "\n\n x \t y \r\n\r\n\r\n z \n", accent: "#ABC" },
      { supportEmail: " A.B+c@Mail.Example ", enabledStudyTypes: ["rct", "rct", "X", "cohort"] },
      { footerContact: `${"w ".repeat(260)}\n\ntail`, enabledStudyTypes: [] },
    ];
    for (const sample of samples) {
      const once = sanitizeInstance(sample);
      expect(once).not.toBeNull();
      expect(sanitizeInstance(once)).toEqual(once);
      // And it survives being stored and read back.
      expect(sanitizeInstance(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });

  it("does not change the record it was given", () => {
    const raw = { orgName: "  Riverside  ", enabledStudyTypes: ["rct", "rct", "BAD"] };
    const copy = JSON.parse(JSON.stringify(raw));
    sanitizeInstance(raw);
    expect(raw).toEqual(copy);
  });
});

describe("resolveInstance", () => {
  it("is null for a guest and for a build with no backend, whatever is cached", () => {
    expect(resolveInstance("anon", CLEAN)).toBeNull();
    expect(resolveInstance("unconfigured", CLEAN)).toBeNull();
  });

  it("honours the cache while signed in and while a saved session is still being checked", () => {
    expect(resolveInstance("ready", CLEAN)).toBe(CLEAN);
    expect(resolveInstance("loading", CLEAN)).toBe(CLEAN);
  });

  it("has nothing to give when nothing is cached", () => {
    for (const phase of PHASES) expect(resolveInstance(phase, null)).toBeNull();
  });
});

describe("shouldRefresh", () => {
  const NOW = 1_800_000_000_000;
  const base = { phase: "ready" as SessionPhase, configured: true, online: true, now: NOW, fetchedAt: 0 };

  it("the full truth table: only a signed-in, configured, online app ever asks", () => {
    for (const phase of PHASES) {
      for (const configured of [true, false]) {
        for (const online of [true, false]) {
          for (const force of [true, false, undefined]) {
            for (const fetchedAt of [0, NOW - REFRESH_INTERVAL_MS - 1, NOW - 1]) {
              const allowed = phase === "ready" && configured && online;
              const stale = fetchedAt === 0 || NOW - fetchedAt >= REFRESH_INTERVAL_MS;
              expect(
                shouldRefresh({ phase, configured, online, now: NOW, fetchedAt, force }),
                JSON.stringify({ phase, configured, online, force, fetchedAt }),
              ).toBe(allowed && (force === true || stale));
            }
          }
        }
      }
    }
  });

  it("never for a guest, not even when forced", () => {
    expect(shouldRefresh({ ...base, phase: "anon" })).toBe(false);
    expect(shouldRefresh({ ...base, phase: "anon", force: true })).toBe(false);
  });

  it("never in a build with no backend, not even when forced", () => {
    expect(shouldRefresh({ ...base, configured: false })).toBe(false);
    expect(shouldRefresh({ ...base, configured: false, force: true })).toBe(false);
    expect(shouldRefresh({ ...base, phase: "unconfigured", configured: false, force: true })).toBe(false);
    // The phase alone is enough to refuse.
    expect(shouldRefresh({ ...base, phase: "unconfigured", force: true })).toBe(false);
  });

  it("not while a saved session is still being checked, and not while offline", () => {
    expect(shouldRefresh({ ...base, phase: "loading", force: true })).toBe(false);
    expect(shouldRefresh({ ...base, online: false, force: true })).toBe(false);
  });

  it("at once when nothing was fetched yet", () => {
    expect(shouldRefresh({ ...base, fetchedAt: 0 })).toBe(true);
    expect(shouldRefresh({ ...base, fetchedAt: Number.NaN })).toBe(true);
    expect(shouldRefresh({ ...base, fetchedAt: -5 })).toBe(true);
  });

  it("at most once per ten minutes otherwise", () => {
    expect(REFRESH_INTERVAL_MS).toBe(600_000);
    expect(shouldRefresh({ ...base, fetchedAt: NOW })).toBe(false);
    expect(shouldRefresh({ ...base, fetchedAt: NOW - 1_000 })).toBe(false);
    expect(shouldRefresh({ ...base, fetchedAt: NOW - REFRESH_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldRefresh({ ...base, fetchedAt: NOW - REFRESH_INTERVAL_MS })).toBe(true);
    expect(shouldRefresh({ ...base, fetchedAt: NOW - 3 * REFRESH_INTERVAL_MS })).toBe(true);
  });

  it("force skips only the wait", () => {
    expect(shouldRefresh({ ...base, fetchedAt: NOW - 1_000, force: true })).toBe(true);
    expect(shouldRefresh({ ...base, fetchedAt: NOW - 1_000, force: false })).toBe(false);
  });

  it("a clock that went backwards does not block refreshing", () => {
    expect(shouldRefresh({ ...base, fetchedAt: NOW + 86_400_000 })).toBe(true);
  });
});

describe("safeMailto", () => {
  it("makes a link from a plain address", () => {
    expect(safeMailto("support@riverside.example")).toBe("mailto:support@riverside.example");
    expect(safeMailto("  Research.Support@mail.riverside.example ")).toBe("mailto:Research.Support@mail.riverside.example");
    expect(safeMailto("first_last-1@sub-domain.riverside.example")).toBe("mailto:first_last-1@sub-domain.riverside.example");
  });

  it("encodes the part before the @, so an address cannot add a subject, a body or more recipients", () => {
    expect(safeMailto("research+scholea@riverside.example")).toBe("mailto:research%2Bscholea@riverside.example");
    expect(safeMailto("a?subject=x&body=y@riverside.example")).toBe("mailto:a%3Fsubject%3Dx%26body%3Dy@riverside.example");
    expect(safeMailto("a#b%c/d@riverside.example")).toBe("mailto:a%23b%25c%2Fd@riverside.example");
    for (const address of ["a?cc=x@riverside.example", "a&b@riverside.example", "a#b@riverside.example"]) {
      const link = safeMailto(address) as string;
      expect(link.slice("mailto:".length)).not.toMatch(/[?&#]/);
      // The browser reads it back as one recipient and nothing else.
      const url = new URL(link);
      expect(url.protocol).toBe("mailto:");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(decodeURIComponent(url.pathname)).toBe(address);
    }
  });

  it("is null for anything that is not a plain address", () => {
    const refused: unknown[] = [
      "",
      "   ",
      "support",
      "support@riverside",
      "support@localhost",
      "support riverside.example",
      "a@b.example,c@d.example",
      "a@b.example c@d.example",
      "Support <support@riverside.example>",
      '"Support" support@riverside.example',
      "mailto:support@riverside.example",
      "javascript:alert(1)",
      "https://riverside.example/contact",
      "support@riverside.example?subject=hi",
      "support@riverside.example&cc=x@y.example",
      "support@riverside.example#top",
      "support@riverside.example/path",
      "support@riverside.example\r\nBcc: other@elsewhere.example",
      "support\u0000@riverside.example",
      "sup\u202eport@riverside.example",
      "jos\u00e9@riverside.example",
      "support@r\u00efverside.example",
      "support@[127.0.0.1]",
      "a@b@riverside.example",
      `${"a".repeat(SUPPORT_EMAIL_MAX)}@riverside.example`,
      null,
      undefined,
      42,
      { toString: () => "support@riverside.example" },
    ];
    for (const email of refused) expect(safeMailto(email as string), String(email)).toBeNull();
  });

  it("accepts an address right at the length limit and refuses one past it", () => {
    const domain = "@riverside.example";
    expect(safeMailto(`${"a".repeat(SUPPORT_EMAIL_MAX - domain.length)}${domain}`)).not.toBeNull();
    expect(safeMailto(`${"a".repeat(SUPPORT_EMAIL_MAX - domain.length + 1)}${domain}`)).toBeNull();
  });
});
