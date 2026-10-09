import type { ToolId } from "@/lib/study/types";
import { SearchTool } from "./SearchTool";
import { DedupTool } from "./DedupTool";
import { ScreeningTool } from "./ScreeningTool";
import { AppraisalTool } from "./AppraisalTool";
import { SynthesisTool } from "./SynthesisTool";
import { PrismaFlow } from "./PrismaFlow";
import { ConsortFlow } from "./ConsortFlow";
import { DiagnosticTool } from "./DiagnosticTool";
import { CodingTool } from "./CodingTool";
import { ReliabilityTool } from "./ReliabilityTool";
import { FeasibilityTool } from "./FeasibilityTool";
import { StrobeFlow } from "./StrobeFlow";
import { GeneralStatsTool } from "./GeneralStatsTool";
import { FulltextTool } from "./FulltextTool";
import { SampleSizeTool } from "./SampleSizeTool";

/**
 * Tool registry. The engine resolves a step's `tool` to a component here; each
 * tool reads/writes the step's data through the project store, so the engine
 * never learns anything study-type-specific.
 */
export function ToolHost({ tool, stepId }: { tool: ToolId; stepId: string }) {
  switch (tool) {
    case "search":
      return <SearchTool stepId={stepId} />;
    case "dedup":
      return <DedupTool stepId={stepId} />;
    case "screening":
      return <ScreeningTool stepId={stepId} />;
    case "appraisal":
      return <AppraisalTool stepId={stepId} />;
    case "synthesis":
      return <SynthesisTool stepId={stepId} />;
    case "prisma":
      return <PrismaFlow />;
    case "consort":
      return <ConsortFlow stepId={stepId} />;
    case "diagnostic":
      return <DiagnosticTool stepId={stepId} />;
    case "coding":
      return <CodingTool stepId={stepId} />;
    case "reliability":
      return <ReliabilityTool stepId={stepId} />;
    case "feasibility":
      return <FeasibilityTool stepId={stepId} />;
    case "strobeflow":
      return <StrobeFlow stepId={stepId} />;
    case "generalstats":
      return <GeneralStatsTool stepId={stepId} />;
    case "fulltext":
      return <FulltextTool stepId={stepId} />;
    case "samplesize":
      return <SampleSizeTool stepId={stepId} />;
    default:
      return null;
  }
}
