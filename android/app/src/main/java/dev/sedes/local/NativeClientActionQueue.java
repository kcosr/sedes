package dev.sedes.local;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;
import org.json.JSONObject;

/** Turn correlation and playback settlement, independent of Android transport and audio. */
final class NativeClientActionQueue {
    static final class Action {
        final JSONObject command;
        final Object navigationContext;
        final boolean voiceOnly;
        boolean settled;
        String replyEventId, replyStreamId;
        Action(JSONObject command, Object context, boolean voiceOnly) {
            this.command = NativeVoiceJson.copy(command); navigationContext = context; this.voiceOnly = voiceOnly;
        }
        boolean matches(String threadId, String turnId) {
            return Objects.equals(threadId, command.optString("sourceThreadId")) && Objects.equals(turnId, command.optString("sourceTurnId"));
        }
        boolean listens() { return command.optString("action").equals("switch_thread") && command.optBoolean("listen"); }
    }
    private final LinkedHashMap<String, Action> pending = new LinkedHashMap<>();
    private final LinkedHashSet<String> drained = new LinkedHashSet<>();
    void stage(JSONObject command, Object navigationContext, boolean voiceOnly, long now) {
        expire(now);
        discardTurn(command.optString("sourceThreadId"), command.optString("sourceTurnId"));
        if (pending.size() >= 32) throw new IllegalStateException("client_busy");
        pending.put(command.optString("id"), new Action(command, navigationContext, voiceOnly));
    }
    boolean settle(String id, String replyEventId, String replyStreamId, long expiresAt) {
        Action action = pending.get(id);
        if (action == null) return false;
        action.settled = true; action.replyEventId = replyEventId; action.replyStreamId = replyStreamId;
        NativeVoiceJson.put(action.command, "expiresAt", expiresAt); return true;
    }
    boolean cancel(String id, String threadId, String turnId) {
        Action action = pending.get(id);
        if (action == null || !action.matches(threadId, turnId)) return false;
        pending.remove(id); return true;
    }
    void drained(String id) {
        drained.add(id);
        while (drained.size() > 256) drained.remove(drained.iterator().next());
    }
    boolean suppresses(String threadId, String turnId, long now) {
        expire(now);
        for (Action action : pending.values()) if (action.matches(threadId, turnId)) return true;
        return false;
    }
    boolean hasListen(long now) {
        expire(now);
        for (Action action : pending.values()) if (action.listens()) return true;
        return false;
    }
    List<Action> takeReady(long now, boolean voiceActive, String streamId, boolean audioBusy,
        String activeThreadId, String activeTurnId, Object navigationContext, Predicate<String> queuedPlayback) {
        expire(now);
        List<Action> ready = new ArrayList<>();
        for (Action action : new ArrayList<>(pending.values())) {
            if (!action.settled || action.replyEventId != null && (queuedPlayback.test(action.replyEventId) ||
                voiceActive && Objects.equals(streamId, action.replyStreamId) && !drained.contains(action.replyEventId)) ||
                action.matches(activeThreadId, activeTurnId) || action.listens() && audioBusy) continue;
            pending.remove(action.command.optString("id"));
            if (!action.listens() && !action.voiceOnly && action.command.optString("action").equals("switch_thread") && navigationContext != action.navigationContext) continue;
            ready.add(action);
            if (action.listens()) audioBusy = true;
        }
        return ready;
    }
    void discardTurn(String threadId, String turnId) { pending.values().removeIf(action -> action.matches(threadId, turnId)); }
    void discardListens() { pending.values().removeIf(Action::listens); }
    void expire(long now) { pending.values().removeIf(action -> action.command.optLong("expiresAt") <= now); }
    void clear() { pending.clear(); drained.clear(); }
}
