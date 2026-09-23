import { useEffect, useMemo, useState } from "react";
import { CalendarRange, ChevronDown, ListFilter, Search, X } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@client/components/ui/popover";
import type { ApiClient } from "../api/ApiClient.js";
import {
  USAGE_ANALYTICS_MAX_FACETS, USAGE_ANALYTICS_MAX_FILTER_VALUES, USAGE_ANALYTICS_SEARCHABLE_FACETS,
  type UsageAnalyticsBucket, type UsageAnalyticsDimension, type UsageAnalyticsRequest, type UsageAnalyticsResponse,
} from "../../shared/protocol/usage-analytics.js";
import { useUsageAnalytics } from "./use-usage-analytics.js";
import { DIMENSION_META, DIMENSION_ORDER, GRANULARITY_LABEL, dimensionLabel, formatCount } from "./usage-format.js";
import {
  RANGE_PRESETS, activeFilterCount, localDateInput, resolveRange, toggleFilter,
  type RangePreset, type UsageFilterState, type UsageViewSettings,
} from "./usage-settings.js";
import { Check16, DimensionIcon, MenuSelect } from "./usage-ui.js";

export function RangePicker({ settings, onChange }: {
  readonly settings: UsageViewSettings;
  readonly onChange: (patch: Partial<UsageViewSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const range = resolveRange(settings);
  const today = localDateInput(new Date());
  const [from, setFrom] = useState(settings.customFrom ?? localDateInput(range.from ?? new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(settings.customTo ?? today);
  const choose = (preset: RangePreset) => { onChange({ preset }); setOpen(false); };
  const valid = from <= to && to <= today;
  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) { setFrom(settings.customFrom ?? localDateInput(range.from ?? new Date(Date.now() - 29 * 86_400_000))); setTo(settings.customTo ?? today); }
    }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="usage-select usage-range-trigger" aria-label={`Date range: ${range.label}`}>
          <CalendarRange aria-hidden="true" />
          <span>{range.label}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="usage-range-popover">
        <div role="listbox" aria-label="Date range presets" className="usage-range-presets">
          {RANGE_PRESETS.map((preset) => (
            <button key={preset.id} type="button" role="option" aria-selected={settings.preset === preset.id} onClick={() => choose(preset.id)}>
              <span className="usage-range-check">{settings.preset === preset.id ? <Check16 /> : null}</span>
              {preset.label}
            </button>
          ))}
        </div>
        <form className="usage-range-custom" onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onChange({ preset: "custom", customFrom: from, customTo: to });
          setOpen(false);
        }}>
          <p className="usage-range-custom-title">Custom range</p>
          <div className="usage-range-fields">
            <label>From<input type="date" value={from} max={to || today} onChange={(event) => setFrom(event.target.value)} required /></label>
            <label>To<input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} required /></label>
          </div>
          <Button type="submit" size="sm" disabled={!valid}>Apply range</Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function GranularityMenu({ value, resolved, onChange }: {
  readonly value: UsageViewSettings["bucket"]; readonly resolved: UsageAnalyticsBucket | undefined;
  readonly onChange: (value: UsageViewSettings["bucket"]) => void;
}) {
  return (
    <MenuSelect label="Granularity" value={value} onChange={onChange}
      options={[
        { value: "auto", label: value === "auto" && resolved ? `Auto · ${GRANULARITY_LABEL[resolved]}` : "Auto" },
        { value: "hour", label: "Hourly" }, { value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" },
      ]} />
  );
}

/** Faceted choices: each dimension's list ignores only its own selection. */
export function FilterPicker({ api, filters, onChange, buildRequest, requestKey, labels }: {
  readonly api: Pick<ApiClient, "getUsageAnalytics"> | undefined;
  readonly filters: UsageFilterState;
  readonly onChange: (filters: UsageFilterState) => void;
  readonly buildRequest: () => UsageAnalyticsRequest;
  readonly requestKey: string;
  readonly labels: UsageAnalyticsResponse["labels"] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState<UsageAnalyticsDimension>("model");
  const [query, setQuery] = useState("");
  // Choices beyond the top-ranked values are found by a debounced server search.
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const searchable = (USAGE_ANALYTICS_SEARCHABLE_FACETS as readonly string[]).includes(dimension);
  const facetSearch = searchable && search ? { dimension: dimension as (typeof USAGE_ANALYTICS_SEARCHABLE_FACETS)[number], text: search.slice(0, 120) } : undefined;
  const facets = useUsageAnalytics(api, open ? `facets:${requestKey}:${facetSearch ? `${facetSearch.dimension}:${facetSearch.text}` : ""}` : null,
    () => ({ ...buildRequest(), groupBy: null, crossBy: null, breakdownLimit: 1, facets: true, ...(facetSearch ? { facetSearch } : {}) }));
  const known = facets.data?.labels ?? labels;
  const count = activeFilterCount(filters);
  const selected = filters[dimension] ?? [];
  const atLimit = selected.length >= USAGE_ANALYTICS_MAX_FILTER_VALUES;
  const choices = useMemo(() => {
    const rows = facets.data?.facets?.[dimension] ?? [];
    const keys = new Set(rows.map((row) => row.key));
    const extra = selected.filter((key) => !keys.has(key)).map((key) => ({ key, tokens: "0" }));
    const needle = query.trim().toLocaleLowerCase();
    // The server also matches IDs and full paths that labels may not show, so
    // keep every row it returned for the current text; filter the rest locally.
    const answered = facetSearch !== undefined && facetSearch.text === query.trim() && !facets.stale;
    const labelled = <Row extends { key: string | null }>(row: Row) => ({ ...row, label: dimensionLabel(known, dimension, row.key) });
    const matches = (row: ReturnType<typeof labelled<{ key: string | null }>>) =>
      !needle || `${row.key ?? ""} ${row.label.label} ${row.label.detail ?? ""}`.toLocaleLowerCase().includes(needle);
    return [...rows.map(labelled).filter((row) => answered || matches(row)), ...extra.map(labelled).filter(matches)];
  }, [facets.data, facets.stale, facetSearch?.text, dimension, selected, query, known]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="usage-select" data-active={count ? "true" : undefined}>
          <ListFilter aria-hidden="true" />
          <span>Filter</span>
          {count ? <span className="usage-filter-count" aria-label={`${count} active`}>{count}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="usage-filter-popover">
        <nav className="usage-filter-dimensions" aria-label="Filter dimension">
          {DIMENSION_ORDER.map((candidate) => {
            const active = filters[candidate]?.length ?? 0;
            return (
              <button key={candidate} type="button" aria-current={candidate === dimension ? "true" : undefined}
                onClick={() => { setDimension(candidate); setQuery(""); }}>
                <span>{DIMENSION_META[candidate].label}</span>
                {active ? <span className="usage-filter-count">{active}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="usage-filter-values">
          <label className="usage-filter-search">
            <Search aria-hidden="true" size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${DIMENSION_META[dimension].plural.toLocaleLowerCase()}`}
              aria-label={`Search ${DIMENSION_META[dimension].plural}`} />
          </label>
          <div className="usage-filter-options" role="group" aria-label={DIMENSION_META[dimension].plural} data-loading={facets.loading ? "true" : undefined}>
            {choices.length === 0 ? <p className="usage-empty-note">{facets.loading ? "Loading…" : facets.error ? "Choices are unavailable." : query.trim() ? "No matching values in this range" : "No values in this range"}</p> : null}
            {choices.map((choice) => {
              const checked = selected.includes(choice.key);
              return (
                <label key={choice.key ?? "∅"} className="usage-filter-option" data-unknown={choice.label.unknown ? "true" : undefined}>
                  <input type="checkbox" checked={checked} disabled={!checked && atLimit} onChange={() => onChange(toggleFilter(filters, dimension, choice.key))} />
                  <span className="usage-filter-option-icon" aria-hidden="true"><DimensionIcon dimension={dimension} label={choice.label} /></span>
                  <span className="usage-filter-option-text">
                    <span>{choice.label.label}</span>
                    {choice.label.detail ? <small>{choice.label.detail}</small> : null}
                  </span>
                  <span className="usage-filter-option-value">{formatCount(choice.tokens)}</span>
                </label>
              );
            })}
          </div>
          {!query.trim() && (facets.data?.facets?.[dimension].length ?? 0) >= USAGE_ANALYTICS_MAX_FACETS
            ? <p className="usage-footnote">Showing the {USAGE_ANALYTICS_MAX_FACETS} largest. {searchable ? "Search to find others." : ""}</p> : null}
          {atLimit ? <p className="usage-footnote">Up to {USAGE_ANALYTICS_MAX_FILTER_VALUES} values can be selected per filter.</p> : null}
          <div className="usage-filter-actions">
            <Button variant="ghost" size="sm" disabled={!selected.length}
              onClick={() => { const { [dimension]: _cleared, ...rest } = filters; onChange(rest); }}>Clear {DIMENSION_META[dimension].label.toLocaleLowerCase()}</Button>
            <Button variant="ghost" size="sm" disabled={!count} onClick={() => onChange({})}>Clear all</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FilterChips({ filters, labels, onChange }: {
  readonly filters: UsageFilterState;
  readonly labels: UsageAnalyticsResponse["labels"] | undefined;
  readonly onChange: (filters: UsageFilterState) => void;
}) {
  const active = DIMENSION_ORDER.filter((dimension) => filters[dimension]?.length);
  if (!active.length) return null;
  return (
    <ul className="usage-filter-chips" aria-label="Active filters">
      {active.map((dimension) => {
        const values = filters[dimension]!;
        const names = values.map((key) => dimensionLabel(labels, dimension, key).label);
        return (
          <li key={dimension}>
            <span className="usage-chip-dimension">{DIMENSION_META[dimension].label}</span>
            <span className="usage-chip-values" title={names.join(", ")}>{names.slice(0, 2).join(", ")}{names.length > 2 ? ` +${names.length - 2}` : ""}</span>
            <button type="button" aria-label={`Remove ${DIMENSION_META[dimension].label} filter`}
              onClick={() => { const { [dimension]: _removed, ...rest } = filters; onChange(rest); }}><X aria-hidden="true" size={12} /></button>
          </li>
        );
      })}
      <li className="usage-chip-clear"><button type="button" onClick={() => onChange({})}>Clear all</button></li>
    </ul>
  );
}
