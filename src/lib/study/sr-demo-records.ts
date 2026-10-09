/**
 * Demo records for the screening interface — used as a fallback before a real
 * search has been run (the live data backbone is wired in §4). Titles/abstracts
 * are illustrative. Shaped as WorkRecord so screening treats demo and real
 * records identically.
 */
import type { WorkRecord } from "@/lib/sources/types";

const raw: Array<Omit<WorkRecord, "source" | "authors"> & { authors: string }> = [
  {
    id: "rec-01",
    title: "An 8-week mindfulness programme and exam anxiety in undergraduates: a randomised controlled trial",
    authors: "Okafor R, Lindqvist M, Haddad S",
    year: 2024,
    journal: "Journal of College Student Mental Health",
    abstract:
      "Undergraduates (n=212) were randomised to an 8-week mindfulness-based stress reduction programme or a waitlist control. Self-reported exam anxiety (TAI) fell significantly more in the intervention arm at 12 weeks.",
  },
  {
    id: "rec-02",
    title: "Mindfulness apps for test anxiety in high-school students: a feasibility study",
    authors: "Pereira L, Osei K",
    year: 2023,
    journal: "Digital Mental Health",
    abstract:
      "A single-arm feasibility study of a smartphone mindfulness app among 38 high-school students. Population is secondary, not tertiary; included here to test screeners’ handling of the age boundary.",
  },
  {
    id: "rec-03",
    title: "Caffeine intake and examination performance in medical students",
    authors: "Demir A, Whitfield J",
    year: 2022,
    journal: "Nutrition & Behaviour",
    abstract:
      "Cross-sectional survey of caffeine use and self-reported performance. No mindfulness intervention; clearly off-topic for an intervention review on anxiety.",
  },
  {
    id: "rec-04",
    title: "Mindfulness meditation versus relaxation training for university exam stress",
    authors: "Nakamura H, Bianchi P, Ali R",
    year: 2025,
    journal: "Anxiety Research",
    abstract:
      "RCT comparing mindfulness meditation with progressive muscle relaxation in 164 university students. Both reduced anxiety; mindfulness showed a larger effect on the STAI state subscale.",
  },
  {
    id: "rec-05",
    title: "Yoga and breathing exercises for academic stress: a systematic review",
    authors: "Kaur S, Almeida T",
    year: 2023,
    journal: "Complementary Therapies in Education",
    abstract:
      "A review of yoga interventions. Not a primary study and not specifically mindfulness; useful as a borderline record for reference-chasing rather than inclusion.",
  },
  {
    id: "rec-06",
    title: "Brief mindfulness inductions before exams: effects on state anxiety in college students",
    authors: "Romero V, Tanaka Y",
    year: 2024,
    journal: "Cognition and Emotion in Education",
    abstract:
      "Randomised crossover study of a 10-minute mindfulness induction immediately before a mock exam (n=90 college students). State anxiety measured pre/post.",
  },
  {
    id: "rec-07",
    title: "Sleep hygiene workshops and exam outcomes in nursing students",
    authors: "Ferreira C, Mbeki N",
    year: 2021,
    journal: "Nurse Education Today",
    abstract:
      "Quasi-experimental study of a sleep-hygiene workshop. Intervention is not mindfulness; outcome is grades, not anxiety. Off-topic on two counts.",
  },
  {
    id: "rec-08",
    title: "Mindfulness-based cognitive therapy for exam anxiety: a pilot RCT in postgraduate students",
    authors: "Hassan I, Lund E",
    year: 2025,
    journal: "Behaviour Research and Therapy",
    abstract:
      "Pilot RCT (n=54) of MBCT versus usual support in postgraduate students with high exam anxiety. Significant reduction in self-reported anxiety at 8 weeks.",
  },
  {
    id: "rec-09",
    title: "Prevalence of test anxiety among university students: a cross-sectional survey",
    authors: "Garcia M, Ito S",
    year: 2022,
    journal: "Journal of Educational Psychology",
    abstract:
      "Descriptive prevalence survey. No intervention and no comparator — relevant background, but not eligible for an effectiveness review.",
  },
  {
    id: "rec-10",
    title: "Group mindfulness training and self-reported exam anxiety in first-year students: a controlled trial",
    authors: "Bauer F, Qadir N, Olsen H",
    year: 2024,
    journal: "Higher Education Wellbeing",
    abstract:
      "Non-randomised controlled trial of a group mindfulness programme in first-year undergraduates (n=120). Anxiety measured with the TAI at baseline and end of term.",
  },
];

export const demoRecords: WorkRecord[] = raw.map((r) => ({
  ...r,
  source: "demo",
  authors: r.authors.split(/,\s*/),
}));
