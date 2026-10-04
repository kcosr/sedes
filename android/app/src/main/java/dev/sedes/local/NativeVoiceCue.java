package dev.sedes.local;

/** Local recognition feedback, independent of speech providers and speech volume. */
final class NativeVoiceCue {
    enum Kind { START, SUCCESS, FAILURE }
    static final int SAMPLE_RATE = 48000;

    static byte[] pcm(Kind kind) {
        double[] frequencies;
        int[] durations;
        double[] amplitudes;
        switch (kind) {
            case SUCCESS:
                frequencies = new double[] { 659.25 }; durations = new int[] { 140 }; amplitudes = new double[] { 0.16 }; break;
            case FAILURE:
                frequencies = new double[] { 659.25, 0, 493.88 }; durations = new int[] { 105, 55, 140 };
                amplitudes = new double[] { 0.14, 0, 0.16 }; break;
            default:
                frequencies = new double[] { 523.25, 0, 659.25 }; durations = new int[] { 95, 55, 140 };
                amplitudes = new double[] { 0.14, 0, 0.16 }; break;
        }
        int samples = 0;
        for (int duration : durations) samples += SAMPLE_RATE * duration / 1000;
        byte[] pcm = new byte[samples * 2];
        int offset = 0;
        for (int segment = 0; segment < durations.length; segment++) {
            int count = SAMPLE_RATE * durations[segment] / 1000;
            for (int i = 0; i < count; i++) {
                double envelope = Math.min(1d, Math.min(i, count - 1 - i) / (SAMPLE_RATE / 80d));
                short value = (short) (Math.sin(2 * Math.PI * frequencies[segment] * i / SAMPLE_RATE)
                    * Short.MAX_VALUE * amplitudes[segment] * envelope);
                pcm[(offset + i) * 2] = (byte) value;
                pcm[(offset + i) * 2 + 1] = (byte) (value >> 8);
            }
            offset += count;
        }
        return pcm;
    }
}
