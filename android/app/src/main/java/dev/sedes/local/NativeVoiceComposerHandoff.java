package dev.sedes.local;

import java.util.Objects;

/** Live-process reservation: once offered, this recording cannot fall back to native submission. */
final class NativeVoiceComposerHandoff {
    final String id, binding, recordingId, threadId, text, mode;
    final long generation;
    final Object context;
    boolean claimed, finished;

    NativeVoiceComposerHandoff(String id, String binding, long generation, Object context,
            String recordingId, String threadId, String text, boolean steer) {
        this.id = id; this.binding = binding; this.generation = generation; this.context = context;
        this.recordingId = recordingId; this.threadId = threadId; this.text = text;
        mode = steer ? "steer" : "queue";
    }

    static boolean eligible(boolean nativeVisible, boolean foregroundVisible, boolean composerAvailable,
            String foregroundThread, String targetThread) {
        return nativeVisible && foregroundVisible && composerAvailable && targetThread != null &&
            targetThread.equals(foregroundThread);
    }

    boolean current(String owner, long generation, Object context, boolean nativeVisible,
            boolean foregroundVisible, boolean composerAvailable, String foregroundThread) {
        return !finished && Objects.equals(binding, owner) && this.generation == generation &&
            this.context == context && eligible(nativeVisible, foregroundVisible, composerAvailable, foregroundThread, threadId);
    }

    void claim(String owner, long generation, Object context, boolean nativeVisible,
            boolean foregroundVisible, boolean composerAvailable, String foregroundThread) {
        if (claimed || finished) throw new IllegalStateException("composer_handoff_changed");
        if (!current(owner, generation, context, nativeVisible, foregroundVisible, composerAvailable, foregroundThread))
            throw new IllegalStateException("composer_handoff_unavailable");
        claimed = true;
    }

    /** A claim can settle after connection changes only with the original reservation's binding and generation. */
    void complete(String owner, long generation, boolean accepted) {
        if (finished || !Objects.equals(binding, owner) || this.generation != generation)
            throw new IllegalStateException("composer_handoff_changed");
        if (accepted && !claimed) throw new IllegalStateException("composer_handoff_unclaimed");
        finished = true;
    }
}
