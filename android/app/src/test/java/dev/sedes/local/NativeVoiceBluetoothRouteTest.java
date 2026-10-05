package dev.sedes.local;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class NativeVoiceBluetoothRouteTest {
    private static final String ADDRESS = "AA:BB:CC:DD:EE:FF", OTHER_ADDRESS = "11:22:33:44:55:66";
    private static NativeVoiceBluetoothRoute.Device device(int id, int type, String address, String name) {
        return new NativeVoiceBluetoothRoute.Device(id, new NativeVoiceInput(type, address, name));
    }
    @Test public void systemPairingAcceptsDifferentInputAndOutputNamesWithRedactedAddresses() {
        for (int type : new int[] { 7, 26 }) for (String sinkAddress : new String[] { ADDRESS, null })
            for (String sourceAddress : new String[] { ADDRESS, null }) {
                NativeVoiceBluetoothRoute.Device sink = device(10, type, sinkAddress, "Headset"), source = device(20, type, sourceAddress, "Phone audio");
                NativeVoiceBluetoothRoute route = NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, source);
                assertNotNull(route); assertTrue(route.accepts(List.of(sink), sink, source));
            }
    }
    @Test public void reconnectedDeviceGetsNewIdsOnlyForANewCapture() {
        NativeVoiceBluetoothRoute.Device sink = device(10, 7, ADDRESS, "Headset"), source = device(20, 7, ADDRESS, "Microphone");
        NativeVoiceBluetoothRoute original = NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, source); assertNotNull(original);
        NativeVoiceBluetoothRoute.Device reconnectedSink = device(11, 7, ADDRESS, "Renamed headset"), reconnectedSource = device(21, 7, ADDRESS, "Microphone");
        List<NativeVoiceBluetoothRoute.Device> current = List.of(reconnectedSink);
        assertFalse(original.accepts(current, reconnectedSink, reconnectedSource));
        assertFalse(original.accepts(current, reconnectedSink, source));
        assertFalse(original.accepts(List.of(sink), sink, reconnectedSource));
        NativeVoiceBluetoothRoute next = NativeVoiceBluetoothRoute.begin(sink.identity, current, reconnectedSink, reconnectedSource);
        assertNotNull(next); assertTrue(next.accepts(current, reconnectedSink, reconnectedSource));
    }
    @Test public void requiresTheUniquelySelectedSinkToActuallyBeActive() {
        NativeVoiceBluetoothRoute.Device sink = device(10, 7, null, "Headset"), source = device(20, 7, null, "Phone");
        NativeVoiceBluetoothRoute.Device other = device(11, 7, null, "Other headset"), duplicate = device(12, 7, null, "Headset");
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(), sink, source));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), null, source));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink, other), other, source));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink, duplicate), sink, source));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), duplicate, source));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), device(10, 7, null, "Other headset"), source));
    }
    @Test public void neverAcceptsBuiltInOrOtherDeviceTypeAsABluetoothSource() {
        NativeVoiceBluetoothRoute.Device sink = device(10, 7, null, "Headset");
        for (int type : new int[] { 15, 11, 26 })
            assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, device(20, type, null, "Headset")));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, null));
        NativeVoiceBluetoothRoute.Device wired = device(30, 3, null, "Wired headset");
        assertNull(NativeVoiceBluetoothRoute.begin(wired.identity, List.of(wired), wired, device(31, 3, null, "Microphone")));
        assertNull(NativeVoiceBluetoothRoute.begin(null, List.of(sink), sink, device(20, 7, null, "Headset")));
    }
    @Test public void meaningfulConflictingAddressesNeverBecomeNameFallback() {
        NativeVoiceBluetoothRoute.Device sink = device(10, 7, ADDRESS, "Headset"), wrongSource = device(20, 7, OTHER_ADDRESS, "Headset");
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, wrongSource));
        NativeVoiceInput preferred = new NativeVoiceInput(7, null, "Headset");
        NativeVoiceBluetoothRoute.Device wrongActive = device(10, 7, OTHER_ADDRESS, "Headset");
        assertNull(NativeVoiceBluetoothRoute.begin(preferred, List.of(sink), wrongActive, device(20, 7, ADDRESS, "Phone")));
        assertNull(NativeVoiceBluetoothRoute.begin(sink.identity, List.of(device(10, 7, null, "Headset")), sink, wrongSource));
    }
    @Test public void sourceAndSinkLossTerminateTheExistingCaptureDespiteUnchangedOtherEndpoint() {
        NativeVoiceBluetoothRoute.Device sink = device(10, 7, ADDRESS, "Headset"), source = device(20, 7, ADDRESS, "Phone");
        NativeVoiceBluetoothRoute route = NativeVoiceBluetoothRoute.begin(sink.identity, List.of(sink), sink, source); assertNotNull(route);
        assertFalse(route.accepts(List.of(sink), null, source));
        assertFalse(route.accepts(List.of(), sink, source));
        assertFalse(route.accepts(List.of(sink), sink, null));
        assertFalse(route.accepts(List.of(sink), sink, device(20, 15, null, "Phone")));
        assertFalse(route.accepts(List.of(sink, device(11, 7, ADDRESS, "Duplicate")), sink, source));
        assertFalse(route.accepts(List.of(sink), sink, device(20, 7, OTHER_ADDRESS, "Phone")));
        assertFalse(route.accepts(List.of(sink), device(10, 7, OTHER_ADDRESS, "Headset"), source));
    }
}
