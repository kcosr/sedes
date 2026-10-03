package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceProtocolTest {
    private static final String ID = "13b02f0b-3060-4d6f-a3e0-60b5fa757011";
    private JSONObject context() {
        return NativeVoiceJson.object("threadId", ID, "activityToken", "epoch", "authority", "current", "runState", "idle",
            "automaticListenEligible", true, "steer", NativeVoiceJson.object("availability", "available", "target", NativeVoiceJson.object("kind", "turn", "turnId", "turn-1")));
    }
    private JSONObject receipt() {
        return NativeVoiceJson.object("mutationId", ID, "threadId", ID, "operationId", ID,
            "admittedMode", "steer", "currentMode", "queue", "status", "accepted");
    }
    @Test public void contextRejectsInvalidOrMissingAuthorityAndSteeringFields() {
        NativeVoiceProtocol.inputContext(context());
        JSONObject wrongState = context(); NativeVoiceJson.put(wrongState, "runState", "paused");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.inputContext(wrongState));
        JSONObject missingState = context(); missingState.remove("runState");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.inputContext(missingState));
        JSONObject wrongSteer = context(); NativeVoiceJson.put(wrongSteer.optJSONObject("steer").optJSONObject("target"), "turnId", JSONObject.NULL);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.inputContext(wrongSteer));
        JSONObject extraSteer = context(); NativeVoiceJson.put(extraSteer.optJSONObject("steer"), "legacyTarget", ID);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.inputContext(extraSteer));
    }
    @Test public void contextSupportsUnboundAndUnsupportedWithoutInventedTarget() {
        JSONObject unbound = context(); NativeVoiceJson.put(unbound, "runState", JSONObject.NULL);
        NativeVoiceJson.put(unbound, "authority", "unbound"); NativeVoiceJson.put(unbound, "automaticListenEligible", false);
        NativeVoiceJson.put(unbound, "steer", NativeVoiceJson.object("availability", "unsupported"));
        NativeVoiceProtocol.inputContext(unbound);
        NativeVoiceJson.put(unbound.optJSONObject("steer"), "target", NativeVoiceJson.object("kind", "conversation"));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.inputContext(unbound));
    }
    @Test public void malformedReceiptCannotAcknowledgeOrAuthorizeReplay() {
        NativeVoiceProtocol.receipt(receipt());
        assertEquals("found", NativeVoiceProtocol.receiptLookup(NativeVoiceJson.object("status", "found", "receipt", receipt())));
        assertEquals("notObserved", NativeVoiceProtocol.receiptLookup(NativeVoiceJson.object("status", "notObserved")));
        JSONObject wrongId = receipt(); NativeVoiceJson.put(wrongId, "operationId", "old-operation");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.receipt(wrongId));
        JSONObject wrongOptional = receipt(); NativeVoiceJson.put(wrongOptional, "diagnostic", false);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.receipt(wrongOptional));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.receiptLookup(NativeVoiceJson.object("status", "notObserved", "receipt", receipt())));
    }
}
