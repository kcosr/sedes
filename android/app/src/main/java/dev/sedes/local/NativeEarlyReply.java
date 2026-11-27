package dev.sedes.local;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.BreakIterator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/** Live source, device phrasing and fully drained frontier for one logical notification. Handler-owned. */
final class NativeEarlyReply {
    static final int MAX_BYTES = NativeVoiceEarlyFrames.MAX_PREFIX_BYTES;
    static final long MAX_LIFETIME = 600_000, MAX_WAIT = 60_000, URGENT_WAIT = 2000;
    private static final int MIN_RESPONSIVE_WORDS = 3;
    private static final Pattern WORD_CHARACTER = Pattern.compile("[\\p{L}\\p{N}]");
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
        private int words = -1;
        Segment(Frame frame) {
            kind = frame.kind; reason = frame.reason; start = frame.start; end = frame.end; paragraph = frame.paragraph;
        }
        boolean matches(Frame frame, StringBuilder source) {
            return kind.equals(frame.kind) && start == frame.start && end == frame.end && paragraph == frame.paragraph &&
                Objects.equals(reason, frame.reason) && (frame.text == null || source.substring(start, end).equals(frame.text));
        }
        int words(StringBuilder source) {
            if (words >= 0) return words;
            String text = source.substring(start, end).replace('–', ' ').replace('—', ' ');
            BreakIterator bounds = BreakIterator.getWordInstance(Locale.ROOT);
            bounds.setText(text);
            Matcher lettersOrNumbers = WORD_CHARACTER.matcher(text);
            int count = 0, previousEnd = -1;
            for (int from = bounds.first(), to = bounds.next(); to != BreakIterator.DONE; from = to, to = bounds.next()) {
                if (!lettersOrNumbers.region(from, to).find()) continue;
                // Some word iterators split compounds at an apostrophe or hyphen.
                boolean joined = previousEnd >= 0 && from == previousEnd + 1 && joinsWords(text.charAt(previousEnd));
                if (!joined && ++count == MIN_RESPONSIVE_WORDS) break;
                previousEnd = to;
            }
            return words = count;
        }
        private static boolean joinsWords(char c) {
            return c == '\'' || c == '‘' || c == '’' || c == '-' || c == '‐' || c == '‑';
        }
    }
    static final class Part {
        final String text;
        final int rawEnd, preparedEnd, preambleEnd;
        Part(String text, int rawEnd, int preparedEnd, int preambleEnd) {
            this.text = text; this.rawEnd = rawEnd; this.preparedEnd = preparedEnd; this.preambleEnd = preambleEnd;
        }
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("invalid_early_reply"); }
    final String id, event, thread, turn, item, title, origin;
    final long generation, inputRevision, opened;
    String reservation;
    long lastSpan, urgentSince = -1;
    boolean yielded, detached, skipped;
    private final ArrayList<Segment> frames = new ArrayList<>();
    private StringBuilder source = new StringBuilder();
    private int rawBytes, rawEnd, preparedEnd, preambleEnd;
    private byte[] rawHash, preparedHash;
    private String mode, cachedPrepared, preamble;
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
        String label = event.equals("turn.progress") ? "Agent progress" : "Agent finished";
        preamble = both ? NativeVoiceQueue.assemble(Arrays.asList(label, title), cleanup) : "";
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
        int headerEnd = reserved == null ? preambleEnd : reserved.preambleEnd;
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
        int headerStart = skipSeparators(preamble, headerEnd);
        if (headerStart < preamble.length()) {
            String text = NativeVoiceQueue.firstChunk(preamble, headerStart, limit);
            return new Part(text, raw, spoken, headerStart + text.length());
        }
        int start = skipSeparators(prepared, spoken);
        if (start == prepared.length()) throw invalid();
        String chunk = NativeVoiceQueue.firstChunk(prepared, start, limit);
        return new Part(chunk, end, start + chunk.length(), headerEnd);
    }
    private static int skipSeparators(String text, int start) {
        while (start < text.length() && Character.isWhitespace(text.charAt(start))) start++;
        return start;
    }
    private int readyEnd(int raw) {
        int end = raw, words = 0;
        boolean responsive = mode.equals("responsive");
        for (Segment frame : frames) {
            if (frame.end <= raw) continue;
            if (mode.equals("balanced") && end > raw && frame.end - raw > 240) return end;
            end = frame.end;
            if (responsive) {
                words += frame.words(source);
                if (words >= MIN_RESPONSIVE_WORDS) return end;
            } else if (frame.paragraph || mode.equals("balanced") && raw == 0 ||
                mode.equals("natural") && end - raw >= 320) return end;
        }
        return (responsive || mode.equals("natural")) && !yielded ? raw : end;
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
    void drained(Part part) {
        if (part == null || detached) return;
        rawEnd = part.rawEnd; preparedEnd = part.preparedEnd; preambleEnd = part.preambleEnd;
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
        if (notice.speech.isEmpty() || !settings.mode().equals("speak")) return notice.speech;
        JSONObject payload = notice.envelope.optJSONObject("payload");
        if (settings.text("speechContent").equals("announcements")) {
            if (preambleEnd > 0) {
                String remaining = preamble.substring(preambleEnd).trim();
                if (remaining.isEmpty() || id.equals(lastOwner)) return remaining;
            }
            return NativeVoiceQueue.speech(payload, "announcements", settings.flag("cleanSpeechText"));
        }
        if (mode == null || preambleEnd == 0 && preparedEnd == 0) return notice.speech;
        String remaining = remainingSpeech(payload);
        if (!both || remaining.isEmpty()) return remaining;
        String header = id.equals(lastOwner) ? preamble.substring(preambleEnd).trim()
            : NativeVoiceQueue.speech(payload, "announcements", cleanup);
        return header.isEmpty() ? remaining : header + (cleanup ? "\n\n" : "\n") + remaining;
    }
    private String remainingSpeech(JSONObject payload) {
        if (preparedEnd == 0) return NativeVoiceQueue.speech(payload, "messages", cleanup);
        JSONObject section = spokenSection(payload);
        String raw = section == null ? "" : section.optString("text", "");
        String authoritative = prepare(raw, cleanup);
        if (raw.length() < rawEnd || authoritative.length() < preparedEnd ||
            !Arrays.equals(rawHash, hash(raw.substring(0, rawEnd))) ||
            !Arrays.equals(preparedHash, hash(authoritative.substring(0, preparedEnd))))
            return NativeVoiceQueue.speech(payload, "messages", cleanup);
        ArrayList<String> parts = new ArrayList<>();
        add(parts, authoritative.substring(preparedEnd).trim());
        if (section != null && section.has("truncation")) add(parts, "The remaining response was truncated.");
        JSONObject result = payload.optJSONObject("assistantResult");
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
