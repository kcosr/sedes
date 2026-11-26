package dev.sedes.local;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import org.json.JSONObject;

/** Live source, device phrasing and fully drained frontier for one logical notification. Handler-owned. */
final class NativeEarlyReply {
    static final int MAX_BYTES = NativeVoiceEarlyFrames.MAX_PREFIX_BYTES;
    static final long MAX_LIFETIME = 600_000, MAX_WAIT = 60_000, URGENT_WAIT = 2000;
    static final class Frame {
        final String kind, id, event, thread, turn, item, title, origin, text, reason;
        final long generation, inputRevision;
        final int seq, start, end;
        final boolean paragraph;

        Frame(JSONObject value) {
            NativeVoiceEarlyFrames.reply(value);
            kind = value.optString("kind"); id = value.optString("replyId"); thread = value.optString("threadId");
            turn = value.optString("turnId"); item = value.optString("itemId"); generation = value.optLong("generation");
            seq = value.optInt("seq"); inputRevision = value.optLong("userInputRevision", -1);
            event = value.optString("event", null); title = value.optString("threadTitle", null);
            JSONObject source = value.optJSONObject("origin"); origin = source == null ? null : source.optString("clientId");
            start = value.optInt("rawStart", -1); end = value.optInt("rawEnd", -1);
            text = value.optString("text", null); paragraph = value.optBoolean("paragraphEnd"); reason = value.optString("reason", null);
        }
    }
    /** Retain offsets into the single source buffer, never a second copy of the text or envelope. */
    private static final class Segment {
        final String kind, reason;
        final int start, end;
        final boolean paragraph;
        Segment(Frame frame) {
            kind = frame.kind; reason = frame.reason; start = frame.start; end = frame.end; paragraph = frame.paragraph;
        }
        boolean matches(Frame frame, StringBuilder source) {
            return kind.equals(frame.kind) && start == frame.start && end == frame.end && paragraph == frame.paragraph &&
                Objects.equals(reason, frame.reason) && (frame.text == null || source.substring(start, end).equals(frame.text));
        }
    }
    static final class Part {
        final String text;
        final int rawEnd, preparedEnd, titleEnd;
        Part(String text, int rawEnd, int preparedEnd, int titleEnd) {
            this.text = text; this.rawEnd = rawEnd; this.preparedEnd = preparedEnd; this.titleEnd = titleEnd;
        }
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_early_reply"); }
    final String id, event, thread, turn, item, title, origin;
    final long generation, inputRevision, opened;
    String reservation;
    long lastSpan, urgentSince = -1;
    boolean yielded, detached, skipped, titleSubmitted;
    private final ArrayList<Segment> frames = new ArrayList<>();
    private StringBuilder source = new StringBuilder();
    private int rawBytes, rawEnd, preparedEnd, titleEnd;
    private byte[] rawHash, preparedHash;
    private String mode, cachedPrepared;
    private int cachedRawEnd = -1;
    private boolean cleanup, both, requested;
    private int limit;

    NativeEarlyReply(Frame first, long now) {
        if (!first.kind.equals("begin")) throw invalid();
        id = first.id; event = first.event; thread = first.thread; turn = first.turn; item = first.item; title = first.title;
        origin = first.origin; generation = first.generation; inputRevision = first.inputRevision; opened = now;
        accept(first, now);
    }
    boolean owns(Frame frame) {
        return id.equals(frame.id) && thread.equals(frame.thread) && turn.equals(frame.turn) && item.equals(frame.item) && generation == frame.generation;
    }
    /** Returns false for an exact repeat. Callers detach on sequence, source or capacity disagreement. */
    boolean accept(Frame frame, long now) {
        if (!owns(frame)) throw invalid();
        if (detached) return false;
        if (frame.seq < frames.size()) {
            boolean sameBegin = frame.seq != 0 || event.equals(frame.event) && Objects.equals(title, frame.title) &&
                Objects.equals(origin, frame.origin) && inputRevision == frame.inputRevision;
            if (sameBegin && frames.get(frame.seq).matches(frame, source)) return false;
            throw invalid();
        }
        if (frame.seq != frames.size() || yielded && !frame.kind.equals("cancel")) throw invalid();
        if (frame.text != null) {
            int bytes = rawBytes + NativeVoiceJson.bytes(frame.text);
            if (frame.start != source.length() || bytes > MAX_BYTES || frame.text.isEmpty() && frames.get(frame.seq-1).paragraph) throw invalid();
            rawBytes = bytes; source.append(frame.text); lastSpan = now;
        } else yielded = true;
        frames.add(new Segment(frame)); return true;
    }
    int pendingBytes() { return rawBytes; }
    void freeze(String mode, NativeVoiceSettings settings, int limit) {
        if (requested) return;
        this.mode = mode;
        if (cleanup != settings.flag("cleanSpeechText")) cachedRawEnd = -1;
        cleanup = settings.flag("cleanSpeechText");
        both = settings.text("speechContent").equals("both"); this.limit = limit;
    }
    void requested() { requested = true; }
    private static String prepare(String value, boolean cleanup) {
        return NativeSpeechText.prepare(cleanup ? value : value.trim(), cleanup);
    }
    private String prepared(int end) {
        if (cachedRawEnd != end) {
            cachedPrepared = prepare(source.substring(0, end), cleanup); cachedRawEnd = end;
        }
        return cachedPrepared;
    }

    /** Preview after a physically drained or reserved part. Preview never commits or consumes text. */
    Part next(Part reserved) {
        if (detached || mode == null) return null;
        int raw = reserved == null ? rawEnd : reserved.rawEnd;
        int spoken = reserved == null ? preparedEnd : reserved.preparedEnd;
        int attributed = reserved == null ? titleEnd : reserved.titleEnd;
        String prepared = prepared(raw);
        if (spoken > prepared.length()) throw invalid();
        int end = raw;
        if (spoken == prepared.length()) {
            end = readyEnd(raw);
            if (end == raw) return null;
            String full = prepared(end);
            if (!full.startsWith(prepared)) throw invalid();
            prepared = full;
        }
        if (both) {
            String name = prepare(title, cleanup);
            int start = skipSeparators(name, attributed);
            if (start < name.length()) {
                String text = NativeVoiceQueue.firstChunk(name, start, limit);
                return new Part(text, raw, spoken, start + text.length());
            }
        }
        int start = skipSeparators(prepared, spoken);
        if (start == prepared.length()) throw invalid();
        String chunk = NativeVoiceQueue.firstChunk(prepared, start, limit);
        return new Part(chunk, end, start + chunk.length(), attributed);
    }
    private static int skipSeparators(String text, int start) {
        while (start < text.length() && Character.isWhitespace(text.charAt(start))) start++;
        return start;
    }
    private int readyEnd(int raw) {
        int end = raw;
        for (Segment frame : frames) {
            if (frame.end <= raw) continue;
            if (mode.equals("balanced") && end > raw && frame.end - raw > 240) return end;
            end = frame.end;
            if (frame.paragraph || mode.equals("responsive") || mode.equals("balanced") && raw == 0 ||
                mode.equals("natural") && end - raw >= 320) return end;
        }
        return mode.equals("natural") && !yielded ? raw : end;
    }
    boolean matchesNotice(NativeVoiceQueue.Item notice) {
        if (!event.equals(notice.event)) return false;
        if (!notice.progress()) return true;
        JSONObject progress = notice.envelope.optJSONObject("payload").optJSONObject("progress");
        return item.equals(progress.optString("itemId"));
    }
    private JSONObject spokenSection(JSONObject payload) {
        if (event.equals("turn.progress")) return payload.optJSONObject("progress");
        JSONObject result = payload.optJSONObject("assistantResult");
        return result == null ? null : result.optJSONObject("final");
    }
    boolean agreesWith(Part part, NativeVoiceQueue.Item terminal) {
        if (part == null || part.rawEnd == 0) return true;
        JSONObject section = spokenSection(terminal.envelope.optJSONObject("payload"));
        if (section == null) return false;
        String raw = section.optString("text");
        return raw.startsWith(source.substring(0, part.rawEnd)) && prepare(raw, cleanup).startsWith(prepared(part.rawEnd).substring(0, part.preparedEnd));
    }
    void submitted(Part part) {
        if (part != null && part.titleEnd > titleEnd) titleSubmitted = true;
    }
    void drained(Part part) {
        if (part == null || detached) return;
        rawEnd = part.rawEnd; preparedEnd = part.preparedEnd; titleEnd = part.titleEnd;
    }
    void detach() {
        if (detached) return;
        if (preparedEnd > 0) {
            rawHash = hash(source.substring(0, rawEnd)); preparedHash = hash(prepared(rawEnd).substring(0, preparedEnd));
        }
        frames.clear(); frames.trimToSize(); source = null; cachedPrepared = null; cachedRawEnd = -1; rawBytes = 0; detached = true;
    }
    private static byte[] hash(String value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }
    /** Reconcile once, at activation after any other speaker, against the terminal's whole selected document. */
    String terminal(NativeVoiceQueue.Item notice, NativeVoiceSettings settings, String lastOwner) {
        detach();
        if (mode == null || !titleSubmitted && preparedEnd == 0 || notice.speech.isEmpty() ||
            !settings.mode().equals("speak") || settings.text("speechContent").equals("announcements")) return notice.speech;
        JSONObject payload = notice.envelope.optJSONObject("payload");
        JSONObject section = spokenSection(payload);
        String raw = section == null ? "" : section.optString("text", "");
        String authoritative = prepare(raw, cleanup);
        if (preparedEnd > 0 && (raw.length() < rawEnd || authoritative.length() < preparedEnd ||
            !Arrays.equals(rawHash, hash(raw.substring(0, rawEnd))) ||
            !Arrays.equals(preparedHash, hash(authoritative.substring(0, preparedEnd)))))
            return NativeVoiceQueue.speech(payload, both ? "both" : "messages", cleanup);
        ArrayList<String> parts = new ArrayList<>();
        boolean context = both;
        boolean reintroduce = context && !id.equals(lastOwner);
        if (reintroduce) {
            add(parts, prepare(payload.optString("message"), cleanup));
            add(parts, prepare(payload.optString("title"), cleanup));
        }
        add(parts, authoritative.substring(preparedEnd).trim());
        if (section != null && section.has("truncation")) add(parts, "The remaining response was truncated.");
        if (context && !reintroduce) add(parts, prepare(payload.optString("title"), cleanup));
        JSONObject result = notice.progress() ? null : payload.optJSONObject("assistantResult");
        if (result != null) for (String phase : NativeVoiceProtocol.RESULT_PHASES) {
            JSONObject other = result.optJSONObject(phase);
            if (phase.equals("final") || other == null) continue;
            add(parts, prepare(other.optString("text"), cleanup));
            if (other.has("truncation")) add(parts, "The remaining response was truncated.");
        }
        return String.join(cleanup ? "\n\n" : "\n", parts);
    }
    private static void add(List<String> parts, String text) { if (!text.trim().isEmpty()) parts.add(text); }
}
