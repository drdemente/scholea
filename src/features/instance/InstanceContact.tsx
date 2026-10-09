/**
 * How to reach the organisation behind the signed-in account, as its
 * administrator set it: a bar at the bottom of the User Guide, and an "About
 * this workspace" section in Settings.
 *
 * Both render nothing for a guest, in a build with no backend, and when the
 * organisation gave no details. What the administrator typed is only ever
 * shown as plain text, and the one link is a `mailto:` built by `safeMailto`.
 */
import type { ReactNode } from "react";
import { Building2, LifeBuoy } from "lucide-react";
import {
  ABOUT_CAPTION,
  ABOUT_HEADING,
  ABOUT_LABEL,
  HELP_CONTACT_LABEL,
  contactView,
  helpContact,
  supportLead,
  type SupportContact,
} from "@/lib/instance/instance-view";
import { useInstance } from "@/lib/instance/instance-store";

function SupportLink({ support }: { support: SupportContact }) {
  return (
    <a href={support.href} className="[overflow-wrap:anywhere] rounded-input font-medium text-ink underline underline-offset-2 hover:text-primary focus-visible:focus-ring">
      {support.email}
    </a>
  );
}

/** The bar at the bottom of the User Guide. */
export function HelpContact() {
  const instance = useInstance((s) => s.instance);
  const contact = helpContact(instance);
  if (!contact) return null;
  return (
    // A note, not a page footer: it sits in the guide's own panel.
    <div role="note" aria-label={HELP_CONTACT_LABEL} className="flex items-start gap-2.5 border-t border-hairline px-5 py-3 text-sm text-ink-soft">
      <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {contact.support && (
          <p>
            {supportLead(contact.orgName)} <SupportLink support={contact.support} />
          </p>
        )}
        {contact.contact && <p className="whitespace-pre-line break-words">{contact.contact}</p>}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-ink-soft sm:w-28">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

/** The "About this workspace" section of Settings. */
export function AboutWorkspace() {
  const instance = useInstance((s) => s.instance);
  const about = contactView(instance);
  if (!about) return null;
  return (
    <section className="mt-6">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Building2 className="h-4 w-4 text-ink-soft" aria-hidden="true" />
        {ABOUT_HEADING}
      </h3>
      <p className="mt-1 text-xs text-ink-soft">{ABOUT_CAPTION}</p>
      <dl className="mt-2 flex flex-col gap-2 rounded-input border border-hairline p-3 text-sm">
        {about.orgName && <Row label={ABOUT_LABEL.orgName}>{about.orgName}</Row>}
        {about.support && (
          <Row label={ABOUT_LABEL.support}>
            <SupportLink support={about.support} />
          </Row>
        )}
        {about.contact && (
          <Row label={ABOUT_LABEL.contact}>
            <span className="whitespace-pre-line">{about.contact}</span>
          </Row>
        )}
      </dl>
    </section>
  );
}
