import { Plus, Tag, Trash2 } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import type { StepData } from "@/lib/study/types";

interface Theme { id: string; name: string; codes: string[] }

const SEED: Theme[] = [
  { id: "t1", name: "Perceived benefit", codes: ["calmer before exams", "better focus"] },
  { id: "t2", name: "Barriers to practice", codes: ["no time", "forgetting to practise"] },
];

const newId = (prefix: string) => `${prefix}${Math.abs(Math.floor((typeof performance !== "undefined" ? performance.now() : 1) * 1000)) % 100000}`;

/**
 * Lightweight thematic-coding workspace (qualitative). Group codes under themes
 * — the analytic move from raw codes to a theme structure. Persists to the step.
 */
export function CodingTool({ stepId }: { stepId: string }) {
  const project = useProject((s) => s.project);
  const setField = useProject((s) => s.setField);
  const persist = useProject((s) => s.persist);

  const themes = ((project?.stepData[stepId] as StepData)?.themes as Theme[]) ?? SEED;

  const save = (next: Theme[]) => {
    setField(stepId, "themes", next);
    setField(stepId, "themeCount", next.length);
    void persist();
  };

  const addTheme = () => save([...themes, { id: newId("t"), name: "New theme", codes: [] }]);
  const renameTheme = (id: string, name: string) => save(themes.map((t) => (t.id === id ? { ...t, name } : t)));
  const removeTheme = (id: string) => save(themes.filter((t) => t.id !== id));
  const addCode = (id: string, code: string) => {
    const c = code.trim();
    if (!c) return;
    save(themes.map((t) => (t.id === id ? { ...t, codes: [...t.codes, c] } : t)));
  };
  const removeCode = (id: string, code: string) =>
    save(themes.map((t) => (t.id === id ? { ...t, codes: t.codes.filter((x) => x !== code) } : t)));

  return (
    <div className="flex flex-col gap-3">
      {themes.map((t) => (
        <div key={t.id} className="rounded-input border border-hairline bg-elevated/40 p-3">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-primary" aria-hidden="true" />
            <input
              aria-label="Theme name"
              value={t.name}
              onChange={(e) => renameTheme(t.id, e.target.value)}
              className="flex-1 rounded-input bg-transparent px-1 py-0.5 font-medium text-ink outline-none focus-visible:focus-ring"
            />
            <button onClick={() => removeTheme(t.id)} aria-label="Remove theme"
              className="grid h-7 w-7 place-items-center rounded-input text-ink-muted hover:text-danger focus-visible:focus-ring">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {t.codes.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-pill bg-primary-soft py-0.5 pl-2.5 pr-1 text-sm text-primary">
                {c}
                <button onClick={() => removeCode(t.id, c)} aria-label={`Remove code ${c}`}
                  className="grid h-4 w-4 place-items-center rounded-pill hover:bg-primary/20 focus-visible:focus-ring">×</button>
              </span>
            ))}
            <input
              aria-label={`Add code to ${t.name}`}
              placeholder="add code + Enter"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addCode(t.id, (e.target as HTMLInputElement).value);
                  (e.target as HTMLInputElement).value = "";
                  e.preventDefault();
                }
              }}
              className="min-w-[10rem] flex-1 rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring"
            />
          </div>
        </div>
      ))}
      <div>
        <GlassButton variant="soft" size="sm" onClick={addTheme}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add theme
        </GlassButton>
      </div>
    </div>
  );
}
