export type GrokDeliveryDiagnostic =
  | {
      readonly phase: "history_ingest" | "history_publish";
      readonly update: string;
      readonly outcome: string;
      readonly records: number;
      readonly characters: number;
      readonly milliseconds: number;
    }
  | {
      readonly phase: "prompt_correlation";
      readonly update: string;
      readonly metadata: "absent" | "mismatch";
    }
  | {
      readonly phase: "tool_projection";
      readonly update: string;
      readonly event: "absent" | "valid" | "invalid";
      readonly title: "absent" | "null" | "empty" | "valid" | "invalid";
      readonly name: "absent" | "null" | "empty" | "valid" | "invalid";
      readonly replay: "absent" | "true" | "other";
    }
  | {
      readonly phase: "resnapshot_requested";
      readonly applicationThreadId: string;
      readonly revision: number;
    }
  | {
      readonly phase: "snapshot_projected";
      readonly applicationThreadId: string;
      readonly revision: number;
      readonly records: number;
      readonly turns: number;
      readonly items: number;
      readonly milliseconds: number;
    }
  | {
      readonly phase: "handle_event";
      readonly applicationThreadId: string;
      readonly event: string;
      readonly sequence: number;
    }
  | {
      readonly phase: "prompt_failure";
      readonly generation: number;
      readonly outcome: string;
      readonly closeReason: string;
      readonly invalidEnvelopeRootType: string;
      readonly invalidEnvelopeShape: string;
      readonly invalidEnvelopeUnknownKeys: number;
      readonly invalidEnvelopeMethod: string;
      readonly invalidEnvelopeBounds: string;
      readonly protocolFailures: number;
      readonly handlerFailures: number;
    };

interface GrokDeliveryDiagnosticOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly write?: (message: string) => void;
}

function diagnosticToken(value: string): string {
  return value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_.:-]+$/u.test(value)
    ? value
    : "-";
}

function diagnosticInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function diagnosticMethod(value: string): string {
  return value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/u.test(value)
    ? value
    : "-";
}

/**
 * Content-free, opt-in Grok delivery timing. It deliberately excludes native
 * session/prompt/event IDs, provider payloads, text, paths, and errors.
 */
export function writeGrokDeliveryDiagnostic(
  event: GrokDeliveryDiagnostic,
  options: GrokDeliveryDiagnosticOptions = {},
): void {
  const environment = options.environment ?? process.env;
  if (!environment.SEDES_DEBUG_DELIVERY) return;
  const now = options.now ?? Date.now;
  const fields = [
    `[delivery-grok] phase=${event.phase}`,
    `at_ms=${diagnosticInteger(Math.floor(now()))}`,
  ];
  if ("applicationThreadId" in event) {
    fields.push(`thread=${diagnosticToken(event.applicationThreadId)}`);
  }
  if ("update" in event) {
    fields.push(`update=${diagnosticToken(event.update)}`);
    if (event.phase === "prompt_correlation") {
      fields.push(`metadata=${diagnosticToken(event.metadata)}`);
    } else if (event.phase === "tool_projection") {
      fields.push(
        `event=${diagnosticToken(event.event)}`,
        `title=${diagnosticToken(event.title)}`,
        `name=${diagnosticToken(event.name)}`,
        `replay=${diagnosticToken(event.replay)}`,
      );
    } else {
      fields.push(
        `outcome=${diagnosticToken(event.outcome)}`,
        `records=${diagnosticInteger(event.records)}`,
        `chars=${diagnosticInteger(event.characters)}`,
        `ms=${diagnosticInteger(event.milliseconds)}`,
      );
    }
  }
  if (event.phase === "resnapshot_requested") {
    fields.push(`revision=${diagnosticInteger(event.revision)}`);
  }
  if (event.phase === "snapshot_projected") {
    fields.push(
      `revision=${diagnosticInteger(event.revision)}`,
      `records=${diagnosticInteger(event.records)}`,
      `turns=${diagnosticInteger(event.turns)}`,
      `items=${diagnosticInteger(event.items)}`,
      `ms=${diagnosticInteger(event.milliseconds)}`,
    );
  }
  if (event.phase === "handle_event") {
    fields.push(
      `event=${diagnosticToken(event.event)}`,
      `sequence=${diagnosticInteger(event.sequence)}`,
    );
  }
  if (event.phase === "prompt_failure") {
    fields.push(
      `generation=${diagnosticInteger(event.generation)}`,
      `outcome=${diagnosticToken(event.outcome)}`,
      `close=${diagnosticToken(event.closeReason)}`,
      `envelope_root=${diagnosticToken(event.invalidEnvelopeRootType)}`,
      `envelope_shape=${diagnosticToken(event.invalidEnvelopeShape)}`,
      `envelope_unknown=${diagnosticInteger(event.invalidEnvelopeUnknownKeys)}`,
      `envelope_method=${diagnosticMethod(event.invalidEnvelopeMethod)}`,
      `envelope_bounds=${diagnosticToken(event.invalidEnvelopeBounds)}`,
      `protocol_failures=${diagnosticInteger(event.protocolFailures)}`,
      `handler_failures=${diagnosticInteger(event.handlerFailures)}`,
    );
  }
  (options.write ?? ((message) => process.stderr.write(message)))(
    `${fields.join(" ")}\n`,
  );
}
