import { addDaysIso, formatDate, isoToday, parseIsoDate, relativeDayLabel } from "../lib/format";
import { cx, Input } from "./ui";

/**
 * Horizontal day picker.
 *
 * Shows the recent past ending today, with a native date input as the escape
 * hatch for anything further back (so a two-month-old date is still reachable
 * without a calendar widget nobody asked for).
 */
export function DateStrip({
  selected,
  onSelect,
  days = 14,
}: {
  selected: string;
  onSelect: (iso: string) => void;
  days?: number;
}) {
  const today = isoToday();
  const dates = Array.from({ length: days }, (_, index) => addDaysIso(today, -(days - 1 - index))).reverse();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Pick a day</p>
        <Input
          type="date"
          value={selected}
          max={today}
          onChange={(event) => event.target.value && onSelect(event.target.value)}
          className="h-8 w-auto px-2 text-xs"
          aria-label="Jump to a date"
        />
      </div>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {dates.map((iso) => {
          const isSelected = iso === selected;
          const isToday = iso === today;
          const isFuture = iso > today;
          const day = parseIsoDate(iso).getDate();
          return (
            <button
              key={iso}
              type="button"
              disabled={isFuture}
              onClick={() => onSelect(iso)}
              aria-pressed={isSelected}
              title={formatDate(iso, { weekday: "long", year: "numeric" })}
              className={cx(
                "flex min-w-[3.75rem] shrink-0 flex-col items-center gap-0.5 rounded-field border px-2.5 py-2 transition-colors",
                isSelected
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink",
                isFuture && "opacity-40",
              )}
            >
              <span className="text-[10px] font-medium uppercase tracking-wide">
                {relativeDayLabel(iso)}
              </span>
              <span className="text-sm font-semibold tabular-nums">{day}</span>
              {isToday && <span className="size-1 rounded-full bg-brand" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
