# Usage and spend

The **Usage** page shows the tokens and estimated cost that Sedes recorded
across every thread you own. Open it from the sidebar footer: choose **More**,
then **Usage**. Remaining provider quota is a different view, **Accounts**, in
the same menu.

For one reply or one thread, use the turn usage icon or **Session stats**. See
[View recorded usage](conversations.md#view-recorded-usage).

## Choose a range and filters

The toolbar applies to everything on the page.

- **Date range** offers today, the last 24 hours, the last 7, 30, or 90 days,
  this or last month, this year, all time, and a custom range of calendar
  days.
- **Granularity** groups time by hour, day, week, or month. **Auto** picks one
  that suits the range. Buckets follow your browser's time zone, including
  daylight-saving changes; weeks start on Monday.
- **Filter** narrows the page by model, provider, reasoning effort, backend,
  backend type, environment, project, thread, agent, or activity. The count
  beside each choice already reflects your other filters. The list shows the
  60 largest values; type in its search box to find others by name or ID. **Unknown
  model**, **Not recorded**, and similar choices select usage without that
  detail. Up to 50 values can be selected per filter.

Select a row in any breakdown to filter to it, and select it again to remove
the filter. Active filters appear as chips beside the toolbar. Filters last for
the visit; the range, granularity, chart choices, and selected view are
remembered in this browser.

## Views

- **Overview** leads with totals for the range and the change against the
  previous period of the same length. The main chart shows any metric over
  time, grouped by one dimension. Choose stacked columns or lines, select
  legend entries to hide or show a series, or switch to a table. Cards break
  the range down by model, provider, reasoning effort, backend, environment,
  project, agent, and activity.
- **Explore** is a sortable table of any dimension with every metric. Choose
  **Split** to compare two dimensions, such as model by reasoning effort.
  **Export CSV** downloads what is shown: the table, or every combination of
  the split. Blank cells mean the value was not reported.
- **Threads** ranks threads by tokens, cost, input, output, or reasoning.
  Select a thread to open it.
- **Patterns** shows when usage happens by weekday and hour, the token mix,
  and how cache reuse and reasoning share change over time.
- **Coverage** explains how much of the range has a known time, cost, model,
  and reasoning effort, and which threads have incomplete accounting.

The page refreshes about once a minute while it is visible, and when you
return to it. If a refresh fails, the last successful numbers stay on screen
with a warning.

## Read the numbers

- **Tokens** are input plus output. Cache reads and writes are part of input,
  and reasoning is part of output, so those parts never add to the total.
- **Estimated cost** comes from the provider or SDK. It is not an invoice and
  does not reflect subscription billing. Codex does not report cost, so Codex
  tokens count as unpriced. Sedes does not calculate prices itself.
- A dash or an **Unknown** row means the detail was not reported. It never
  means zero.
- **Model** and **Reasoning effort** come from the source, or from the
  settings the provider confirmed while Sedes watched the work. Older records
  and usage recovered after a gap show them as unknown. Codex subagent usage
  has no model.
- Usage appears at the time it happened when the source reports one, and
  otherwise when Sedes received it. When Sedes was disconnected, a later
  checkpoint can recover the missed work. The charts place recovered work only
  if the whole gap fits inside one bucket; otherwise it counts in the range's
  totals and the chart notes how much it could not draw. A coarser granularity
  can place more of it. Recovered work whose gap began before the range counts
  in neither; a wider range includes it.
- Work that was already on a session's counter when Sedes began recording it
  belongs to no time range. **Coverage** reports its total.
- Grok does not report usage, so Grok threads never appear here.
