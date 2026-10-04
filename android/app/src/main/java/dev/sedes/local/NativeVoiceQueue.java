package dev.sedes.local;

import java.text.BreakIterator;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;

/** Pure queue/presentation policy; the runtime exclusively owns the active item. */
final class NativeVoiceQueue {
    static final int MAX_ITEMS = 64, MAX_BYTES = 256 * 1024, RETAINED_IDS = 4096;
    // The server fits payloads to this JSON.stringify UTF-8 size; measuring the same way accepts every such payload.
    static final long MAX_PAYLOAD_BYTES = 65536;
    private static final Set<String> EVENTS = new HashSet<>(java.util.Arrays.asList("turn.progress", "turn.completed", "turn.failed",
        "turn.interrupted", "thread.woke", "automation.started", "automation.failed", "approval.requested", "input.requested", "question.requested"));
    static final class Item {
        final String id, event, speech, subject, threadId, threadTitle, origin;
        final JSONObject target;
        final JSONObject envelope;
        final long policyGeneration;
        boolean followUp, followUpCancelled;
        final int bytes;
        boolean automatic = true;
        Item(JSONObject envelope, NativeVoiceSettings settings) {
            this.envelope = NativeVoiceJson.copy(envelope);
            NativeVoiceJson.keys(envelope, "payload", "sourceEventId", "voice", "generation", "origin", "recognitionTarget", "subjectId");
            id = NativeVoiceJson.string(envelope, "sourceEventId", 512);
            policyGeneration = NativeVoiceJson.integer(envelope, "generation", 0, Long.MAX_VALUE);
            JSONObject payload = NativeVoiceJson.requiredObject(envelope, "payload");
            NativeVoiceJson.keys(payload, "schemaVersion", "notificationId", "event", "occurredAt", "title", "message", "thread", "workspace",
                "turn", "progress", "interaction", "question", "wake", "automation", "assistantResult");
            NativeVoiceJson.integer(payload, "schemaVersion", 4, 4);
            if (NativeVoiceJson.serializedBytes(payload) > MAX_PAYLOAD_BYTES) throw new IllegalArgumentException("voice_payload_too_large");
            NativeVoiceJson.string(payload, "notificationId", 512);
            NativeVoiceJson.string(payload, "occurredAt", 80);
            NativeVoiceProtocol.text(payload, "title", 65536); NativeVoiceProtocol.text(payload, "message", 65536);
            NativeVoiceProtocol.notificationDetails(payload);
            event = NativeVoiceJson.string(payload, "event", 80);
            if (!EVENTS.contains(event)) throw new IllegalArgumentException("voice_event_invalid");
            JSONObject thread = NativeVoiceProtocol.optionalObject(payload, "thread");
            if (thread != null) { NativeVoiceJson.keys(thread, "id", "title"); NativeVoiceProtocol.text(thread, "title", 65536); }
            threadId = thread == null ? null : NativeVoiceJson.string(thread, "id", 512);
            threadTitle = thread == null ? null : thread.optString("title", "");
            JSONObject source = NativeVoiceProtocol.optionalObject(envelope, "origin");
            if (source != null) NativeVoiceJson.keys(source, "clientId");
            origin = source == null ? null : NativeVoiceJson.string(source, "clientId", 512);
            JSONObject recognition = NativeVoiceProtocol.optionalObject(envelope, "recognitionTarget");
            if (recognition != null) {
                NativeVoiceJson.keys(recognition, "threadId", "activityToken", "sourceTurnId");
                NativeVoiceJson.string(recognition, "threadId", 512); NativeVoiceJson.string(recognition, "activityToken", 512);
                if (recognition.has("sourceTurnId")) NativeVoiceJson.string(recognition, "sourceTurnId", 512);
            }
            target = recognition == null ? null : NativeVoiceJson.copy(recognition);
            JSONObject progress = NativeVoiceProtocol.optionalObject(payload, "progress");
            if (progress != null) NativeVoiceProtocol.bounded(progress, true);
            JSONObject result = NativeVoiceProtocol.optionalObject(payload, "assistantResult");
            if (result != null) {
                NativeVoiceJson.keys(result, "provisional", "unclassified", "final");
                for (String phase : new String[] { "provisional", "unclassified", "final" })
                    if (result.has(phase) && !result.isNull(phase)) NativeVoiceProtocol.bounded(NativeVoiceJson.requiredObject(result, phase), false);
            }
            subject = envelope.has("subjectId") ? NativeVoiceJson.string(envelope, "subjectId", 512) : null;
            String action = NativeVoiceJson.string(envelope, "voice", 32);
            if (!action.equals("none") && !action.equals("speak") && !action.equals("speakThenListen")) throw new IllegalArgumentException("voice_action_invalid");
            if (action.equals("speakThenListen") && (event.equals("turn.progress") || event.endsWith(".requested")))
                throw new IllegalArgumentException("voice_action_invalid");
            boolean manual = settings.mode().equals("manual");
            followUp = settings.flag("autoListen") && action.equals("speakThenListen") && target != null &&
                (!manual || event.equals("turn.completed"));
            speech = !settings.active() || action.equals("none") || (manual && event.equals("turn.completed")) ? "" : speech(payload, settings);
            bytes = NativeVoiceJson.bytes(speech);
        }
        String targetId() { return target == null ? null : target.optString("threadId", null); }
        String coalesceKey() {
            if (subject == null || threadId == null || !(event.equals("thread.woke") || event.endsWith(".requested"))) return null;
            return threadId + "\n" + event + "\n" + subject;
        }
        boolean progress() { return event.equals("turn.progress"); }
    }
    private final ArrayDeque<Item> pending = new ArrayDeque<>();
    private final ArrayDeque<String> remembered = new ArrayDeque<>();
    private final Set<String> seen = new HashSet<>();
    private final LinkedHashMap<String, Integer> dropped = new LinkedHashMap<>();
    private int bytes;
    int size() { return pending.size(); }
    int bytes() { return bytes; }
    boolean remember(String id) {
        if (!seen.add(id)) return false;
        remembered.addLast(id);
        // Pending IDs remain independently checked even after leaving the bounded completed history.
        while (remembered.size() > RETAINED_IDS + MAX_ITEMS + 1) seen.remove(remembered.removeFirst());
        return true;
    }
    void completed(String id) {
        seen.remove(id); remembered.remove(id);
        remember(id);
    }
    boolean add(Item item) {
        if (!remember(item.id)) return false;
        for (Item old : pending) if (old.id.equals(item.id)) return false;
        return enqueue(item);
    }
    private boolean enqueue(Item item) {
        String key = item.coalesceKey();
        if (key != null) {
            Iterator<Item> iterator = pending.iterator();
            while (iterator.hasNext()) { Item old = iterator.next(); if (key.equals(old.coalesceKey())) { bytes -= old.bytes; iterator.remove(); } }
        }
        if (!item.progress()) {
            Iterator<Item> iterator = pending.iterator();
            while ((pending.size() >= MAX_ITEMS || bytes + item.bytes > MAX_BYTES) && iterator.hasNext()) {
                Item old = iterator.next();
                if (old.progress()) { bytes -= old.bytes; iterator.remove(); drop("progress_evicted"); }
            }
        }
        if (pending.size() >= MAX_ITEMS || bytes + item.bytes > MAX_BYTES) { drop("overflow"); return false; }
        pending.addLast(item); bytes += item.bytes; return true;
    }
    void cancelFollowups() { for (Item item : pending) { item.followUp = false; item.followUpCancelled = true; } }
    void reconfigure(NativeVoiceSettings settings) {
        ArrayList<Item> old = new ArrayList<>(pending); pending.clear(); bytes = 0;
        for (Item item : old) {
            Item next = new Item(item.envelope, settings); next.followUpCancelled = item.followUpCancelled;
            if (next.followUpCancelled) next.followUp = false;
            if (!next.speech.isEmpty() || next.followUp) enqueue(next); else drop("settings_changed");
        }
    }
    Item take() { Item value = pending.pollFirst(); if (value != null) bytes -= value.bytes; return value; }
    void clear(String reason) { while (!pending.isEmpty()) { take(); drop(reason); } }
    void reset() { pending.clear(); remembered.clear(); seen.clear(); dropped.clear(); bytes = 0; }
    void drop(String reason) { dropped.put(reason, dropped.getOrDefault(reason, 0) + 1); }
    JSONObject state() {
        JSONObject reasons = new JSONObject(); int count = 0;
        for (Map.Entry<String, Integer> entry : dropped.entrySet()) { NativeVoiceJson.put(reasons, entry.getKey(), entry.getValue()); count += entry.getValue(); }
        return NativeVoiceJson.object("count", size(), "bytes", bytes, "droppedCount", count, "droppedReasons", reasons);
    }
    private static String speech(JSONObject payload, NativeVoiceSettings settings) {
        ArrayList<String> parts = new ArrayList<>();
        if (settings.flag("readNotificationContext")) {
            add(parts, payload.optString("title", ""));
            add(parts, payload.optString("message", ""));
        }
        if (payload.optString("event").equals("turn.progress")) appendBounded(parts, payload.optJSONObject("progress"));
        else if (payload.optString("event").equals("turn.completed")) {
            JSONObject result = payload.optJSONObject("assistantResult");
            if (result != null) for (String phase : new String[] { "provisional", "unclassified", "final" }) appendBounded(parts, result.optJSONObject(phase));
        } else if (!settings.flag("readNotificationContext")) add(parts, payload.optString("message", ""));
        StringBuilder speech = new StringBuilder();
        boolean cleanup = settings.flag("cleanSpeechText");
        // Each notification part is an independent document. An unfinished fence in a
        // truncated section must not consume context, its truncation notice, or later results.
        for (String part : parts) {
            String prepared = NativeSpeechText.prepare(part, cleanup);
            if (prepared.isEmpty()) continue;
            if (speech.length() > 0) speech.append(cleanup ? "\n\n" : "\n");
            speech.append(prepared);
        }
        return speech.toString();
    }
    private static void appendBounded(List<String> parts, JSONObject text) {
        if (text == null) return;
        add(parts, text.optString("text", ""));
        if (text.optJSONObject("truncation") != null) parts.add("The remaining response was truncated.");
    }
    private static void add(List<String> parts, String text) { if (text != null && !text.trim().isEmpty()) parts.add(text.trim()); }
    static List<String> chunks(String input, int limit) {
        if (limit < 2) throw new IllegalArgumentException("voice_text_limit_invalid");
        ArrayList<String> result = new ArrayList<>();
        BreakIterator sentences = BreakIterator.getSentenceInstance(Locale.ROOT); sentences.setText(input);
        int start = 0;
        while (start < input.length()) {
            int end = Math.min(input.length(), start + limit);
            if (end < input.length()) {
                int sentence = sentences.preceding(end + 1);
                if (sentence > start) end = sentence;
                else {
                    int word = end;
                    while (word > start && !Character.isWhitespace(input.charAt(word - 1))) word--;
                    if (word > start) end = word;
                }
                if (end > start && Character.isHighSurrogate(input.charAt(end - 1)) && Character.isLowSurrogate(input.charAt(end))) end--;
            }
            if (end <= start) throw new IllegalArgumentException("voice_text_split_failed");
            result.add(input.substring(start, end)); start = end;
        }
        return result;
    }
    static boolean isStopCommand(String text) {
        String normalized = text.trim().toLowerCase(Locale.ROOT).replaceFirst("[\\p{Punct}\\p{P}]+$", "").trim();
        return normalized.equals("stop") || normalized.equals("stop listening");
    }
}
