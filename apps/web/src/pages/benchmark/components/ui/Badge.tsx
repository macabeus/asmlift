// The benchmark's badges: a <Pill> plus the domain rule that picks its color.
import { FEATURE_BY_ID, type GapSize, type Outcome } from '@asmlift/bench-schema';
import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { parseVariation, variationToken } from '@asmlift/core/variation-tokens';

import { HoverCard } from '../../../../shared/components/HoverCard';
import { Pill } from '../../../../shared/components/Pill';
import { variationHref } from '../../lib/explorer-url';
import { GAP_BUCKETS, GAP_BUCKET_COLOR, OUTCOME_COLOR, OUTCOME_LABEL, VARIATION_KIND_COLOR } from '../../theme';
import { InlineCode } from './InlineCode';
import { followInPlace } from './follow-in-place';

/** Solid-dot + tinted-pill badge, colored by outcome. */
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return (
    <Pill tint={OUTCOME_COLOR[outcome]} dot>
      {OUTCOME_LABEL[outcome]}
    </Pill>
  );
}

/** Measured gap-size pill: differing / total objdiff instruction rows of the best scored candidate. */
export function GapBadge({ gap }: { gap: GapSize }) {
  const bucket = GAP_BUCKETS.find((b) => gap.score <= b.max) ?? GAP_BUCKETS[GAP_BUCKETS.length - 1];
  return (
    <Pill
      tint={GAP_BUCKET_COLOR[bucket.key]}
      mono
      title={`best compiling candidate: ${gap.decompiler}, ${(gap.ratio * 100).toFixed(0)}% of instructions differ`}
    >
      {gap.score}/{gap.maxScore}
    </Pill>
  );
}

/** Neutral tag chip. */
export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <Pill mono size="xs">
      {children}
    </Pill>
  );
}

/** One published variation, subject and all (`coalesce-v0-v1`), tinted by its kind: hover for the
 *  definition, click for the variation's drawer. Both are real links to that drawer over the
 *  reader's view (`hash`, from `useCurrentHash`), so closing the drawer returns to the view the chip
 *  sat in. `dim` is a variation the winner does not carry: neutral, so it never reads as part of the
 *  winning spelling. */
export function VariationChip({
  part,
  hash,
  onOpen,
  dim = false,
}: {
  part: string;
  hash: string;
  onOpen: (name: string) => void;
  dim?: boolean;
}) {
  const { name, subject } = parseVariation(part);
  const def = VARIATION_DEFINITIONS[name];
  const href = variationHref(name, hash);
  const follow = (e: React.MouseEvent) => followInPlace(e, () => onOpen(name));

  return (
    <HoverCard
      content={
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-white">
              <InlineCode text={def.title} />
            </span>
            <Pill mono size="xs">
              {name}
            </Pill>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300 first-letter:uppercase">
            <InlineCode text={def.summary} />
          </p>
          {subject !== undefined && def.subject && (
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              <span className="font-mono text-slate-200">{subject}</span>: <InlineCode text={def.subject.meaning} />
            </p>
          )}
          <a
            href={href}
            onClick={follow}
            className="mt-2 inline-block text-[11px] font-medium text-teal-400 hover:text-teal-300"
          >
            read more →
          </a>
        </>
      }
    >
      <a href={href} onClick={follow} className="rounded focus-visible:outline-1 focus-visible:outline-teal-400">
        <Pill
          mono
          size="xs"
          tint={dim ? undefined : VARIATION_KIND_COLOR[variationToken(name).variationKind]}
          className={dim ? 'text-slate-400 hover:text-slate-200' : 'hover:brightness-125'}
        >
          {part}
        </Pill>
      </a>
    </HoverCard>
  );
}

/** A feature tag: hover for the summary and a link into the full definition, click for the
 *  definition directly. Shows the id rather than the human label — it is what the URL, the dataset
 *  and the vocabulary key on, and a table of 743 rows has no room for prose. */
export function FeatureChip({ id, onClick }: { id: string; onClick?: (id: string) => void }) {
  const def = FEATURE_BY_ID.get(id);

  if (!def) {
    // Unreachable from published data (closed vocabulary, enforced by tests), so if one appears it
    // should look like the bug it is.
    return (
      <Pill mono size="xs" tint="#fcd34d" title={`${id} — no definition, which is a bug`}>
        {id}
      </Pill>
    );
  }

  return (
    <HoverCard
      content={
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-white">{def.label}</span>
            <Pill mono size="xs">
              {def.id}
            </Pill>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{def.summary}</p>
          {onClick && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClick(def.id);
              }}
              className="mt-2 text-[11px] font-medium text-teal-400 hover:text-teal-300"
            >
              read more →
            </button>
          )}
        </>
      }
    >
      <Pill
        mono
        size="xs"
        tabIndex={0}
        onClick={(e) => {
          if (onClick) {
            e.stopPropagation(); // the row underneath opens the function detail
            onClick(id);
          }
        }}
        className={onClick ? 'cursor-pointer hover:bg-teal-900/60 hover:text-teal-200 focus:outline-hidden' : ''}
      >
        {id}
      </Pill>
    </HoverCard>
  );
}
