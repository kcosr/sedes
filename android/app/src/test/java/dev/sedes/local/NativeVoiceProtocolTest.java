package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONArray;
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
    private JSONObject policy() {
        JSONObject delivery = new JSONObject();
        for (String event : NativeVoiceProtocol.EVENTS)
            NativeVoiceJson.put(delivery, event, NativeVoiceJson.object("script", false, "voice", event.equals("turn.completed") ? "speakThenListen" : "speak"));
        return NativeVoiceJson.object("enabled", true, "silenced", false, "revision", 3, "delivery", delivery,
            "assistantResultPhases", new JSONArray().put("final").put("unclassified"), "scriptPath", "", "arguments", new JSONArray(), "timeoutSeconds", 30);
    }
    private interface Change { void apply(JSONObject policy) throws Exception; }
    private void assertInvalidPolicy(Change change) throws Exception {
        JSONObject value = policy(); change.apply(value);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.validatePolicy(value));
    }
    @Test public void policyAcceptsServerShapeAndRejectsInvalidDeliveryScriptAndPhases() throws Exception {
        NativeVoiceProtocol.validatePolicy(policy());
        JSONObject script = policy(); NativeVoiceJson.put(script.optJSONObject("delivery").optJSONObject("turn.failed"), "script", true);
        NativeVoiceJson.put(script, "scriptPath", "/usr/local/bin/notify"); NativeVoiceJson.put(script, "arguments", new JSONArray().put("--quiet"));
        NativeVoiceProtocol.validatePolicy(script);
        JSONObject disabled = policy(); NativeVoiceJson.put(disabled, "enabled", false); NativeVoiceJson.put(disabled, "scriptPath", "relative");
        NativeVoiceJson.put(disabled.optJSONObject("delivery").optJSONObject("turn.failed"), "script", true);
        NativeVoiceProtocol.validatePolicy(disabled);
        for (String event : new String[] { "turn.progress", "approval.requested", "input.requested", "question.requested" })
            assertInvalidPolicy(value -> NativeVoiceJson.put(value.optJSONObject("delivery").optJSONObject(event), "voice", "speakThenListen"));
        assertInvalidPolicy(value -> value.optJSONObject("delivery").remove("thread.woke"));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value.optJSONObject("delivery"), "notification.test", NativeVoiceJson.object("script", false, "voice", "speak")));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value.optJSONObject("delivery").optJSONObject("turn.failed"), "voice", "shout"));
        assertInvalidPolicy(value -> { NativeVoiceJson.put(value.optJSONObject("delivery").optJSONObject("turn.failed"), "script", true); NativeVoiceJson.put(value, "scriptPath", "notify"); });
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "scriptPath", "/bin/a\0b"));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "arguments", new JSONArray().put("a\0b")));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "arguments", new JSONArray().put(1)));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "assistantResultPhases", new JSONArray().put("final").put("final")));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "assistantResultPhases", new JSONArray().put("summary")));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "timeoutSeconds", 0));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "timeoutSeconds", 301));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "revision", -1));
        assertInvalidPolicy(value -> NativeVoiceJson.put(value, "legacyVoice", true));
    }
    private JSONObject details() {
        return NativeVoiceJson.object("workspace", NativeVoiceJson.object("id", "workspace-1", "name", "Work"),
            "turn", NativeVoiceJson.object("id", "turn-1", "outcome", "failed"), "interaction", NativeVoiceJson.object("id", "interaction-1", "kind", "form"),
            "question", NativeVoiceJson.object("id", "question-1", "questionCount", 2), "wake", NativeVoiceJson.object("reason", "Reminder", "reminderText", "Check"),
            "automation", NativeVoiceJson.object("id", "automation-1", "name", "Nightly", "runId", "run-1", "trigger", "scheduled", "stage", "build", "diagnostic", "ok"));
    }
    private void assertInvalidDetails(Change change) throws Exception {
        JSONObject value = details(); change.apply(value);
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceProtocol.notificationDetails(value));
    }
    @Test public void notificationDetailsAcceptOptionalShapesAndRejectInvalidOrUnknownFields() throws Exception {
        NativeVoiceProtocol.notificationDetails(details());
        NativeVoiceProtocol.notificationDetails(new JSONObject());
        JSONObject minimal = NativeVoiceJson.object("turn", NativeVoiceJson.object("id", "turn-1"), "wake", NativeVoiceJson.object("reason", ""),
            "automation", NativeVoiceJson.object("id", "automation-1", "name", "", "runId", "run-1", "trigger", "manual"));
        NativeVoiceProtocol.notificationDetails(minimal);
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("turn"), "outcome", "cancelled"));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("interaction"), "kind", "prompt"));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("question"), "questionCount", -1));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("question"), "questionCount", 1.5));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("automation"), "trigger", "webhook"));
        assertInvalidDetails(value -> value.optJSONObject("automation").remove("runId"));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("workspace"), "path", "/srv"));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("workspace"), "id", ""));
        assertInvalidDetails(value -> NativeVoiceJson.put(value.optJSONObject("wake"), "reason", 3));
        assertInvalidDetails(value -> NativeVoiceJson.put(value, "turn", "turn-1"));
    }
}
