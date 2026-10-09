/**
 * Relative-time formatter for last-login / timestamps. `none` is what to show
 * when there is no time at all: "Never" for a last login, for example.
 */
export function relTime(ms: number | null, none: string): string {
  if (!ms) return none;
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
