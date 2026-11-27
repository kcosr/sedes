/** Frozen when a response is first observed, before asynchronous consumers run. */
export type ResponseVoiceFreshness = {
  readonly userInputRevision: number;
  readonly superseded: boolean;
  /** Only provisional progress carries the park revision of its live item opening. */
  readonly progressParkRevision?: number;
};

export type CapturedResponseVoiceContext = ResponseVoiceFreshness & {
  readonly subscriberWatermark: number;
};
