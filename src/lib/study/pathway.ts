/**
 * Derives the live Pathway Map state from a study-type config + the project's
 * progress. This is the bridge between the methodology-blind engine and the
 * signature navigation element — the Pathway Map needs no knowledge of study
 * types, only the derived states.
 */
import type { PathwayState, PathwayStep } from "@/components/pathway/PathwayMap";
import type { Project } from "@/lib/db/schema";
import type { StepData, StudyTypeConfig } from "./types";
import { hasErrors, runChecks } from "./validation";

export function derivePathway(
  config: StudyTypeConfig,
  project: Project,
  activeId: string,
): PathwayStep[] {
  const completedIdx = config.steps.map((s, i) =>
    project.stepStatus[s.id]?.complete ? i : -1,
  );
  const activeIndex = config.steps.findIndex((s) => s.id === activeId);
  const unlockedThrough = Math.max(activeIndex, ...completedIdx);

  return config.steps.map((step, i) => {
    const data = (project.stepData[step.id] as StepData) ?? {};
    const stepHasError = hasErrors(runChecks(step.validations, data));
    const completed = project.stepStatus[step.id]?.complete ?? false;

    let state: PathwayState;
    if (step.id === activeId) state = "active";
    else if (completed && !stepHasError) state = "complete";
    else if (completed && stepHasError) state = "needs-attention";
    else if (i <= unlockedThrough + 1) state = "available";
    else state = "locked";

    return { id: step.id, index: i + 1, title: step.title, short: step.short, state };
  });
}
