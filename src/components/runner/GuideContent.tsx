import { AlertTriangle, Lightbulb, Quote } from "lucide-react";
import type { GuideBlock, GuideContent as GuideContentT, Level } from "@/lib/study/types";
import { levelRank } from "@/lib/study/levels";

/**
 * Renders level-gated guide content (progressive disclosure of the same
 * canonical material). `basic` is always shown; `medium` and `advanced` blocks
 * appear as the user raises their level, each tagged so the disclosure is
 * legible.
 */
export function GuideContent({ guide, level }: { guide: GuideContentT; level: Level }) {
  const rank = levelRank[level];
  return (
    <div className="flex flex-col gap-3">
      {guide.basic.map((b, i) => (
        <Block key={`b-${i}`} block={b} />
      ))}

      {rank >= levelRank.medium && guide.medium && guide.medium.length > 0 && (
        <LevelGroup label="Medium" blocks={guide.medium} prefix="m" />
      )}
      {rank >= levelRank.advanced && guide.advanced && guide.advanced.length > 0 && (
        <LevelGroup label="Advanced" blocks={guide.advanced} prefix="a" />
      )}
    </div>
  );
}

function LevelGroup({ label, blocks, prefix }: { label: string; blocks: GuideBlock[]; prefix: string }) {
  return (
    <div className="flex flex-col gap-3 border-l-2 border-primary/30 pl-3">
      <span className="inline-flex w-fit items-center rounded-pill bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
        {label} detail
      </span>
      {blocks.map((b, i) => (
        <Block key={`${prefix}-${i}`} block={b} />
      ))}
    </div>
  );
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p className="max-w-prose leading-relaxed text-ink-soft">{block.text}</p>;

    case "list": {
      const cls = "ml-5 flex max-w-prose flex-col gap-1.5 text-ink-soft";
      const items = block.items.map((it, i) => (
        <li key={i} className="leading-relaxed">
          {it}
        </li>
      ));
      return block.ordered ? (
        <ol className={`${cls} list-decimal`}>{items}</ol>
      ) : (
        <ul className={`${cls} list-disc`}>{items}</ul>
      );
    }

    case "tip":
      return (
        <Callout icon={Lightbulb} tone="accent" label="Tip">
          {block.text}
        </Callout>
      );

    case "warning":
      return (
        <Callout icon={AlertTriangle} tone="warning" label="Watch out">
          {block.text}
        </Callout>
      );

    case "example":
      return (
        <figure className="max-w-prose rounded-input bg-sunken/60 p-3">
          <figcaption className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
            <Quote className="h-3.5 w-3.5" aria-hidden="true" />
            {block.title ?? "Example"}
          </figcaption>
          <p className="font-serif leading-relaxed text-ink">{block.text}</p>
        </figure>
      );
  }
}

function Callout({
  icon: Icon,
  tone,
  label,
  children,
}: {
  icon: typeof Lightbulb;
  tone: "accent" | "warning";
  label: string;
  children: React.ReactNode;
}) {
  const toneCls = tone === "accent" ? "bg-accent-soft text-accent" : "bg-warning-soft text-warning";
  return (
    <div className="flex max-w-prose items-start gap-2.5 rounded-input bg-elevated/60 p-3">
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-pill ${toneCls}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <p className="leading-relaxed text-ink-soft">
        <span className="font-semibold text-ink">{label}: </span>
        {children}
      </p>
    </div>
  );
}
