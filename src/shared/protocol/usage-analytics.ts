import { z } from "zod";
import { usageIntegerSchema, usageMoneyAmountSchema } from "./usage-accounting.js";

/** Dimensions recorded on each timeline increment at capture time. */
export const USAGE_ANALYTICS_DIMENSIONS = [
  "environment", "backend", "backendKind", "provider", "model", "effort",
  "workspace", "thread", "agentRole", "activity",
] as const;
export type UsageAnalyticsDimension = (typeof USAGE_ANALYTICS_DIMENSIONS)[number];
export const usageAnalyticsDimensionSchema = z.enum(USAGE_ANALYTICS_DIMENSIONS);

export const USAGE_ANALYTICS_BUCKETS = ["hour", "day", "week", "month"] as const;
export type UsageAnalyticsBucket = (typeof USAGE_ANALYTICS_BUCKETS)[number];
export const USAGE_ANALYTICS_MAX_BUCKETS = 500;
export const USAGE_ANALYTICS_MAX_FILTER_VALUES = 50;
export const USAGE_ANALYTICS_MAX_BREAKDOWN = 100;
export const USAGE_ANALYTICS_MAX_FACETS = 60;
/** Dimensions whose facet choices can be searched on the server. Others are few and labelled in the client. */
export const USAGE_ANALYTICS_SEARCHABLE_FACETS = ["model", "backend", "environment", "workspace", "thread"] as const;
/** Seven named series plus Other keep the categorical palette within eight slots. */
export const USAGE_ANALYTICS_SERIES_LIMIT = 7;

/** `null` selects usage whose dimension was not recorded. */
const filterValues = z.array(z.string().min(1).max(512).nullable()).min(1).max(USAGE_ANALYTICS_MAX_FILTER_VALUES);
export const usageAnalyticsFiltersSchema = z.strictObject(
  Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, filterValues.optional()])) as
    Record<UsageAnalyticsDimension, z.ZodOptional<typeof filterValues>>,
);
export type UsageAnalyticsFilters = z.infer<typeof usageAnalyticsFiltersSchema>;

const usageRangeShape = {
  /** Null reads from the earliest placed usage. */
  from: z.iso.datetime().nullable(),
  to: z.iso.datetime(),
  timeZone: z.string().min(1).max(64),
  bucket: z.enum(["auto", ...USAGE_ANALYTICS_BUCKETS]),
  filters: usageAnalyticsFiltersSchema,
};

export const usageAnalyticsRequestSchema = z.strictObject({
  ...usageRangeShape,
  groupBy: usageAnalyticsDimensionSchema.nullable(),
  breakdownLimit: z.number().int().min(1).max(USAGE_ANALYTICS_MAX_BREAKDOWN),
  breakdownDimensions: z.array(usageAnalyticsDimensionSchema).max(USAGE_ANALYTICS_DIMENSIONS.length)
    .refine(dimensions => new Set(dimensions).size === dimensions.length, "Breakdown dimensions must be unique."),
  matrix: z.strictObject({rows: usageAnalyticsDimensionSchema, columns: usageAnalyticsDimensionSchema})
    .refine(matrix => matrix.rows !== matrix.columns, "Matrix dimensions must differ.").nullable(),
  includeHeatmap: z.boolean(),
  includeCoverage: z.boolean(),
});
export type UsageAnalyticsRequest = z.infer<typeof usageAnalyticsRequestSchema>;

/** One dimension's choices, ignoring that dimension's own selection. */
export const usageFacetRequestSchema = z.strictObject({
  ...usageRangeShape,
  dimension: usageAnalyticsDimensionSchema,
  search: z.string().trim().max(120),
}).refine(request => request.search === "" || (USAGE_ANALYTICS_SEARCHABLE_FACETS as readonly string[]).includes(request.dimension),
  {message: "This dimension does not support server search.", path: ["search"]});
export type UsageFacetRequest = z.infer<typeof usageFacetRequestSchema>;

const count = usageIntegerSchema;
export const usageAnalyticsCostSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount: usageMoneyAmountSchema,
  /** Every current source supplies estimates; reported amounts are kept distinct. */
  kind: z.enum(["estimated", "reported", "mixed"]),
});
export type UsageAnalyticsCost = z.infer<typeof usageAnalyticsCostSchema>;

/**
 * Sums of known values. Tokens are input (including cache) plus output.
 * Cache read/write are subsets of input and reasoning is a subset of output.
 * `missing` counts increments that did not report a metric; they are never zero.
 */
export const usageAnalyticsAggregateSchema = z.strictObject({
  tokens: count, input: count, uncachedInput: count, cacheRead: count, cacheWrite: count,
  output: count, reasoning: count, requests: count,
  costs: z.array(usageAnalyticsCostSchema).max(16),
  increments: count,
  threads: count,
  uncostedTokens: count,
  missing: z.strictObject({
    input: count, uncachedInput: count, output: count, cacheRead: count, cacheWrite: count, reasoning: count, requests: count, cost: count,
  }),
});
export type UsageAnalyticsAggregate = z.infer<typeof usageAnalyticsAggregateSchema>;

export const USAGE_ANALYTICS_POINT_METRICS = [
  "tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "requests", "cost",
] as const;
export type UsageAnalyticsPointMetric = (typeof USAGE_ANALYTICS_POINT_METRICS)[number];
/** Parallel arrays, one entry per bucket. Cost is in `costCurrency`. */
export const usageAnalyticsPointsSchema = z.strictObject(
  Object.fromEntries(USAGE_ANALYTICS_POINT_METRICS.map((metric) => [
    metric, z.array(metric === "cost" ? usageMoneyAmountSchema : count).max(USAGE_ANALYTICS_MAX_BUCKETS),
  ])) as Record<UsageAnalyticsPointMetric, z.ZodArray<typeof count>>,
);
export type UsageAnalyticsPoints = z.infer<typeof usageAnalyticsPointsSchema>;

const dimensionKey = z.string().min(1).max(512).nullable();
export const usageAnalyticsRowSchema = z.strictObject({
  key: dimensionKey,
  totals: usageAnalyticsAggregateSchema,
});
export type UsageAnalyticsRow = z.infer<typeof usageAnalyticsRowSchema>;

export const usageAnalyticsBreakdownSchema = z.strictObject({
  rows: z.array(usageAnalyticsRowSchema).max(USAGE_ANALYTICS_MAX_BREAKDOWN),
  /** Rows beyond the limit, folded together. */
  other: usageAnalyticsAggregateSchema.nullable(),
  distinct: count,
});
export type UsageAnalyticsBreakdown = z.infer<typeof usageAnalyticsBreakdownSchema>;

export const usageAnalyticsLabelSchema = z.strictObject({
  label: z.string().min(1).max(512),
  /** Secondary context such as a project path's environment or a thread's project. */
  detail: z.string().max(512).nullable(),
  /** Backend kind for backend and thread keys; environment kind for environments. */
  kind: z.string().max(64).nullable(),
  /** Threads only: whether it is archived; projects: removed. */
  retired: z.boolean(),
  /** Threads only: owning project ID. */
  workspaceId: z.string().max(512).nullable(),
});
export type UsageAnalyticsLabel = z.infer<typeof usageAnalyticsLabelSchema>;

export const usageFacetResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  dimension: usageAnalyticsDimensionSchema,
  choices: z.array(z.strictObject({key: dimensionKey, tokens: count})).max(USAGE_ANALYTICS_MAX_FACETS),
  labels: z.record(z.string(), usageAnalyticsLabelSchema),
});
export type UsageFacetResponse = z.infer<typeof usageFacetResponseSchema>;

export const usageAnalyticsResponseSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  timeZone: z.string().min(1).max(64),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** Earliest placed usage the principal has recorded, for the All time preset. */
  firstRecordedAt: z.iso.datetime().nullable(),
  bucket: z.enum(USAGE_ANALYTICS_BUCKETS),
  buckets: z.array(z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })).max(USAGE_ANALYTICS_MAX_BUCKETS),
  costCurrency: z.string().regex(/^[A-Z]{3}$/),
  totals: usageAnalyticsAggregateSchema,
  previous: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime(), totals: usageAnalyticsAggregateSchema }).nullable(),
  timeline: z.strictObject({
    overall: usageAnalyticsPointsSchema,
    groupBy: usageAnalyticsDimensionSchema.nullable(),
    series: z.array(z.strictObject({
      key: dimensionKey,
      /** Folds every group outside the named series. */
      other: z.boolean(),
      totals: usageAnalyticsAggregateSchema,
      points: usageAnalyticsPointsSchema,
    })).max(USAGE_ANALYTICS_SERIES_LIMIT + 1),
    /** Filter-independent all-time order for stable colors. */
    colorOrder: z.array(dimensionKey).max(8),
  }),
  breakdowns: z.strictObject(
    Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, usageAnalyticsBreakdownSchema])) as
      Record<UsageAnalyticsDimension, typeof usageAnalyticsBreakdownSchema>,
  ).partial(),
  matrix: z.strictObject({
    rows: usageAnalyticsDimensionSchema,
    columns: usageAnalyticsDimensionSchema,
    cells: z.array(z.strictObject({ row: dimensionKey, column: dimensionKey, totals: usageAnalyticsAggregateSchema })).max(2000),
  }).nullable(),
  /** Local weekday (0 = Monday) by local hour, for placed usage. */
  heatmap: z.array(z.strictObject({
    weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23),
    tokens: count, cost: usageMoneyAmountSchema,
  })).max(168).nullable(),
  placement: z.strictObject({
    /** Source-reported occurrence time. */
    reported: count,
    /** Observed continuously at receipt. */
    observed: count,
    /** Recovered across a capture gap, placed because it fit one bucket. */
    interval: count,
    /** Recovered across a capture gap wider than one bucket. */
    spanning: count,
    /** Recovered work received in range whose gap began before the range. In no range total. */
    straddling: count,
    /** Recorded before capture history began; time unknown. Not filtered by range. */
    unplaced: count,
  }),
  coverage: z.strictObject({
    threads: count,
    partialThreads: count,
    conflictThreads: count,
    unsupportedThreads: count,
    modelUnknownTokens: count,
    effortUnknownTokens: count,
  }).nullable(),
  labels: z.strictObject(
    Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, z.record(z.string(), usageAnalyticsLabelSchema)])) as
      Record<UsageAnalyticsDimension, z.ZodRecord<z.ZodString, typeof usageAnalyticsLabelSchema>>,
  ),
});
export type UsageAnalyticsResponse = z.infer<typeof usageAnalyticsResponseSchema>;
