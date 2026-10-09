import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Copy, Download, ScrollText, ShieldAlert, X } from "lucide-react";
import { GlassButton } from "@/components/glass";
import { useProject } from "@/lib/study/project-store";
import { useSettings } from "@/lib/settings/settings-store";
import { platform } from "@/lib/platform";
import { anonymisationPlan, consentForm, irbScaffold, type EthicsInput } from "@/lib/ethics/ethics";

type DocId = "consent" | "irb" | "anon";
const DOCS: { id: DocId; label: string; file: string }[] = [
  { id: "consent", label: "Consent form", file: "consent-form.txt" },
  { id: "irb", label: "Ethics / IRB scaffold", file: "ethics-application.txt" },
  { id: "anon", label: "Anonymisation plan", file: "anonymisation-plan.txt" },
];

const FIELDS: { key: keyof EthicsInput; label: string; area?: boolean }[] = [
  { key: "title", label: "Study title" },
  { key: "investigator", label: "Investigator (name, role)" },
  { key: "institution", label: "Institution / department" },
  { key: "contactEmail", label: "Contact email" },
  { key: "population", label: "Participants & eligibility", area: true },
  { key: "procedures", label: "What participants will do", area: true },
  { key: "risks", label: "Risks & discomforts", area: true },
  { key: "benefits", label: "Benefits", area: true },
  { key: "dataTypes", label: "Data collected", area: true },
];

/**
 * Ethics document generator — a global helper for the documents students most
 * often stall on. Generated from pure templates; honest about being drafts to
 * adapt, never approved or legally vetted text.
 */
export function EthicsDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const contactEmail = useSettings((s) => s.contactEmail);

  const [input, setInput] = useState<EthicsInput>({
    title: project?.title ?? "",
    investigator: "",
    institution: "",
    population: "",
    procedures: "",
    risks: "",
    benefits: "",
    dataTypes: "",
    contactEmail: contactEmail,
    identifiable: false,
  });
  const [doc, setDoc] = useState<DocId>("consent");
  const [copied, setCopied] = useState(false);

  const text = useMemo(() => {
    if (doc === "consent") return consentForm(input);
    if (doc === "irb") return irbScaffold(input);
    return anonymisationPlan(input);
  }, [doc, input]);

  const set = (key: keyof EthicsInput, value: string | boolean) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  const active = DOCS.find((d) => d.id === doc)!;

  return (
    <motion.div
      className="fixed inset-0 z-modal overflow-y-auto p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button aria-label="Close" className="fixed inset-0 -z-10 bg-scrim" onClick={onClose} />
      <div className="mx-auto my-6 w-full max-w-4xl">
        <div className="glass-2 glass-highlight rounded-modal p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 className="mr-auto text-lg font-bold text-ink">Ethics documents</h2>
            <GlassButton variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="!px-2">
              <X className="h-5 w-5" aria-hidden="true" />
            </GlassButton>
          </div>

          <p className="mb-4 flex items-start gap-2 rounded-input bg-warning-soft p-3 text-sm text-ink">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            Drafts to adapt, not approved or legally vetted. Use your committee's official forms and confirm
            against your institution's policy and applicable law before submitting.
          </p>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            {/* Inputs */}
            <div className="flex flex-col gap-3">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label htmlFor={`eth-${f.key}`} className="text-xs font-medium text-ink-soft">{f.label}</label>
                  {f.area ? (
                    <textarea
                      id={`eth-${f.key}`}
                      rows={2}
                      value={input[f.key] as string}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-sm text-ink outline-none focus-visible:focus-ring"
                    />
                  ) : (
                    <input
                      id={`eth-${f.key}`}
                      value={input[f.key] as string}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="mt-1 w-full rounded-input border border-hairline bg-elevated/70 px-3 py-2 text-sm text-ink outline-none focus-visible:focus-ring"
                    />
                  )}
                </div>
              ))}
              <label className="flex items-start gap-2.5 rounded-input border border-hairline bg-elevated/40 p-3">
                <input
                  type="checkbox"
                  checked={input.identifiable}
                  onChange={(e) => set("identifiable", e.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-[var(--color-primary)] focus-visible:focus-ring"
                />
                <span className="text-sm text-ink">
                  This study collects identifiable or pseudonymised data
                  <span className="block text-xs text-ink-muted">Adds the relevant data-protection wording (GDPR/DPIA prompts).</span>
                </span>
              </label>
            </div>

            {/* Output */}
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="eth-doc" className="text-sm text-ink-soft">Document</label>
                <select
                  id="eth-doc"
                  value={doc}
                  onChange={(e) => setDoc(e.target.value as DocId)}
                  className="rounded-input border border-hairline bg-elevated/70 px-2 py-1 text-sm text-ink outline-none focus-visible:focus-ring"
                >
                  {DOCS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
                <div className="ml-auto flex gap-2">
                  <GlassButton
                    variant="soft"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(text);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" /> {copied ? "Copied" : "Copy"}
                  </GlassButton>
                  <GlassButton variant="soft" size="sm" onClick={() => platform.saveFile(active.file, text)}>
                    <Download className="h-4 w-4" aria-hidden="true" /> Download
                  </GlassButton>
                </div>
              </div>
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-input border border-hairline bg-canvas/60 p-3 font-mono text-xs leading-relaxed text-ink">
                {text}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
