package dev.sedes.local;

import java.util.ArrayList;
import java.util.List;

/** Validates Android's paired communication source without equating input and output product names. */
final class NativeVoiceBluetoothRoute {
    static final class Device {
        final int id;
        final NativeVoiceInput identity;
        Device(int id, NativeVoiceInput identity) { this.id = id; this.identity = identity; }
    }
    private final NativeVoiceInput preference;
    private final int sinkId, sourceId;
    private NativeVoiceBluetoothRoute(NativeVoiceInput preference, int sinkId, int sourceId) {
        this.preference = preference; this.sinkId = sinkId; this.sourceId = sourceId;
    }
    static Device selectedSink(NativeVoiceInput preference, List<Device> available, Device active) {
        if (preference == null || active == null || (preference.type != 7 && preference.type != 26)) return null;
        List<NativeVoiceInput> identities = new ArrayList<>();
        for (Device device : available) identities.add(device.identity);
        int selected = NativeVoiceInput.resolve(preference, identities);
        if (selected < 0) return null;
        Device sink = available.get(selected);
        return active.id == sink.id && preference.matches(active.identity) && sink.identity.matches(active.identity) ? sink : null;
    }
    static NativeVoiceBluetoothRoute begin(NativeVoiceInput preference, List<Device> available, Device active, Device source) {
        Device sink = selectedSink(preference, available, active);
        if (!paired(sink, source)) return null;
        return new NativeVoiceBluetoothRoute(preference, sink.id, source.id);
    }
    boolean accepts(List<Device> available, Device active, Device source) {
        if (active == null || source == null || active.id != sinkId || source.id != sourceId) return false;
        return paired(selectedSink(preference, available, active), source);
    }
    private static boolean paired(Device sink, Device source) {
        if (sink == null || source == null || sink.identity.type != source.identity.type) return false;
        // setCommunicationDevice selects the matching source itself. When either endpoint's address is
        // unavailable, the verified active sink and Bluetooth source type are the platform's pairing proof.
        String sinkAddress = sink.identity.address, sourceAddress = source.identity.address;
        return sinkAddress == null || sourceAddress == null || sinkAddress.equals(sourceAddress);
    }
}
