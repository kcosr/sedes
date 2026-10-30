package dev.sedes.local;

/** A bounded, pull-driven encoder for one recognition segment. No Android dependencies. */
interface NativeVoiceAudioEncoder extends AutoCloseable {
    interface Factory { NativeVoiceAudioEncoder create(int bitrate); }

    /** Copies the whole PCM16LE mono/24 kHz packet, or returns false without consuming it. */
    boolean offer(byte[] pcm);
    /** Requests EOS once. Subsequent calls are harmless; peek continues to drain the codec. */
    void finish();
    /** Advances codec work without waiting and returns the next complete Ogg page, if available. */
    byte[] peek();
    /** Removes exactly the page returned by peek after the transport has accepted it. */
    void pop();
    /** True only after codec EOS and all encoded output have been consumed. */
    boolean finished();
    long sourceSamples();
    @Override void close();
}
