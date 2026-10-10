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
import java.util.UUID;
import org.json.JSONObject;

/** Pure queue/presentation policy; the runtime exclusively owns the active item. */
final class NativeVoiceQueue {
    static final int MAX_ITEMS = 64, MAX_BYTES = 256 * 1024, RETAINED_IDS = 4096;
    // The server fits payloads to this JSON.stringify UTF-8 size; measuring the same way accepts every such payload.
    static final long MAX_PAYLOAD_BYTES = 65536;
    private static final Set<String> EVENTS = new HashSet<>(java.util.Arrays.asList("turn.progress", "turn.completed", "turn.failed",
        "turn.interrupted", "thread.woke", "automation.started", "automation.failed", "approval.requested", "input.requested", "question.requested"));
    /** Event kind of a local, user-requested turn reply replay. */
    static final String REPLAY = "replay";
    static final class Item {
        final String id, event, speech, subject, threadId, threadTitle, origin;
        final JSONObject target;
        /** A server notification's original envelope; null for a local replay. */
        final JSONObject envelope;
        /** A local replay's validated speakReply request; null for a server notification. */
        final JSONObject request;
        final long policyGeneration;
        boolean followUp, followUpCancelled;
        final int bytes;
        /** Notifications are automatic. A replay is user-requested: notification filters and cancellation do not apply. */
        final boolean automatic;
        Item(JSONObject envelope, NativeVoiceSettings settings) {
            this.envelope = NativeVoiceJson.copy(envelope); request = null; automatic = true;
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
            if (result != null) NativeVoiceProtocol.assistantResult(result);
            subject = envelope.has("subjectId") ? NativeVoiceJson.string(envelope, "subjectId", 512) : null;
            String action = NativeVoiceJson.string(envelope, "voice", 32);
            if (!action.equals("none") && !action.equals("speak") && !action.equals("speakThenListen")) throw new IllegalArgumentException("voice_action_invalid");
            if (action.equals("speakThenListen") && (event.equals("turn.progress") || event.endsWith(".requested")))
                throw new IllegalArgumentException("voice_action_invalid");
            boolean inputOnly = settings.mode().equals("input");
            followUp = settings.flag("autoListen") && action.equals("speakThenListen") && target != null &&
                (!inputOnly || event.equals("turn.completed"));
            speech = !settings.mode().equals("speak") || action.equals("none") ? "" : speech(payload, settings);
            bytes = NativeVoiceJson.bytes(speech);
        }
        private Item(String id, JSONObject request, String threadTitle, NativeVoiceSettings settings) {
            this.id = id; this.request = request; this.threadTitle = threadTitle;
            envelope = null; event = REPLAY; threadId = request.optString("threadId");
            subject = null; origin = null; target = null; policyGeneration = -1; automatic = false;
            // Notification follow-up authority does not apply to a replay. The runtime evaluates
            // current Auto-listen and fresh manual-input readiness after replay playback ends.
            followUp = false;
            speech = replaySpeech(request.optJSONObject("assistantResult"), settings);
            bytes = NativeVoiceJson.bytes(speech);
        }
        /** A fresh replay of one turn's reply; its ID never enters notification dedupe. The request comes from replayRequest. */
        static Item replay(JSONObject request, String threadTitle, NativeVoiceSettings settings) {
            Item item = new Item(UUID.randomUUID().toString(), request, threadTitle, settings);
            if (item.speech.isEmpty()) throw new IllegalStateException("voice_reply_empty");
            return item;
        }
        /** Presentation for new settings, rebuilt from the original envelope or replay request. */
        Item rebuild(NativeVoiceSettings settings) {
            return request == null ? new Item(envelope, settings) : new Item(id, request, threadTitle, settings);
        }
        boolean isReplay() { return request != null; }
        /** A turn's replay is queued or playing at most once at a time. */
        String replayIdentity() { return request == null ? null : threadId + "\n" + request.optString("turnId"); }
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
    /** Queues a replay outside notification dedupe. False when the same turn's replay is already pending. */
    boolean addReplay(Item item) {
        for (Item old : pending) if (item.replayIdentity().equals(old.replayIdentity())) return false;
        // A user request is refused explicitly rather than silently dropped, and a refusal evicts nothing.
        if (!fitsAfterProgressEviction(item) || !enqueue(item)) throw new IllegalStateException("voice_queue_full");
        return true;
    }
    /** Whether a non-progress item fits once every pending progress item, the only evictable kind, has yielded. */
    private boolean fitsAfterProgressEviction(Item item) {
        int count = pending.size(), size = bytes;
        for (Item old : pending) if (old.progress()) { count--; size -= old.bytes; }
        return count < MAX_ITEMS && size + item.bytes <= MAX_BYTES;
    }
    /** Strict speakReply bridge arguments, validated before readiness or queue state is considered. */
    static JSONObject replayRequest(JSONObject args) {
        NativeVoiceJson.keys(args, "threadId", "turnId", "assistantResult", "threadTitle");
        NativeVoiceJson.string(args, "threadId", 512); NativeVoiceJson.string(args, "turnId", 160);
        NativeVoiceJson.nullableString(args, "threadTitle", 512);
        NativeVoiceProtocol.assistantResult(NativeVoiceJson.requiredObject(args, "assistantResult"));
        return NativeVoiceJson.copy(args);
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
        if (pending.size() >= MAX_ITEMS || bytes + item.bytes > MAX_BYTES) { drop(item, "overflow"); return false; }
        pending.addLast(item); bytes += item.bytes; return true;
    }
    void cancelFollowups() { for (Item item : pending) { item.followUp = false; item.followUpCancelled = true; } }
    void reconfigure(NativeVoiceSettings settings) {
        ArrayList<Item> old = new ArrayList<>(pending); pending.clear(); bytes = 0;
        for (Item item : old) {
            Item next = item.rebuild(settings); next.followUpCancelled = item.followUpCancelled;
            if (next.followUpCancelled) next.followUp = false;
            if (!next.speech.isEmpty() || next.followUp) enqueue(next); else drop(next, "settings_changed");
        }
    }
    Item take() { Item value = pending.pollFirst(); if (value != null) bytes -= value.bytes; return value; }
    void clear(String reason) { while (!pending.isEmpty()) drop(take(), reason); }
    /** An explicit Stop removes pending playback without reporting loss or forgetting notification dedupe. */
    void clearPending() { pending.clear(); bytes = 0; }
    /** Notification loss and policy changes clear automatic notices; user-requested replays stay queued. */
    void clearAutomatic(String reason) {
        Iterator<Item> iterator = pending.iterator();
        while (iterator.hasNext()) {
            Item item = iterator.next();
            if (item.automatic) { bytes -= item.bytes; iterator.remove(); drop(reason); }
        }
    }
    /** A stopped voice service ends pending replays. Automatic items stay for drain to judge; replays never count as drops. */
    void clearReplays() {
        Iterator<Item> iterator = pending.iterator();
        while (iterator.hasNext()) {
            Item item = iterator.next();
            if (item.isReplay()) { bytes -= item.bytes; iterator.remove(); }
        }
    }
    void reset() { pending.clear(); remembered.clear(); seen.clear(); dropped.clear(); bytes = 0; }
    void drop(String reason) { dropped.put(reason, dropped.getOrDefault(reason, 0) + 1); }
    /** Drop counts report automatic voice items only; a replay is the user's own request. */
    private void drop(Item item, String reason) { if (item.automatic) drop(reason); }
    JSONObject state() {
        JSONObject reasons = new JSONObject(); int count = 0;
        for (Map.Entry<String, Integer> entry : dropped.entrySet()) { NativeVoiceJson.put(reasons, entry.getKey(), entry.getValue()); count += entry.getValue(); }
        return NativeVoiceJson.object("count", size(), "bytes", bytes, "droppedCount", count, "droppedReasons", reasons);
    }
    private static String speech(JSONObject payload, NativeVoiceSettings settings) {
        ArrayList<String> parts = new ArrayList<>();
        String content = settings.text("speechContent");
        if (!content.equals("messages")) {
            add(parts, payload.optString("title", ""));
            add(parts, payload.optString("message", ""));
        }
        if (!content.equals("announcements")) {
            if (payload.optString("event").equals("turn.progress")) appendBounded(parts, payload.optJSONObject("progress"));
            else if (payload.optString("event").equals("turn.completed")) appendResult(parts, payload.optJSONObject("assistantResult"));
        }
        return assemble(parts, settings.flag("cleanSpeechText"));
    }
    /** A replay explicitly requests the reply alone, independently of automatic speech content. */
    private static String replaySpeech(JSONObject result, NativeVoiceSettings settings) {
        ArrayList<String> parts = new ArrayList<>();
        appendResult(parts, result);
        return assemble(parts, settings.flag("cleanSpeechText"));
    }
    private static void appendResult(List<String> parts, JSONObject result) {
        if (result != null) for (String phase : NativeVoiceProtocol.RESULT_PHASES) appendBounded(parts, result.optJSONObject(phase));
    }
    private static String assemble(List<String> parts, boolean cleanup) {
        StringBuilder speech = new StringBuilder();
        // Each notification part is an independent document. An unfinished fence in a
        // truncated section must not consume context, its truncation notice, or later results.
        for (String part : parts) {
            // Leading indentation is Markdown syntax; only raw assembly keeps the old trim.
            String prepared = NativeSpeechText.prepare(cleanup ? part : part.trim(), cleanup);
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
    private static void add(List<String> parts, String text) { if (text != null && !text.trim().isEmpty()) parts.add(text); }
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
