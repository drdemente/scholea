import type { StudyTypeConfig } from "../types";
import { fArea, fCheck, fNum, guide, list, minLen, para, range, required, tip, warn } from "../authoring";

/**
 * Animal / preclinical study (scaffold; optional/advanced per §3) — authored
 * from ARRIVE 2.0 (Percie du Sert et al., 2020), with the 3Rs front of mind.
 */
export const animal: StudyTypeConfig = {
  id: "animal",
  label: "Animal / Preclinical Study",
  family: "report",
  reportingStandard: "ARRIVE",
  steps: [
    {
      id: "question",
      title: "Objective & the 3Rs",
      short: "Objective",
      subtitle: "ARRIVE: hypothesis, species, and ethical justification.",
      glossary: [{ term: "3Rs", definition: "Replacement, Reduction, Refinement — the ethical framework for humane animal research: replace animals where possible, use the fewest needed, and minimise suffering." }],
      guide: guide(
        [para("State your hypothesis and species, and justify the use of animals under the 3Rs. Ethical approval is mandatory before any work."),
         warn("Animal research requires institutional ethics/animal-welfare approval and adherence to local regulations.")],
      ),
      inputs: [
        fArea("objective", "Objective & hypothesis", { required: true, rows: 2 }),
        fCheck("ethics", "Animal-welfare/ethics approval obtained"),
      ],
      validations: [minLen("objective", 15, "State your objective."), required("ethics", "Ethics approval is required before preclinical work.", "warn")],
    },
    {
      id: "design",
      title: "Design, animals & sample size",
      short: "Design",
      subtitle: "ARRIVE Essential 10: groups, randomisation, blinding, n.",
      extraTool: "samplesize",
      guide: guide(
        [para("Describe experimental groups, randomisation and blinding, and justify the number of animals with a power calculation (Reduction)."),
         list(["Species, strain, sex, age/weight", "Group sizes + power justification", "Randomisation & blinding of outcome assessment"])],
      ),
      inputs: [
        fArea("design", "Design, species & allocation", { required: true, rows: 3 }),
        fNum("nAnimals", "Total animals (justified)", { min: 1 }),
      ],
      validations: [minLen("design", 20, "Describe the design and animals."), range("nAnimals", { min: 1 }, "Enter the justified number of animals.")],
    },
    {
      id: "analysis",
      title: "Outcomes & analysis",
      short: "Analysis",
      subtitle: "ARRIVE: outcomes, statistical methods, exclusions.",
      guide: guide(
        [para("Define outcomes and your statistical approach, including how exclusions and the experimental unit are handled."),
         tip("The experimental unit (cage vs animal) determines your real sample size — state it explicitly.")],
      ),
      inputs: [fArea("analysis", "Outcomes & analysis plan", { required: true, rows: 3 })],
      validations: [minLen("analysis", 20, "Describe outcomes and analysis.")],
    },
    {
      id: "report",
      title: "ARRIVE report & export",
      short: "Report",
      subtitle: "Report against the ARRIVE 2.0 Essential 10.",
      guide: guide([para("Report design, sample size, randomisation, blinding, outcomes, and the 3Rs measures taken."), warn("Label AI-assisted text as a structured draft, never ‘ready to submit.’")]),
      inputs: [fCheck("arrive", "Checked against the ARRIVE checklist")],
      validations: [],
    },
  ],
};
