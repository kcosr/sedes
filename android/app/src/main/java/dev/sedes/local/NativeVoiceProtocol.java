package dev.sedes.local;

import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

final class NativeVoiceProtocol {
    static final String[] EVENTS = { "turn.progress", "turn.completed", "turn.failed", "turn.interrupted", "thread.woke",
        "automation.started", "automation.failed", "approval.requested", "input.requested", "question.requested" };
    private NativeVoiceProtocol() {}
    static String choice(JSONObject value, String key, String... choices) {
        String result = NativeVoiceJson.string(value, key, 160);
        if (!java.util.Arrays.asList(choices).contains(result)) throw new IllegalArgumentException("invalid_" + key);
        return result;
    }
    static String uuid(JSONObject value, String key) {
        String result = NativeVoiceJson.string(value, key, 36);
        if (!result.matches("(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)"))
            throw new IllegalArgumentException("invalid_" + key);
        return result;
    }
    static void inputContext(JSONObject value) {
        NativeVoiceJson.keys(value, "threadId", "threadTitle", "activityToken", "authority", "runState", "sourceTurnId", "automaticListenEligible", "manualListenEligible", "steer");
        uuid(value, "threadId"); text(value, "threadTitle", 4096); NativeVoiceJson.string(value, "activityToken", 160);
        choice(value, "authority", "current", "unbound", "unavailable");
        if (!value.has("runState")) throw new IllegalArgumentException("invalid_runState");
        if (!value.isNull("runState")) choice(value, "runState", "idle", "starting", "running", "waiting_for_approval", "waiting_for_input", "stopping", "failed", "disconnected", "reconciling");
        if (value.has("sourceTurnId")) NativeVoiceJson.string(value, "sourceTurnId", 160);
        NativeVoiceJson.bool(value, "automaticListenEligible");
        NativeVoiceJson.bool(value, "manualListenEligible");
        JSONObject steer = NativeVoiceJson.requiredObject(value, "steer");
        String availability = choice(steer, "availability", "available", "unsupported", "unavailable");
        NativeVoiceJson.keys(steer, availability.equals("available") ? new String[] { "availability", "target" } : new String[] { "availability" });
        if (availability.equals("available")) {
            JSONObject target = NativeVoiceJson.requiredObject(steer, "target");
            String kind = choice(target, "kind", "turn", "conversation");
            NativeVoiceJson.keys(target, kind.equals("turn") ? new String[] { "kind", "turnId" } : new String[] { "kind" });
            if (kind.equals("turn")) NativeVoiceJson.string(target, "turnId", 160);
        }
    }
    static void receipt(JSONObject value) {
        NativeVoiceJson.keys(value, "mutationId", "threadId", "operationId", "admittedMode", "queuedInputId", "currentMode", "status", "diagnostic");
        uuid(value, "mutationId"); uuid(value, "threadId"); uuid(value, "operationId");
        choice(value, "admittedMode", "submit", "queue", "steer"); choice(value, "currentMode", "submit", "queue", "steer");
        choice(value, "status", "queued", "submitting", "accepted", "recovery_required", "failed", "cancelled");
        if (value.has("queuedInputId")) NativeVoiceJson.string(value, "queuedInputId", 128);
        if (value.has("diagnostic")) NativeVoiceJson.string(value, "diagnostic", 500);
    }
    static String receiptLookup(JSONObject value) {
        String status = choice(value, "status", "found", "notObserved");
        NativeVoiceJson.keys(value, status.equals("found") ? new String[] { "status", "receipt" } : new String[] { "status" });
        if (status.equals("found")) receipt(NativeVoiceJson.requiredObject(value, "receipt"));
        return status;
    }
    static void validatePolicy(JSONObject settings) {
        NativeVoiceJson.keys(settings, "enabled", "silenced", "revision", "delivery", "assistantResultPhases", "scriptPath", "arguments", "timeoutSeconds");
        NativeVoiceJson.bool(settings, "enabled"); NativeVoiceJson.bool(settings, "silenced");
        NativeVoiceJson.integer(settings, "revision", 0, Long.MAX_VALUE); NativeVoiceJson.integer(settings, "timeoutSeconds", 1, 300);
        JSONObject delivery = NativeVoiceJson.requiredObject(settings, "delivery"); NativeVoiceJson.keys(delivery, EVENTS);
        boolean anyScript = false;
        for (String event : EVENTS) {
            JSONObject value = NativeVoiceJson.requiredObject(delivery, event); NativeVoiceJson.keys(value, "script", "voice");
            anyScript |= NativeVoiceJson.bool(value, "script");
            String action = NativeVoiceJson.string(value, "voice", 32);
            if (!action.equals("none") && !action.equals("speak") && !action.equals("speakThenListen")) throw new IllegalArgumentException("invalid_voice_policy");
            if (action.equals("speakThenListen") && (event.equals("turn.progress") || event.endsWith(".requested"))) throw new IllegalArgumentException("invalid_voice_policy");
        }
        String path = text(settings, "scriptPath", 4096);
        if (path.indexOf('\0') >= 0) throw new IllegalArgumentException("invalid_script_path");
        if (settings.optBoolean("enabled") && anyScript && !path.startsWith("/")) throw new IllegalArgumentException("invalid_script_path");
        JSONArray arguments = settings.optJSONArray("arguments");
        if (arguments == null || arguments.length() > 64) throw new IllegalArgumentException("invalid_script_arguments");
        for (int i = 0; i < arguments.length(); i++) { Object value = arguments.opt(i); if (!(value instanceof String) || ((String) value).length() > 4096 || ((String) value).indexOf('\0') >= 0) throw new IllegalArgumentException("invalid_script_arguments"); }
        JSONArray phases = settings.optJSONArray("assistantResultPhases"); Set<String> seen = new HashSet<>();
        if (phases == null || phases.length() > 3) throw new IllegalArgumentException("invalid_result_phases");
        for (int i = 0; i < phases.length(); i++) {
            Object phase = phases.opt(i);
            if (!(phase instanceof String) || !(phase.equals("provisional") || phase.equals("unclassified") || phase.equals("final")) || !seen.add((String) phase))
                throw new IllegalArgumentException("invalid_result_phases");
        }
    }
    static String text(JSONObject value, String key, int max) {
        Object text = value.opt(key);
        if (!(text instanceof String) || ((String) text).length() > max) throw new IllegalArgumentException("invalid_" + key);
        return (String) text;
    }
    static JSONObject optionalObject(JSONObject value, String key) {
        if (!value.has(key)) return null;
        return NativeVoiceJson.requiredObject(value, key);
    }
    static void notificationDetails(JSONObject value) {
        JSONObject workspace = optionalObject(value, "workspace");
        if (workspace != null) { NativeVoiceJson.keys(workspace, "id", "name"); NativeVoiceJson.string(workspace, "id", 512); text(workspace, "name", 65536); }
        JSONObject turn = optionalObject(value, "turn");
        if (turn != null) { NativeVoiceJson.keys(turn, "id", "outcome"); NativeVoiceJson.string(turn, "id", 512); if (turn.has("outcome")) choice(turn, "outcome", "completed", "failed", "interrupted"); }
        JSONObject interaction = optionalObject(value, "interaction");
        if (interaction != null) { NativeVoiceJson.keys(interaction, "id", "kind"); NativeVoiceJson.string(interaction, "id", 512); choice(interaction, "kind", "choice", "confirmation", "text_input", "editor", "decision", "questionnaire", "form"); }
        JSONObject question = optionalObject(value, "question");
        if (question != null) { NativeVoiceJson.keys(question, "id", "questionCount"); NativeVoiceJson.string(question, "id", 512); NativeVoiceJson.integer(question, "questionCount", 0, 9007199254740991L); }
        JSONObject wake = optionalObject(value, "wake");
        if (wake != null) { NativeVoiceJson.keys(wake, "reason", "reminderText"); text(wake, "reason", 65536); if (wake.has("reminderText")) text(wake, "reminderText", 65536); }
        JSONObject automation = optionalObject(value, "automation");
        if (automation != null) {
            NativeVoiceJson.keys(automation, "id", "name", "runId", "trigger", "stage", "diagnostic");
            NativeVoiceJson.string(automation, "id", 512); NativeVoiceJson.string(automation, "runId", 512); text(automation, "name", 65536);
            choice(automation, "trigger", "scheduled", "manual");
            if (automation.has("stage")) text(automation, "stage", 65536);
            if (automation.has("diagnostic")) text(automation, "diagnostic", 65536);
        }
    }
    static final String[] RESULT_PHASES = { "provisional", "unclassified", "final" };
    /** Selected completion phases: an omitted phase is excluded, null has no text, otherwise bounded text. */
    static JSONObject assistantResult(JSONObject value) {
        NativeVoiceJson.keys(value, RESULT_PHASES);
        for (String phase : RESULT_PHASES)
            if (value.has(phase) && !value.isNull(phase)) bounded(NativeVoiceJson.requiredObject(value, phase), false);
        return value;
    }
    static void bounded(JSONObject value, boolean progress) {
        NativeVoiceJson.keys(value, progress ? new String[] { "text", "truncation", "itemId" } : new String[] { "text", "truncation" });
        text(value, "text", 65536);
        if (progress) NativeVoiceJson.string(value, "itemId", 512);
        JSONObject truncation = optionalObject(value, "truncation");
        if (truncation != null) {
            NativeVoiceJson.keys(truncation, "truncated", "originalBytes", "retainedBytes", "reason");
            if (!NativeVoiceJson.bool(truncation, "truncated")) throw new IllegalArgumentException("invalid_truncation");
            NativeVoiceJson.integer(truncation, "retainedBytes", 0, Long.MAX_VALUE);
            if (truncation.has("originalBytes")) NativeVoiceJson.integer(truncation, "originalBytes", 0, Long.MAX_VALUE);
            String reason = NativeVoiceJson.string(truncation, "reason", 32);
            if (!java.util.Arrays.asList("byte_limit", "depth_limit", "entry_limit", "binary_omitted").contains(reason)) throw new IllegalArgumentException("invalid_truncation");
        }
    }
}
