import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

// --- Form fields -------------------------------------------------------------

const inputCls =
  "mt-1 w-full rounded-input border border-hairline bg-elevated px-3 py-2 text-base text-ink outline-none focus-visible:focus-ring disabled:opacity-50";

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  required,
  error,
  help,
  autoComplete,
  placeholder,
  disabled,
  inputMode,
  maxLength,
  autoFocus,
  note,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  error?: string;
  help?: string;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Which on-screen keyboard to offer, for example `numeric` for a one-time code. */
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  maxLength?: number;
  autoFocus?: boolean;
  /** Shown under the field and read out with it: a warning, or why the field cannot be changed. */
  note?: ReactNode;
}) {
  const id = useId();
  const describedBy = [note ? `${id}-note` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ");
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label} {required && <span className="text-danger" aria-hidden="true">*</span>}
      </label>
      {help && <p className="text-xs text-ink-muted">{help}</p>}
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        maxLength={maxLength}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
      {note && (
        <div id={`${id}-note`} className="mt-1 text-xs text-ink-soft">
          {note}
        </div>
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function PasswordField(props: Omit<Parameters<typeof TextField>[0], "type" | "inputMode" | "maxLength" | "autoFocus" | "note">) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {props.label} {props.required && <span className="text-danger" aria-hidden="true">*</span>}
      </label>
      {props.help && <p className="text-xs text-ink-muted">{props.help}</p>}
      <div className="relative mt-1">
        <input
          id={id}
          type={show ? "text" : "password"}
          value={props.value}
          required={props.required}
          autoComplete={props.autoComplete}
          placeholder={props.placeholder}
          disabled={props.disabled}
          aria-invalid={!!props.error}
          aria-describedby={props.error ? `${id}-err` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-full rounded-input border border-hairline bg-elevated px-3 py-2 pr-11 text-base text-ink outline-none focus-visible:focus-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-ink-soft hover:text-ink focus-visible:focus-ring"
        >
          {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      {props.error && (
        <p id={`${id}-err`} className="mt-1 text-xs font-medium text-danger">
          {props.error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  help?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {help && <p className="text-xs text-ink-muted">{help}</p>}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A small square button that shows only an icon. `label` is its accessible name and its tooltip. */
export function IconButton({ label, onClick, danger, disabled, children }: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid h-8 w-8 place-items-center rounded-input text-ink-soft transition-colors hover:bg-elevated focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${danger ? "hover:text-danger" : "hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
