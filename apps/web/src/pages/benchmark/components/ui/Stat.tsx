import type { ReactNode } from 'react';

import { Card } from './Section';

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string; // hex color for the value
}

/** A single headline stat tile. */
export function Stat({ label, value, hint, accent }: StatProps) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-3xl font-bold font-mono" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </Card>
  );
}
