/**
 * Scholea — local-first storage (Dexie / IndexedDB).
 *
 * The research core persists everything here and works fully offline. An
 * optional account layers sync on top without the core depending on it (§1, §10).
 * Every meaningful action is attributed + timestamped in `auditLog` regardless
 * of connectivity (§10 "who did what" ledger).
 */
import Dexie, { type EntityTable } from "dexie";

export type StudyTypeId =
  | "systematic-review"
  | "meta-analysis"
  | "scoping-review"
  | "narrative-review"
  | "umbrella-review"
  | "cross-sectional"
  | "cohort"
  | "case-control"
  | "rct"
  | "quasi-experimental"
  | "case-report"
  | "diagnostic-accuracy"
  | "qualitative"
  | "survey"
  | "mixed-methods";

export interface Project {
  id: string;
  title: string;
  studyType: StudyTypeId;
  /** Map of stepId → arbitrary captured inputs for that step. */
  stepData: Record<string, unknown>;
  /** Map of stepId → completion + validation status. */
  stepStatus: Record<string, { complete: boolean; needsAttention: boolean }>;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry {
  id?: number;
  projectId: string;
  /** A display name: the one set on this device ("local" when there is none), or the account's name for what is written on an account project. */
  actor: string;
  action: string;
  detail?: string;
  timestamp: number;
}

export interface AppSetting {
  key: string;
  /** Plain settings only. API keys are not kept in this table: they go through `platform.secureSet`. */
  value: unknown;
}

export type CollaboratorRole = "researcher" | "supervisor";

/**
 * Where a comment or sign-off row came from. `local`: written on this device
 * for a project kept on this device. `server`: a copy of what the project's
 * team has in the account, written only by sync. A row without the field is
 * treated as `local`.
 */
export type RowOrigin = "local" | "server";

/** A per-step discussion comment (§10), attributed + timestamped, offline-first. */
export interface Comment {
  id?: number;
  projectId: string;
  stepId: string;
  author: string;
  /** The role the author gave themselves on this device. Copies of team comments have none. */
  role?: CollaboratorRole;
  text: string;
  timestamp: number;
  origin?: RowOrigin;
  /** The comment's id in the account. Set only when `origin` is `server`. */
  uid?: string;
  /** The account that wrote it. Names are free text: this says who it was. */
  authorId?: string;
}

export type ReviewStatus = "approved" | "changes";

/** A supervisor/mentor sign-off on one step (§9 Supervisor role, §10 review). */
export interface Review {
  /** `${projectId}:${stepId}` — one current review per step. */
  id: string;
  projectId: string;
  stepId: string;
  status: ReviewStatus;
  reviewer: string;
  note?: string;
  timestamp: number;
  origin?: RowOrigin;
  /** The account that signed off. */
  reviewerId?: string;
}

/**
 * A comment or sign-off written for a project that is in an account, waiting
 * to be uploaded. Written only by what the person does; removed once the
 * account has it.
 */
export interface OutboxItem {
  /** A comment: its id (a UUID), which the account then uses too. A sign-off: one key per project, step and account. */
  uid: string;
  kind: "comment" | "review";
  /** The project's id on this device. */
  projectId: string;
  stepId: string;
  /** The account that wrote it. Nobody else's session may upload it. */
  queuedBy: string;
  queuedAt: number;
  text?: string;
  status?: ReviewStatus;
  note?: string;
  /** A sign-off: the time of the team's sign-off that was on screen when this one was made, or null when there was none. */
  baseAt?: number | null;
  attempts: number;
  /** Why the account refused it. Not tried again until the person asks. */
  error?: string;
}

/** A member of a project's team, as last read from the account. */
export interface CollabMember {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** What this device knows about the last sync of one project's comments and sign-offs. */
export interface CollabSyncState {
  /** The project's id on this device. */
  projectId: string;
  /** When the team's comments and sign-offs were last read in full. */
  pulledAt: number | null;
  /** The account's change marker for them, as it stood at that read. */
  stamp: number | null;
  /** Why the last sync stopped, when it did. */
  error?: string;
  /** The team at the last read, to show who wrote what. */
  members?: CollabMember[];
}

const db = new Dexie("scholea") as Dexie & {
  projects: EntityTable<Project, "id">;
  auditLog: EntityTable<AuditEntry, "id">;
  settings: EntityTable<AppSetting, "key">;
  comments: EntityTable<Comment, "id">;
  reviews: EntityTable<Review, "id">;
  outbox: EntityTable<OutboxItem, "uid">;
  collabSync: EntityTable<CollabSyncState, "projectId">;
};

db.version(1).stores({
  projects: "id, studyType, updatedAt",
  auditLog: "++id, projectId, timestamp",
  settings: "key",
});

// v2 adds the local-first collaboration layer (comments + supervisor reviews).
db.version(2).stores({
  projects: "id, studyType, updatedAt",
  auditLog: "++id, projectId, timestamp",
  settings: "key",
  comments: "++id, projectId, [projectId+stepId], timestamp",
  reviews: "id, projectId",
});

// v3 lets comments and sign-offs sync between the members of an account
// project: rows say where they came from, team comments are found by their
// account id (`uid`, unique; rows without one are not indexed), and two stores
// hold what is waiting to upload and how far each project has been read.
// Nothing already on the device is removed or re-keyed.
db.version(3)
  .stores({
    projects: "id, studyType, updatedAt",
    auditLog: "++id, projectId, timestamp",
    settings: "key",
    comments: "++id, projectId, [projectId+stepId], timestamp, &uid",
    reviews: "id, projectId",
    outbox: "uid, projectId, [projectId+stepId]",
    collabSync: "projectId",
  })
  .upgrade(async (tx) => {
    await tx
      .table("comments")
      .toCollection()
      .modify((c) => {
        if (!c.origin) c.origin = "local";
      });
    await tx
      .table("reviews")
      .toCollection()
      .modify((r) => {
        if (!r.origin) r.origin = "local";
      });
  });

export { db };

/** Append an attributed, timestamped entry to the local audit log. */
export async function logAction(
  projectId: string,
  action: string,
  detail?: string,
  actor = "local",
): Promise<void> {
  await db.auditLog.add({ projectId, actor, action, detail, timestamp: Date.now() });
}
