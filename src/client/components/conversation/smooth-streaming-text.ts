export const INITIAL_ANIMATED_GRAPHEMES = 48;
export const MAX_ANIMATED_GRAPHEMES = 128;
export const TERMINAL_SETTLE_MS = 450;

const TARGET_FADING_GRAPHEMES = 28;
const MIN_FADE_MS = 220;
const MAX_FADE_MS = 850;
const MAX_CHUNK_SWEEP_MS = 300;
const MAX_SCHEDULE_LAG_MS = 350;
const FALLBACK_RATE = 60;
const MAX_OBSERVED_RATE = 360;
const RATE_EMA_WEIGHT = 0.35;
export const MIN_STREAM_OPACITY = 0.08;

export type AnimatedGrapheme = {
  readonly index: number;
  readonly grapheme: string;
  readonly arrivalMs: number;
  readonly fadeDurationMs: number;
  readonly startOpacity: number;
};

export type StreamFadeState = {
  readonly source: string;
  readonly graphemeCount: number;
  readonly opaquePrefix: string;
  readonly animated: readonly AnimatedGrapheme[];
  readonly graphemesPerSecond: number;
  readonly observedAtMs: number;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function segmentGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/**
 * Establishes the text already present when a streaming renderer mounts as an
 * opaque baseline. Only later observations should be presented as new deltas;
 * otherwise returning to an active thread replays a fade over historical text.
 */
export function createOpaqueStreamFade(
  source: string,
  nowMs: number,
): StreamFadeState {
  const graphemes = segmentGraphemes(source);
  return {
    source,
    graphemeCount: graphemes.length,
    opaquePrefix: source,
    animated: [],
    graphemesPerSecond: FALLBACK_RATE,
    observedAtMs: nowMs,
  };
}

export function observeStreamFade(
  previous: StreamFadeState | undefined,
  source: string,
  nowMs: number,
): StreamFadeState {
  const graphemes = segmentGraphemes(source);
  const previousIsPrefix =
    previous !== undefined &&
    previous.graphemeCount <= graphemes.length &&
    source.startsWith(previous.source) &&
    graphemes.slice(0, previous.graphemeCount).join("") === previous.source;

  if (!previousIsPrefix) {
    const animatedCount = Math.min(
      graphemes.length,
      INITIAL_ANIMATED_GRAPHEMES,
    );
    const firstAnimatedIndex = graphemes.length - animatedCount;
    const spacingMs =
      animatedCount === 0
        ? 0
        : Math.min(
            MAX_CHUNK_SWEEP_MS / animatedCount,
            1_000 / FALLBACK_RATE,
          );
    const fadeDurationMs = fadeDuration(FALLBACK_RATE);
    return {
      source,
      graphemeCount: graphemes.length,
      opaquePrefix: graphemes.slice(0, firstAnimatedIndex).join(""),
      animated: graphemes
        .slice(firstAnimatedIndex)
        .map((grapheme, offset) => ({
          index: firstAnimatedIndex + offset,
          grapheme,
          arrivalMs: nowMs + offset * spacingMs,
          fadeDurationMs,
          startOpacity: MIN_STREAM_OPACITY,
        })),
      graphemesPerSecond: FALLBACK_RATE,
      observedAtMs: nowMs,
    };
  }

  if (previous.source === source) return previous;

  const appended = graphemes.slice(previous.graphemeCount);
  const elapsedMs = Math.max(nowMs - previous.observedAtMs, 1_000 / 60);
  const instantaneousRate = Math.min(
    (appended.length * 1_000) / elapsedMs,
    MAX_OBSERVED_RATE,
  );
  const graphemesPerSecond =
    previous.graphemesPerSecond * (1 - RATE_EMA_WEIGHT) +
    instantaneousRate * RATE_EMA_WEIGHT;
  const lastArrival =
    previous.animated[previous.animated.length - 1]?.arrivalMs ?? nowMs;
  const baseArrival = Math.max(nowMs, lastArrival);
  const availableLag = Math.max(
    0,
    nowMs + MAX_SCHEDULE_LAG_MS - baseArrival,
  );
  const spacingMs =
    appended.length === 0
      ? 0
      : Math.min(
          1_000 / Math.max(graphemesPerSecond, 1),
          MAX_CHUNK_SWEEP_MS / appended.length,
          availableLag / appended.length,
        );
  const fadeDurationMs = fadeDuration(graphemesPerSecond);
  const appendedRecords = appended.map((grapheme, offset) => ({
    index: previous.graphemeCount + offset,
    grapheme,
    arrivalMs: baseArrival + (offset + 1) * spacingMs,
    fadeDurationMs,
    startOpacity: MIN_STREAM_OPACITY,
  }));

  const animated = previous.animated
    .concat(appendedRecords)
    .slice(-MAX_ANIMATED_GRAPHEMES);
  const firstAnimatedIndex = animated[0]?.index ?? graphemes.length;
  return {
    source,
    graphemeCount: graphemes.length,
    opaquePrefix: graphemes.slice(0, firstAnimatedIndex).join(""),
    animated,
    graphemesPerSecond,
    observedAtMs: nowMs,
  };
}

export function beginTerminalSettlement(
  fade: StreamFadeState,
  nowMs: number,
): StreamFadeState {
  return {
    ...fade,
    animated: fade.animated.map((record) => ({
      ...record,
      arrivalMs: nowMs,
      fadeDurationMs: TERMINAL_SETTLE_MS,
      startOpacity: opacityAt(record, nowMs),
    })),
    observedAtMs: nowMs,
  };
}

export function opacityAt(
  record: AnimatedGrapheme,
  nowMs: number,
): number {
  const progress = clamp(
    (nowMs - record.arrivalMs) / record.fadeDurationMs,
    0,
    1,
  );
  const eased = 1 - (1 - progress) ** 3;
  return record.startOpacity + (1 - record.startOpacity) * eased;
}

export function hasPendingFade(
  fade: StreamFadeState,
  nowMs: number,
): boolean {
  return fade.animated.some((record) => opacityAt(record, nowMs) < 1);
}

function fadeDuration(graphemesPerSecond: number): number {
  const effectiveRate =
    graphemesPerSecond > 0 ? graphemesPerSecond : FALLBACK_RATE;
  return clamp(
    (TARGET_FADING_GRAPHEMES * 1_000) / effectiveRate,
    MIN_FADE_MS,
    MAX_FADE_MS,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
