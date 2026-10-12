/** Frozen when a response is first observed, before asynchronous consumers run. */
export type ResponseVoiceFreshness = {
  readonly userInputRevision: number;
  readonly superseded: boolean;
};

export type CapturedResponseVoiceContext = ResponseVoiceFreshness & {
  readonly subscriberWatermark: number;
};
