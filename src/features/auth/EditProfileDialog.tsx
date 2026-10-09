import { useEffect, useRef, useState, type FormEvent } from "react";
import { GlassButton, GlassOverlay } from "@/components/glass";
import { ErrorNote, TextField, toast } from "@/components/ui";
import { PROFILE_FIELD_MAX, describeProfileError, profileChanges, profileFields, type ProfileEdit } from "@/lib/account/account-view";
import { useSession } from "@/lib/account/session-store";
import { focusFirstField } from "./focus";

const TITLE_ID = "account-profile-title";

/**
 * The person's own name and institution, as the account holds them. The name
 * is what collaborators see beside comments, sign-offs and membership. It can
 * be somebody else's choice: an address can be registered before its owner
 * confirms it, and the account keeps the name it was registered with. This is
 * where the owner puts it right.
 *
 * `onClose` must keep its identity between renders (see `GlassOverlay`).
 */
export function EditProfileDialog({ profile, onClose }: { profile: ProfileEdit; onClose: () => void }) {
  const updateMyProfile = useSession((s) => s.updateMyProfile);
  const [name, setName] = useState(profile.name);
  const [institution, setInstitution] = useState(profile.institution);
  const [fields, setFields] = useState<Partial<Record<keyof ProfileEdit, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => focusFirstField(() => form.current), []);
  // A field that needs attention: back to it.
  useEffect(() => {
    if (attempt > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const edit = { name, institution };
    const problems = profileFields(edit);
    setFields(problems);
    if (Object.keys(problems).length > 0) {
      setAttempt((n) => n + 1);
      return;
    }
    const changes = profileChanges(profile, edit);
    if (Object.keys(changes).length === 0) return onClose();
    setBusy(true);
    try {
      await updateMyProfile(changes);
      toast.success("Profile saved.");
      onClose();
    } catch (err) {
      setError(describeProfileError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassOverlay open onClose={onClose} labelledBy={TITLE_ID} className="max-h-[calc(100dvh-2rem)] w-full !max-w-sm overflow-y-auto !p-6">
      <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 id={TITLE_ID} className="text-lg font-bold text-ink">
          Edit profile
        </h2>
        <TextField
          label="Your name"
          value={name}
          onChange={setName}
          required
          autoComplete="name"
          maxLength={PROFILE_FIELD_MAX}
          error={fields.name}
          help="Shown to the people you work with, beside your comments and sign-offs."
        />
        <TextField
          label="Institution"
          value={institution}
          onChange={setInstitution}
          autoComplete="organization"
          maxLength={PROFILE_FIELD_MAX}
          error={fields.institution}
          help="Optional."
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" size="sm" loading={busy}>
            Save
          </GlassButton>
        </div>
      </form>
    </GlassOverlay>
  );
}
