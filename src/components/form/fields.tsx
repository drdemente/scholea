import { AlertCircle, Loader2, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { FieldSchema } from "@/lib/study/types";

/** Per-field AI writing assistance (BYO key). `enabled` reflects a configured
 *  key; `run` returns a context-aware draft for the given field. */
export interface FieldAssist {
  enabled: boolean;
  run: (field: FieldSchema, current: string) => Promise<string>;
}

export interface FieldProps {
  field: FieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  error?: string;
  assist?: FieldAssist;
}

/** A small "write with AI" affordance that appears over a focused text control. */
function AssistOverlay({
  show,
  busy,
  corner,
  onRun,
}: {
  show: boolean;
  busy: boolean;
  corner: "r" | "br";
  onRun: () => void;
}) {
  if (!show) return null;
  const pos = corner === "br" ? "bottom-2 right-2" : "right-2 top-1/2 -translate-y-1/2";
  return (
    <button
      type="button"
      aria-label="Write this field with AI"
      title="Write with AI — a draft from your AI key, grounded in your project"
      // Keep focus on the control so the overlay stays and typing can resume.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
      disabled={busy}
      className={`absolute ${pos} z-10 grid h-7 w-7 place-items-center rounded-input bg-elevated/95 text-accent shadow-sm ring-1 ring-hairline transition-colors hover:bg-accent-soft focus-visible:focus-ring disabled:opacity-60`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

const controlCls =
  "w-full rounded-input border bg-elevated/70 px-3 py-2 text-base text-ink placeholder:text-ink-muted outline-none transition-colors focus-visible:focus-ring";

function borderCls(invalid: boolean) {
  return invalid ? "border-danger" : "border-hairline";
}

/** Renders a single field by kind, with visible label, help text, and an
 *  inline, screen-reader-announced error. */
export function Field({ field, value, onChange, onBlur, error, assist }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assistErr, setAssistErr] = useState<string | null>(null);

  if (field.kind === "checkbox") {
    return <CheckboxField field={field} value={value} onChange={onChange} onBlur={onBlur} error={error} />;
  }

  const helpId = field.help ? `${field.id}-help` : undefined;
  const errId = error ? `${field.id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(" ") || undefined;
  const invalid = !!error;

  const canAssist = !!assist?.enabled && (field.kind === "text" || field.kind === "textarea" || field.kind === "tags");
  const currentStr = field.kind === "tags"
    ? (Array.isArray(value) ? (value as string[]).join(", ") : "")
    : String(value ?? "");

  const doAssist = async () => {
    if (!assist?.enabled) return;
    setBusy(true);
    setAssistErr(null);
    try {
      const out = (await assist.run(field, currentStr)).trim();
      if (out) {
        if (field.kind === "tags") {
          const items = out.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
          onChange(Array.from(new Set(items)));
        } else {
          onChange(out);
        }
        onBlur();
      }
    } catch (e) {
      setAssistErr(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setBusy(false);
    }
  };

  // Wrap a control so the AI affordance can float over it and appear on focus.
  const withAssist = (control: ReactNode, corner: "r" | "br") =>
    canAssist ? (
      <div
        className="relative"
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
        }}
      >
        {control}
        <AssistOverlay show={focused || busy} busy={busy} corner={corner} onRun={doAssist} />
      </div>
    ) : (
      control
    );

  return (
    <Labelled field={field} error={error} helpId={helpId} errId={errId}>
      {field.kind === "text" && withAssist(
        <input
          id={field.id}
          type="text"
          value={String(value ?? "")}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`${controlCls} ${canAssist ? "pr-11" : ""} ${borderCls(invalid)}`}
        />,
        "r",
      )}

      {field.kind === "textarea" && withAssist(
        <textarea
          id={field.id}
          rows={field.rows ?? 4}
          value={String(value ?? "")}
          placeholder={field.placeholder}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`${controlCls} resize-y ${borderCls(invalid)}`}
        />,
        "br",
      )}

      {field.kind === "number" && (
        <div className="flex items-center gap-2">
          <input
            id={field.id}
            type="number"
            inputMode="decimal"
            value={value === "" || value == null ? "" : String(value)}
            placeholder={field.placeholder}
            min={field.min}
            max={field.max}
            step={field.step}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
            onBlur={onBlur}
            className={`num-tabular ${controlCls} ${borderCls(invalid)}`}
          />
          {field.unit && <span className="shrink-0 text-sm text-ink-muted">{field.unit}</span>}
        </div>
      )}

      {field.kind === "select" && (
        <select
          id={field.id}
          value={String(value ?? "")}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`${controlCls} ${borderCls(invalid)}`}
        >
          <option value="" disabled>
            {field.placeholder ?? "Select…"}
          </option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {field.kind === "tags" && withAssist(
        <TagsInput
          id={field.id}
          value={Array.isArray(value) ? (value as string[]) : []}
          placeholder={field.placeholder}
          invalid={invalid}
          describedBy={describedBy}
          onChange={onChange}
          onBlur={onBlur}
          hasAssist={canAssist}
        />,
        "r",
      )}

      {assistErr && (
        <p role="alert" className="flex items-center gap-1 text-xs font-medium text-danger">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {assistErr}
        </p>
      )}
    </Labelled>
  );
}

function Labelled({
  field,
  error,
  helpId,
  errId,
  children,
}: {
  field: FieldSchema;
  error?: string;
  helpId?: string;
  errId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={field.id} className="text-sm font-medium text-ink">
        {field.label}
        {field.required && (
          <span className="text-danger" aria-hidden="true">
            {" *"}
          </span>
        )}
      </label>
      {field.help && (
        <p id={helpId} className="text-xs text-ink-muted">
          {field.help}
        </p>
      )}
      {children}
      {error && (
        <p id={errId} role="alert" className="flex items-center gap-1 text-xs font-medium text-danger">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function CheckboxField({ field, value, onChange, onBlur, error }: FieldProps) {
  const errId = error ? `${field.id}-err` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={field.id} className="flex items-start gap-2.5 text-sm text-ink">
        <input
          id={field.id}
          type="checkbox"
          checked={value === true}
          aria-invalid={!!error}
          aria-describedby={errId}
          onChange={(e) => onChange(e.target.checked)}
          onBlur={onBlur}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-[6px] accent-[var(--color-primary)] focus-visible:focus-ring"
        />
        <span>
          <span className="font-medium">{field.label}</span>
          {field.help && <span className="mt-0.5 block text-xs text-ink-muted">{field.help}</span>}
        </span>
      </label>
      {error && (
        <p id={errId} role="alert" className="flex items-center gap-1 text-xs font-medium text-danger">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function TagsInput({
  id,
  value,
  placeholder,
  invalid,
  describedBy,
  onChange,
  onBlur,
  hasAssist,
}: {
  id: string;
  value: string[];
  placeholder?: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: string[]) => void;
  onBlur: () => void;
  hasAssist?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  const remove = (t: string) => onChange(value.filter((x) => x !== t));

  return (
    <div className={`flex flex-wrap items-center gap-1.5 rounded-input border bg-elevated/70 p-1.5 ${hasAssist ? "pr-11" : ""} ${borderCls(invalid)}`}>
      {value.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-pill bg-primary-soft py-0.5 pl-2.5 pr-1 text-sm text-primary"
        >
          {t}
          <button
            type="button"
            aria-label={`Remove ${t}`}
            onClick={() => remove(t)}
            className="grid h-4 w-4 place-items-center rounded-pill hover:bg-primary/20 focus-visible:focus-ring"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={value.length === 0 ? placeholder : ""}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={() => {
          add();
          onBlur();
        }}
        className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-base text-ink placeholder:text-ink-muted outline-none"
      />
    </div>
  );
}
