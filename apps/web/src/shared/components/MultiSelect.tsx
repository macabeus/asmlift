// A searchable, grouped, multi-select popover. Consumers hand it options and get back a string[];
// what those strings mean, and whether they AND or OR, is theirs.
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Pill } from './Pill';
import { type MultiSelectOption, filterOptions, toggleValue } from './multi-select-options';

export type { MultiSelectOption } from './multi-select-options';

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'All',
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing matches.',
  onNavigate,
}: {
  label: string;
  options: readonly MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Handle an option's `href` in-app instead of letting the browser reload. The component stays
   *  routing-agnostic: it knows an option has a destination, not how this app reaches one. */
  onNavigate?: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => filterOptions(options, query, value), [options, query, value]);
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  // close on click-outside and on Escape — both, or the popover strands itself over the table
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [open]);

  const toggle = (v: string) => onChange(toggleValue(value, v));

  return (
    <div className="flex flex-col gap-1 text-xs" ref={root}>
      <span className="text-slate-400">{label}</span>
      <div className="relative">
        {/* A `<div>` rather than a `<button>`: the chips inside it are buttons themselves, and
            nesting interactive elements is invalid — so the keyboard affordance is wired by hand. */}
        <div
          role="combobox"
          tabIndex={0}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((o) => !o);
            } else if (e.key === 'Backspace' && value.length > 0) {
              // the text-input reflex: Backspace drops the last chip
              onChange(value.slice(0, -1));
            }
          }}
          className="flex min-h-8 w-56 cursor-pointer flex-wrap items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-left text-sm hover:border-slate-600 focus:border-teal-500 focus:outline-hidden"
        >
          {value.length === 0 && <span className="py-0.5 text-slate-400">{placeholder}</span>}
          {value.map((v) => (
            <Pill key={v} mono size="xs" tint="#5eead4" title={byValue.get(v)?.description} className="max-w-full pr-1">
              <span className="truncate">{v}</span>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={(e) => {
                  e.stopPropagation(); // removing a chip must not also toggle the popover
                  toggle(v);
                }}
                className="shrink-0 rounded px-0.5 opacity-70 hover:bg-teal-800/60 hover:opacity-100"
              >
                ×
              </button>
            </Pill>
          ))}
          <span className="ml-auto shrink-0 self-start py-0.5 text-slate-500">▾</span>
        </div>

        {open && (
          <div className="absolute left-0 z-20 mt-1 max-h-96 w-80 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
            <div className="border-b border-slate-800 p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 focus:border-teal-500 focus:outline-hidden"
              />
            </div>
            <ul id={listId} role="listbox" aria-multiselectable className="scroll-slim max-h-72 overflow-y-auto py-1">
              {groups.length === 0 && <li className="px-3 py-6 text-center text-slate-500">{emptyText}</li>}
              {groups.map((g) => (
                <li key={g.group ?? '—'}>
                  {g.group && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {g.group}
                    </div>
                  )}
                  <ul>
                    {g.options.map((o) => {
                      const checked = value.includes(o.value);
                      return (
                        <li key={o.value}>
                          <label
                            role="option"
                            aria-selected={checked}
                            className={`flex items-start gap-2 px-3 py-1.5 ${
                              o.disabled && !checked
                                ? 'cursor-not-allowed opacity-40'
                                : 'cursor-pointer hover:bg-slate-800/70'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={o.disabled && !checked}
                              onChange={() => toggle(o.value)}
                              className="mt-0.5 accent-teal-500"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-sm text-slate-200">{o.label}</span>
                                {o.count !== undefined && (
                                  <span className="shrink-0 font-mono text-[11px] text-slate-500">{o.count}</span>
                                )}
                              </span>
                              {o.description && (
                                <span className="block text-[11px] leading-snug text-slate-400">{o.description}</span>
                              )}
                              {o.href && (
                                <a
                                  href={o.href}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (onNavigate) {
                                      e.preventDefault();
                                      onNavigate(o.href!);
                                      setOpen(false);
                                    }
                                  }}
                                  className="mt-0.5 inline-block text-[11px] text-teal-400 hover:text-teal-300"
                                >
                                  read more →
                                </a>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            {value.length > 0 && (
              <div className="border-t border-slate-800 p-2">
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-[11px] text-slate-400 hover:text-slate-200"
                >
                  Clear {value.length}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
