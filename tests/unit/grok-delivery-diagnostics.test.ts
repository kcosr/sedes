import { describe, expect, it, vi } from "vitest";
import { writeGrokDeliveryDiagnostic } from "../../src/server/backends/grok/grok-delivery-diagnostics.js";

describe("Grok delivery diagnostics", () => {
  it("is silent unless delivery diagnostics are explicitly enabled", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "history_ingest",
        update: "agent_message_chunk",
        outcome: "accepted",
        records: 1,
        characters: 12,
        milliseconds: 3,
      },
      { environment: {}, write },
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("writes only bounded content-free fields when enabled", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "snapshot_projected",
        applicationThreadId: "thread-1",
        revision: 7,
        records: 11,
        turns: 2,
        items: 5,
        milliseconds: 4,
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        now: () => 1234,
        write,
      },
    );
    expect(write).toHaveBeenCalledWith(
      "[delivery-grok] phase=snapshot_projected at_ms=1234 thread=thread-1 revision=7 records=11 turns=2 items=5 ms=4\n",
    );
  });

  it("does not copy untrusted strings into diagnostics", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "history_publish",
        update: "agent message secret",
        outcome: "accepted\nsecret",
        records: 1,
        characters: 2,
        milliseconds: 0,
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        now: () => 5,
        write,
      },
    );
    expect(write).toHaveBeenCalledWith(
      "[delivery-grok] phase=history_publish at_ms=5 update=- outcome=- records=1 chars=2 ms=0\n",
    );
  });

  it("never copies raw image data into delivery diagnostics", () => {
    const write = vi.fn();
    const rawImage = "cmF3LWltYWdlLXNlbnRpbmVsLW11c3Qtbm90LWxlYWs=";
    writeGrokDeliveryDiagnostic(
      {
        phase: "history_ingest",
        update: rawImage,
        outcome: rawImage,
        records: 0,
        characters: rawImage.length,
        milliseconds: 1,
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        write,
      },
    );
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).not.toContain(rawImage);
  });

  it("reports only the closed prompt-correlation disposition", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "prompt_correlation",
        update: "tool_call",
        metadata: "absent",
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        now: () => 7,
        write,
      },
    );
    expect(write).toHaveBeenCalledWith(
      "[delivery-grok] phase=prompt_correlation at_ms=7 update=tool_call metadata=absent\n",
    );
  });

  it("reports only closed tool-projection shape dispositions", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "tool_projection",
        update: "tool_call_update",
        event: "valid",
        title: "empty",
        name: "absent",
        replay: "absent",
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        now: () => 8,
        write,
      },
    );
    expect(write).toHaveBeenCalledWith(
      "[delivery-grok] phase=tool_projection at_ms=8 update=tool_call_update event=valid title=empty name=absent replay=absent\n",
    );
  });

  it("reports only closed prompt failure classifications", () => {
    const write = vi.fn();
    writeGrokDeliveryDiagnostic(
      {
        phase: "prompt_failure",
        generation: 4,
        outcome: "acp_binding_closed",
        closeReason: "acp_notification_invalid",
        invalidEnvelopeRootType: "object",
        invalidEnvelopeShape: "jv_ia_ms_po_ra_ea_k3",
        invalidEnvelopeUnknownKeys: 0,
        invalidEnvelopeMethod: "session/update",
        invalidEnvelopeBounds: "invalid",
        protocolFailures: 1,
        handlerFailures: 0,
      },
      {
        environment: { SEDES_DEBUG_DELIVERY: "1" },
        now: () => 9,
        write,
      },
    );
    expect(write).toHaveBeenCalledWith(
      "[delivery-grok] phase=prompt_failure at_ms=9 generation=4 outcome=acp_binding_closed close=acp_notification_invalid envelope_root=object envelope_shape=jv_ia_ms_po_ra_ea_k3 envelope_unknown=0 envelope_method=session/update envelope_bounds=invalid protocol_failures=1 handler_failures=0\n",
    );
  });
});
