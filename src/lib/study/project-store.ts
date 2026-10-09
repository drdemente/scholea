/**
 * Project store — the in-memory working copy of the active project, backed by
 * Dexie. The project carries its `studyType`; the store resolves the matching
 * config from the registry, so the runner is fully data-driven (it never names
 * a study type). Supports multiple projects with an active selection.
 */
import { create } from "zustand";
import { db, logAction, type Project, type StudyTypeId } from "@/lib/db/schema";
import { purgeProjectCollab } from "@/lib/collab/collab";
import { actorName } from "@/lib/collab/identity-store";
import { configById } from "./registry";
import type { StepData, StudyTypeConfig } from "./types";

const ACTIVE_KEY = "scholea.activeProject";

interface ProjectStore {
  project: Project | null;
  config: StudyTypeConfig | null;
  activeStepId: string;
  loading: boolean;

  /** Load the active project (from localStorage), or leave null for the chooser. */
  loadActive: () => Promise<void>;
  /** Every saved project, newest-touched first — for the Projects screen. */
  listProjects: () => Promise<Project[]>;
  createProject: (studyType: StudyTypeId, title?: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setActiveStep: (id: string) => void;
  setField: (stepId: string, fieldId: string, value: unknown) => void;
  persist: () => Promise<void>;
  markComplete: (stepId: string, nextStepId?: string) => Promise<void>;
  /** Wipe a step's captured data + status so it starts over (tools re-derive
   *  their inputs from earlier steps automatically). */
  resetStep: (stepId: string) => Promise<void>;
  getStepData: (stepId: string) => StepData;
}

function applyProject(project: Project): { config: StudyTypeConfig | null; activeStepId: string } {
  const config = configById(project.studyType) ?? null;
  return { config, activeStepId: config?.steps[0]?.id ?? "" };
}

export const useProject = create<ProjectStore>((set, get) => ({
  project: null,
  config: null,
  activeStepId: "",
  loading: true,

  async loadActive() {
    const id = localStorage.getItem(ACTIVE_KEY);
    if (!id) {
      set({ loading: false });
      return;
    }
    const project = await db.projects.get(id);
    if (!project) {
      localStorage.removeItem(ACTIVE_KEY);
      set({ loading: false });
      return;
    }
    set({ project, ...applyProject(project), loading: false });
  },

  async listProjects() {
    const all = await db.projects.toArray();
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  async createProject(studyType, title) {
    const config = configById(studyType);
    const id = `proj-${studyType}-${Math.abs(hashNow())}`;
    const now = Date.now();
    const project: Project = {
      id,
      title: title || `New ${config?.label ?? "study"}`,
      studyType,
      stepData: {},
      stepStatus: {},
      createdAt: now,
      updatedAt: now,
    };
    await db.projects.put(project);
    await logAction(id, "project.create", config?.label ?? studyType, actorName());
    localStorage.setItem(ACTIVE_KEY, id);
    set({ project, ...applyProject(project), loading: false });
  },

  async switchProject(id) {
    const project = await db.projects.get(id);
    if (!project) return;
    localStorage.setItem(ACTIVE_KEY, id);
    set({ project, ...applyProject(project), loading: false });
  },

  async deleteProject(id) {
    await db.projects.delete(id);
    // Its comments, sign-offs and anything still waiting to upload go with it.
    await purgeProjectCollab(id).catch(() => {});
    await logAction(id, "project.delete", "", actorName());
    if (localStorage.getItem(ACTIVE_KEY) === id) {
      localStorage.removeItem(ACTIVE_KEY);
      if (get().project?.id === id) set({ project: null, config: null, activeStepId: "" });
    }
  },

  setActiveStep(id) {
    set({ activeStepId: id });
  },

  setField(stepId, fieldId, value) {
    const p = get().project;
    if (!p) return;
    const stepData: StepData = { ...((p.stepData[stepId] as StepData) ?? {}), [fieldId]: value };
    set({ project: { ...p, stepData: { ...p.stepData, [stepId]: stepData } } });
  },

  async persist() {
    const p = get().project;
    if (p) await db.projects.put({ ...p, updatedAt: Date.now() });
  },

  async markComplete(stepId, nextStepId) {
    const p = get().project;
    if (!p) return;
    const next: Project = {
      ...p,
      stepStatus: { ...p.stepStatus, [stepId]: { complete: true, needsAttention: false } },
      updatedAt: Date.now(),
    };
    set(nextStepId ? { project: next, activeStepId: nextStepId } : { project: next });
    await db.projects.put(next);
    await logAction(p.id, "step.complete", stepId, actorName());
  },

  async resetStep(stepId) {
    const p = get().project;
    if (!p) return;
    const stepData = { ...p.stepData };
    delete stepData[stepId];
    const stepStatus = { ...p.stepStatus };
    delete stepStatus[stepId];
    const next: Project = { ...p, stepData, stepStatus, updatedAt: Date.now() };
    set({ project: next });
    await db.projects.put(next);
    await logAction(p.id, "step.reset", stepId, actorName());
  },

  getStepData(stepId) {
    return (get().project?.stepData[stepId] as StepData) ?? {};
  },
}));

/** A monotonic-ish id seed that avoids the Date.now sandbox restriction. */
function hashNow(): number {
  // performance.now is allowed and gives enough entropy for a local id.
  const t = typeof performance !== "undefined" ? performance.now() : 1;
  return Math.floor(t * 1000) % 2147483647;
}
