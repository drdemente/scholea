import { describe, expect, it } from "vitest";
import { anonymisationPlan, consentForm, irbScaffold, type EthicsInput } from "./ethics";

const full: EthicsInput = {
  title: "Mindfulness app for test anxiety",
  investigator: "A. Researcher",
  institution: "Demo University",
  population: "High-school students aged 14–18",
  procedures: "Two 20-minute app sessions and a short survey",
  risks: "Minimal — possible mild discomfort discussing anxiety",
  benefits: "No direct benefit; may inform future support",
  dataTypes: "Survey responses, app usage logs",
  contactEmail: "pi@demo.edu",
  identifiable: true,
};

const empty: EthicsInput = {
  title: "", investigator: "", institution: "", population: "", procedures: "",
  risks: "", benefits: "", dataTypes: "", contactEmail: "", identifiable: false,
};

describe("consentForm", () => {
  it("substitutes provided fields and keeps required sections", () => {
    const out = consentForm(full);
    expect(out).toContain("Mindfulness app for test anxiety");
    expect(out).toContain("A. Researcher, Demo University");
    expect(out).toMatch(/Voluntary participation and withdrawal/);
    expect(out).toMatch(/draft, not an approved or legally vetted document/);
  });
  it("marks missing fields as explicit placeholders rather than blanks", () => {
    const out = consentForm(empty);
    expect(out).toContain("[STUDY TITLE]");
    expect(out).toContain("[INVESTIGATOR NAME]");
  });
});

describe("irbScaffold", () => {
  it("includes the core sections and reflects identifiability", () => {
    const out = irbScaffold(full);
    expect(out).toMatch(/Risk.?benefit assessment/);
    expect(out).toMatch(/Consent process/);
    expect(out).toContain("Identifiable / pseudonymised");
  });
  it("marks a non-identifiable study accordingly", () => {
    expect(irbScaffold(empty)).toContain("Non-identifiable / anonymous");
  });
});

describe("anonymisationPlan", () => {
  it("warns when identifiable data is collected", () => {
    expect(anonymisationPlan(full)).toMatch(/collects identifiable data/);
  });
  it("still flags quasi-identifier risk when non-identifiable", () => {
    expect(anonymisationPlan(empty)).toMatch(/can still re-identify/);
  });
  it("is labelled as guidance, not legal advice", () => {
    expect(anonymisationPlan(full)).toMatch(/not legal advice/);
  });
});
