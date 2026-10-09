import { describe, expect, it } from "vitest";
import { STUDY_CONFIGS, configsByFamily } from "@/lib/study/registry";
import {
  ABOUT_CAPTION,
  ABOUT_HEADING,
  ABOUT_LABEL,
  HELP_CONTACT_LABEL,
  SUPPORT_ITEM_LABEL,
  chooserNote,
  contactView,
  helpContact,
  newStudyAllowList,
  orgNameOf,
  signedInLine,
  supportContact,
  supportLead,
} from "./instance-view";
import { sanitizeInstance, type PublicInstance } from "./sanitize";
import { filterFamilies, isStudyTypeAllowed } from "./study-types";

/** Stock Scholea, as a signed-in person gets it from a backend nobody configured. */
const STOCK: PublicInstance = { orgName: "", supportEmail: "", footerContact: "", accent: "", enabledStudyTypes: null };

const RIVERSIDE: PublicInstance = {
  orgName: "Riverside Institute",
  supportEmail: "support@riverside.example",
  footerContact: "Research Office, Room 4.12\nMon to Fri, 9 to 5",
  accent: "#00a651",
  enabledStudyTypes: ["rct", "cohort", "qualitative"],
};

const ALL_IDS = STUDY_CONFIGS.map((config) => config.id);

describe("the organisation's name", () => {
  it("is empty for a guest and when none is set", () => {
    expect(orgNameOf(null)).toBe("");
    expect(orgNameOf(STOCK)).toBe("");
    expect(orgNameOf(RIVERSIDE)).toBe("Riverside Institute");
  });

  it("gives the account menu its line, or no line at all", () => {
    expect(signedInLine(RIVERSIDE)).toBe("Signed in to Riverside Institute");
    expect(signedInLine(STOCK)).toBeNull();
    expect(signedInLine(null)).toBeNull();
  });

  it("is never the product's own name, which the backend uses as its default", () => {
    // The wordmark would read "Scholea · Scholea" otherwise.
    const fresh = sanitizeInstance({ orgName: "Scholea", supportEmail: "", footerContact: "", accent: "", enabledStudyTypes: null });
    expect(orgNameOf(fresh)).toBe("");
    expect(signedInLine(fresh)).toBeNull();
  });
});

describe("the support address", () => {
  it("becomes a mailto link, and only that", () => {
    expect(supportContact(RIVERSIDE)).toEqual({ email: "support@riverside.example", href: "mailto:support@riverside.example" });
    expect(SUPPORT_ITEM_LABEL).toBe("Contact support");
  });

  it("is left out when there is none", () => {
    expect(supportContact(null)).toBeNull();
    expect(supportContact(STOCK)).toBeNull();
  });

  it("is left out rather than linked when it is not a plain address", () => {
    // The cleaning gate drops these before they get here; this is the second lock.
    for (const supportEmail of [
      "javascript:alert(1)",
      "help@riverside.example?subject=Hello&bcc=someone@else.example",
      "Support <support@riverside.example>",
      "a@b.example, c@d.example",
      "https://riverside.example/help",
      "support",
    ]) {
      expect(supportContact({ ...RIVERSIDE, supportEmail })).toBeNull();
    }
  });

  it("cannot add anything to the link through the part before the @", () => {
    const contact = supportContact({ ...RIVERSIDE, supportEmail: "help+desk&team=1@riverside.example" });
    expect(contact?.href).toBe("mailto:help%2Bdesk%26team%3D1@riverside.example");
    expect(contact?.email).toBe("help+desk&team=1@riverside.example");
  });
});

describe("the sentence in front of the support address", () => {
  it("names the organisation, or falls back to the administrator", () => {
    expect(supportLead("Riverside Institute")).toBe("Questions about your account or this workspace? Contact Riverside Institute:");
    expect(supportLead("")).toBe("Questions about your account or this workspace? Contact your administrator:");
  });
});

describe("About this workspace", () => {
  it("shows everything the organisation set", () => {
    expect(contactView(RIVERSIDE)).toEqual({
      orgName: "Riverside Institute",
      support: { email: "support@riverside.example", href: "mailto:support@riverside.example" },
      contact: "Research Office, Room 4.12\nMon to Fri, 9 to 5",
    });
  });

  it("is left out altogether for a guest and when nothing is set", () => {
    expect(contactView(null)).toBeNull();
    expect(contactView(STOCK)).toBeNull();
    // An accent or a study-type list is not something to show here.
    expect(contactView({ ...STOCK, accent: "#00a651", enabledStudyTypes: ["rct"] })).toBeNull();
  });

  it("is shown for any one of the three, with the others empty", () => {
    expect(contactView({ ...STOCK, orgName: "Riverside Institute" })).toEqual({ orgName: "Riverside Institute", support: null, contact: "" });
    expect(contactView({ ...STOCK, supportEmail: "support@riverside.example" })).toMatchObject({ orgName: "", contact: "" });
    expect(contactView({ ...STOCK, footerContact: "Room 4.12" })).toEqual({ orgName: "", support: null, contact: "Room 4.12" });
  });

  it("has its heading, caption and row labels", () => {
    expect(ABOUT_HEADING).toBe("About this workspace");
    expect(ABOUT_CAPTION).toBe("Provided by your organisation's Scholea administrator.");
    expect(ABOUT_LABEL).toEqual({ orgName: "Organisation", support: "Support", contact: "Contact" });
  });
});

describe("the bottom of the User Guide", () => {
  it("has a name for a screen reader", () => {
    expect(HELP_CONTACT_LABEL).toBe("Contact for this workspace");
  });

  it("shows the support address and the contact line", () => {
    expect(helpContact(RIVERSIDE)).toEqual(contactView(RIVERSIDE));
    expect(helpContact({ ...STOCK, supportEmail: "support@riverside.example" })?.support?.email).toBe("support@riverside.example");
    expect(helpContact({ ...STOCK, footerContact: "Room 4.12" })?.contact).toBe("Room 4.12");
  });

  it("is left out when there is only a name: a name alone is no way to get in touch", () => {
    expect(helpContact({ ...STOCK, orgName: "Riverside Institute" })).toBeNull();
    expect(helpContact(STOCK)).toBeNull();
    expect(helpContact(null)).toBeNull();
  });
});

describe("study types for a new project", () => {
  it("are all of them for a guest and when the organisation set no list", () => {
    expect(newStudyAllowList(null)).toBeNull();
    expect(newStudyAllowList(STOCK)).toBeNull();
    expect(chooserNote(null)).toBeNull();
    expect(chooserNote(STOCK)).toBeNull();
    expect(filterFamilies(configsByFamily(), newStudyAllowList(null)).flatMap((group) => group.configs)).toHaveLength(STUDY_CONFIGS.length);
  });

  it("are the listed ones otherwise, and the chooser says so", () => {
    const allow = newStudyAllowList(RIVERSIDE);
    expect(Array.from(allow ?? []).sort()).toEqual(["cohort", "qualitative", "rct"]);
    expect(isStudyTypeAllowed("rct", allow)).toBe(true);
    expect(isStudyTypeAllowed("systematic-review", allow)).toBe(false);

    const offered = filterFamilies(configsByFamily(), allow).flatMap((group) => group.configs.map((config) => config.id));
    expect(offered.sort()).toEqual(["cohort", "qualitative", "rct"]);

    expect(chooserNote(RIVERSIDE)).toBe(
      `Riverside Institute has made 3 of ${STUDY_CONFIGS.length} study types available for new projects. Existing projects are not affected.`,
    );
  });

  it("speaks of the organisation when it has no name", () => {
    expect(chooserNote({ ...RIVERSIDE, orgName: "" })).toBe(
      `Your organisation has made 3 of ${STUDY_CONFIGS.length} study types available for new projects. Existing projects are not affected.`,
    );
  });

  it("counts only the types this version knows", () => {
    const instance = { ...RIVERSIDE, enabledStudyTypes: ["rct", "time-travel-study", "rct"] };
    expect(newStudyAllowList(instance)?.size).toBe(1);
    expect(chooserNote(instance)).toContain(`has made 1 of ${STUDY_CONFIGS.length} study types`);
  });

  it("are all of them when the list names none this version knows, with no note", () => {
    const instance = { ...RIVERSIDE, enabledStudyTypes: ["time-travel-study", "another-unknown"] };
    expect(newStudyAllowList(instance)).toBeNull();
    expect(chooserNote(instance)).toBeNull();
    for (const id of ALL_IDS) expect(isStudyTypeAllowed(id, newStudyAllowList(instance))).toBe(true);
  });

  it("are all of them when the list names every type, with no note", () => {
    const instance = { ...RIVERSIDE, enabledStudyTypes: [...ALL_IDS] };
    expect(newStudyAllowList(instance)).toBeNull();
    expect(chooserNote(instance)).toBeNull();
  });

  it("knows the registry's ids, including the two the project type union leaves out", () => {
    const instance = { ...RIVERSIDE, enabledStudyTypes: ["economic", "animal"] };
    expect(Array.from(newStudyAllowList(instance) ?? []).sort()).toEqual(["animal", "economic"]);
  });
});

describe("copy", () => {
  it("has no em-dash anywhere", () => {
    const sentences = [
      signedInLine(RIVERSIDE),
      SUPPORT_ITEM_LABEL,
      supportLead("Riverside Institute"),
      supportLead(""),
      ABOUT_HEADING,
      ABOUT_CAPTION,
      HELP_CONTACT_LABEL,
      ...Object.values(ABOUT_LABEL),
      chooserNote(RIVERSIDE),
      chooserNote({ ...RIVERSIDE, orgName: "" }),
    ];
    for (const sentence of sentences) expect(sentence).not.toMatch(/—|–/);
  });
});
