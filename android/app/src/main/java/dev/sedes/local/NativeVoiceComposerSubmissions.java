package dev.sedes.local;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Presentation waits are separate from recording ownership and never authorize input submission. */
final class NativeVoiceComposerSubmissions {
    // Fixed presentation bound, independent of the WebView's potentially longer save/send attempt.
    // Expiry releases audio with uncertainty; it proves neither admission nor rejection.
    static final long TIMEOUT_MS = 90000;
    static final class Hold {
        final String id, binding;
        final long generation, deadline;
        Hold(NativeVoiceComposerHandoff offer, long now) {
            id = offer.id; binding = offer.binding; generation = offer.generation;
            deadline = now + TIMEOUT_MS;
        }
        boolean current(String owner, long currentGeneration) {
            return Objects.equals(binding, owner) && generation == currentGeneration;
        }
    }
    private final Map<String, Hold> pending = new HashMap<>();

    void claim(NativeVoiceComposerHandoff offer, long now) {
        if (!offer.claimed || offer.finished || pending.containsKey(offer.id))
            throw new IllegalStateException("composer_handoff_changed");
        pending.put(offer.id, new Hold(offer, now));
    }
    /** Late, repeated, and expired completions cannot release another reservation. */
    Hold release(String id, long generation) {
        Hold hold = pending.get(id);
        if (hold == null || hold.generation != generation) return null;
        pending.remove(id);
        return hold;
    }
    boolean blocks(String binding, long generation) {
        for (Hold hold : pending.values()) if (hold.current(binding, generation)) return true;
        return false;
    }
    List<Hold> expire(long now) {
        List<Hold> expired = new ArrayList<>();
        pending.values().removeIf(hold -> {
            if (now < hold.deadline) return false;
            expired.add(hold); return true;
        });
        return expired;
    }
    void clear() { pending.clear(); }
}
