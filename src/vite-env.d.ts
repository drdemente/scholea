/// <reference types="vite/client" />

// Side-effect CSS imports from @fontsource-variable packages.
declare module "@fontsource-variable/*";

// Build-time settings for the optional account backend (Supabase). Both values
// are public by design. A missing or empty value means "not configured": the
// app is then the guest-only build with no account UI and no backend requests.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy name for the publishable key. Read only as a fallback. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
