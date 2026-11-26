package dev.sedes.local;

/** Per-reservation interest changes. An intervening Off revokes the reservation's current openings. */
final class NativeEarlyInterest {
    boolean enabled;
    long revision;
    private long acknowledged, disabledAt;
    void open(long revision, boolean enabled) {
        this.enabled = enabled; this.revision = revision; acknowledged = revision; disabledAt = -1;
    }
    boolean update(boolean enabled) {
        if (this.enabled == enabled) return false;
        if (revision >= NativeEarlyReplyPreferences.MAX_REVISION) throw new IllegalStateException("early_reply_revision_conflict");
        this.enabled = enabled; revision++;
        if (!enabled) disabledAt = revision;
        return true;
    }
    void acknowledge(long accepted) { acknowledged = Math.max(acknowledged, accepted); }
    boolean needsUpdate() { return revision > acknowledged; }
    boolean owesDisable() { return disabledAt > acknowledged; }
    long nextRevision() { return owesDisable() ? disabledAt : revision; }
    boolean nextEnabled() { return !owesDisable() && enabled; }
}
