/**
 * Ethics helpers — pure text generators for the documents most student
 * researchers stall on: a participant information sheet + consent form, an
 * ethics/IRB application scaffold, and a data-anonymisation plan. Grounded in
 * standard frameworks (Declaration of Helsinki, Belmont Report, GDPR). These are
 * adaptable templates, NOT legal advice or a pre-approved protocol — every
 * output says so, and unfilled fields are left as explicit [PLACEHOLDERS].
 */

export interface EthicsInput {
  title: string;
  investigator: string;
  institution: string;
  population: string;
  procedures: string;
  risks: string;
  benefits: string;
  dataTypes: string;
  contactEmail: string;
  /** True if the study collects directly or indirectly identifiable data. */
  identifiable: boolean;
}

const ph = (v: string, fallback: string) => (v.trim() ? v.trim() : `[${fallback}]`);

export function consentForm(i: EthicsInput): string {
  const title = ph(i.title, "STUDY TITLE");
  const pi = ph(i.investigator, "INVESTIGATOR NAME");
  const inst = ph(i.institution, "INSTITUTION");
  const contact = ph(i.contactEmail, "CONTACT EMAIL");
  return `PARTICIPANT INFORMATION SHEET & CONSENT FORM

Study title: ${title}
Researcher: ${pi}, ${inst}
Contact: ${contact}

1. Invitation
You are invited to take part in a research study. Before you decide, please read this sheet and ask any questions. Taking part is entirely voluntary.

2. Purpose of the study
${ph(i.procedures ? `This study aims to ${i.title || "address the research question described to you"}.` : "", "PLAIN-LANGUAGE PURPOSE")}

3. Who is being asked to take part
${ph(i.population, "DESCRIBE THE PARTICIPANT GROUP AND ELIGIBILITY")}

4. What will happen if I take part
${ph(i.procedures, "DESCRIBE PROCEDURES, TIME COMMITMENT, AND WHAT IS ASKED OF PARTICIPANTS")}

5. Possible risks or discomforts
${ph(i.risks, "DESCRIBE FORESEEABLE RISKS AND HOW THEY ARE MINIMISED — or state there are no anticipated risks beyond everyday life")}

6. Possible benefits
${ph(i.benefits, "DESCRIBE ANY BENEFITS — and state honestly if there is no direct benefit to the participant")}

7. Confidentiality and data
The information you provide will be handled as follows: ${ph(i.dataTypes, "DESCRIBE DATA COLLECTED")}.
${i.identifiable
    ? "Because identifiable information is collected, it will be stored securely, accessible only to the research team, and reported only in de-identified or aggregate form."
    : "Data will be collected without direct identifiers wherever possible and reported only in aggregate."}

8. Voluntary participation and withdrawal
Participation is voluntary. You may decline to answer any question and may withdraw at any time, without giving a reason and without any disadvantage. [STATE THE POINT AFTER WHICH WITHDRAWAL OF ALREADY-ANONYMISED DATA IS NO LONGER POSSIBLE.]

9. Consent
By signing below, I confirm that I have read and understood this information, have had the chance to ask questions, and agree to take part.

  Participant name: ____________________   Signature: ____________________   Date: __________
  Researcher name:  ____________________   Signature: ____________________   Date: __________

— Adapt this template to your institution's required wording and your ethics committee's checklist before use. It is a draft, not an approved or legally vetted document.`;
}

export function irbScaffold(i: EthicsInput): string {
  return `ETHICS / IRB APPLICATION — SCAFFOLD

A. Administrative
   • Project title: ${ph(i.title, "TITLE")}
   • Principal investigator: ${ph(i.investigator, "NAME, ROLE")}
   • Institution / department: ${ph(i.institution, "INSTITUTION")}
   • Contact: ${ph(i.contactEmail, "EMAIL")}
   • Funding & conflicts of interest: [STATE FUNDING SOURCE AND ANY COI, OR "NONE"]

B. Scientific background & aims
   • Background and rationale: [WHY THIS STUDY; CITE KEY LITERATURE]
   • Research question / hypotheses: [STATE]
   • Design & methods: [STUDY DESIGN, SAMPLE SIZE & JUSTIFICATION, ANALYSIS PLAN]

C. Participants
   • Population & eligibility: ${ph(i.population, "INCLUSION / EXCLUSION CRITERIA")}
   • Recruitment: [HOW, WHERE, BY WHOM; ATTACH RECRUITMENT MATERIALS]
   • Vulnerable groups: [MINORS, PATIENTS, EMPLOYEES, ETC. — AND SAFEGUARDS, OR "NONE"]

D. Procedures
   ${ph(i.procedures, "STEP-BY-STEP WHAT PARTICIPANTS DO")}

E. Risk–benefit assessment (Belmont: beneficence)
   • Anticipated risks: ${ph(i.risks, "RISKS")}
   • Risk minimisation & adverse-event plan: [DESCRIBE]
   • Anticipated benefits: ${ph(i.benefits, "BENEFITS")}

F. Consent process (Helsinki / Belmont: respect for persons)
   • How and when informed consent is obtained: [DESCRIBE]
   • Assent for minors / proxy consent: [IF APPLICABLE]
   • Attach: participant information sheet & consent form.

G. Data management & privacy (Belmont: justice; GDPR where applicable)
   • Data collected: ${ph(i.dataTypes, "DATA TYPES")}
   • Identifiability: ${i.identifiable ? "Identifiable / pseudonymised — a data-protection plan is required (see anonymisation plan)." : "Non-identifiable / anonymous."}
   • Storage, access, retention, and destruction: [DESCRIBE; NAME THE LAWFUL BASIS IF GDPR APPLIES]
   • Data sharing / open data plan: [DESCRIBE OR STATE "NONE"]

H. Declarations
   • The study will follow the Declaration of Helsinki and institutional policy.
   • [LIST ATTACHMENTS: protocol, consent form, instruments, recruitment materials.]

— A scaffold to complete, not a submission. Use your committee's official form and checklist; requirements vary by institution and jurisdiction.`;
}

export function anonymisationPlan(i: EthicsInput): string {
  const base = `DATA ANONYMISATION & PROTECTION PLAN

Data collected: ${ph(i.dataTypes, "LIST EACH DATA ELEMENT")}

1. Direct identifiers to remove or never collect
   • Names, initials, addresses, phone numbers, email addresses, ID/record numbers, faces in images/video.

2. Indirect (quasi-) identifiers to review for re-identification risk
   • Dates (birth, admission), rare diagnoses or events, small geographic units, occupation, unusual combinations of attributes.
   • Reduce risk by: banding ages, using year not full date, aggregating small categories, suppressing cells with low counts.

3. Pseudonymisation (if identifiers must be kept during the study)
   • Replace identifiers with codes; keep the code↔identity key in a SEPARATE, access-controlled location, never with the dataset.
   • Delete the key at the earliest point consistent with the protocol.

4. Storage & access
   • Encrypted at rest; access limited to named team members; no identifiable data on personal/unsecured devices or shared drives.

5. Sharing & reporting
   • Report only de-identified / aggregate results; suppress any cell or quote that could identify an individual.
   • Apply the same standard to qualitative quotes (remove names, places, distinctive details).

6. Retention & destruction
   • [STATE RETENTION PERIOD] then securely destroy identifiable data and the linkage key.`;

  const note = i.identifiable
    ? "\n\n⚠ This study collects identifiable data — a documented plan and (where GDPR applies) a lawful basis and possibly a DPIA are required."
    : "\n\nThis study is recorded as non-identifiable; re-check the quasi-identifiers above, as combinations can still re-identify participants.";

  return base + note + "\n\n— Guidance, not legal advice. Confirm against your institution's data-protection policy and applicable law (e.g. GDPR, HIPAA).";
}
