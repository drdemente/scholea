import { orgNameOf } from "@/lib/instance/instance-view";
import { useInstance } from "@/lib/instance/instance-store";

/**
 * The Scholea wordmark of the research app's headers. For someone signed in to
 * an organisation that set a name, the name follows it. The product keeps its
 * own name either way, and a guest sees the wordmark alone.
 */
export function Wordmark() {
  const orgName = useInstance((s) => orgNameOf(s.instance));
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-input bg-primary text-ink-onBrand shadow-glow-primary">
        <span className="font-display text-lg font-bold">S</span>
      </span>
      <span className="shrink-0 font-display text-lg font-bold tracking-tight text-ink">Scholea</span>
      {orgName && (
        // The first thing to give way in a narrow header: it shortens, then goes below `sm`.
        <span title={orgName} className="hidden min-w-0 max-w-[14rem] truncate text-sm font-medium text-ink sm:block">
          <span aria-hidden="true">· </span>
          {orgName}
        </span>
      )}
    </div>
  );
}
