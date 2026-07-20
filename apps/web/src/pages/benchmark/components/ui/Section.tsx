import type { ReactNode } from 'react';

interface SectionProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

/** A translucent chart/content panel. */
export function Panel({ title, subtitle, children, className }: SectionProps) {
  return (
    <div className={`bg-slate-800/30 rounded-lg p-4 ${className ?? ''}`}>
      {title && (
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A solid card, e.g. for stat tiles or callouts. */
export function Card({ children, className }: SectionProps) {
  return <div className={`bg-slate-800/60 rounded-xl p-5 ${className ?? ''}`}>{children}</div>;
}
