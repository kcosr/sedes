package dev.sedes.local;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class NativeVoiceInputTest {
    private static NativeVoiceInput input(int type, String address, String name) { return new NativeVoiceInput(type, address, name); }
    @Test public void reconnectResolvesCurrentInventoryByAddressWithoutDependingOnOrderOrName() {
        NativeVoiceInput preferred = input(7, "AA:BB:CC:DD:EE:FF", "Headset");
        assertEquals(0, NativeVoiceInput.resolve(preferred, List.of(preferred)));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(input(15, null, "Built-in"))));
        assertEquals(1, NativeVoiceInput.resolve(preferred, List.of(input(7, "11:22:33:44:55:66", "Headset"), input(7, preferred.address, "Renamed headset"))));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(input(7, "11:22:33:44:55:66", "Headset"))));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(input(15, preferred.address, "Headset"))));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(preferred, preferred)));
    }
    @Test public void absentAddressesRequireAnUnambiguousNameAndType() {
        NativeVoiceInput preferred = input(7, null, "Headset");
        assertEquals(1, NativeVoiceInput.resolve(preferred, List.of(input(15, null, "Headset"), input(7, null, "Headset"))));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(preferred, preferred)));
        assertEquals(-1, NativeVoiceInput.resolve(preferred, List.of(input(7, null, "Different headset"))));
        assertEquals(-1, NativeVoiceInput.resolve(null, List.of(preferred)));
    }
    @Test public void unstableAndRedactedAddressesAreExcludedFromPreferences() {
        for (String address : new String[] { "", " ", "02:00:00:00:00:00", "00:00:00:00:00:00" }) assertNull(NativeVoiceInput.stableAddress(7, address));
        for (int type : new int[] { 11, 12, 22 }) assertNull(NativeVoiceInput.stableAddress(type, "card=3;device=0;"));
        assertEquals("AA:BB:CC:DD:EE:FF", NativeVoiceInput.stableAddress(7, "aa:bb:cc:dd:ee:ff"));
        assertEquals("bottom", NativeVoiceInput.stableAddress(15, "bottom"));
    }
    @Test public void onlyStrictPersistentIdentityIsAccepted() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        NativeVoiceInput preference = input(7, null, "Headset");
        NativeVoiceSettings selected = defaults.patch(0, NativeVoiceJson.object("inputDevice", preference.json()));
        assertEquals(preference, NativeVoiceInput.read(new NativeVoiceSettings(selected.revision, NativeVoiceJson.copy(selected.value)).value));
        assertNull(NativeVoiceInput.read(selected.patch(1, NativeVoiceJson.object("inputDevice", null)).value));
        assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("inputDeviceId", "42")));
        assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("inputDevice", "42")));
        for (org.json.JSONObject value : new org.json.JSONObject[] {
            NativeVoiceJson.object("type", 7, "name", "Headset"),
            NativeVoiceJson.object("type", 7, "address", null, "name", "Headset", "id", "42"),
            NativeVoiceJson.object("type", 7, "address", "02:00:00:00:00:00", "name", "Headset") })
            assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("inputDevice", value)));
    }
}
