package dev.sedes.local;

import java.util.List;
import java.util.Locale;
import java.util.Objects;
import org.json.JSONObject;

/** Device identity excludes Android's connection-local AudioDeviceInfo ID. */
final class NativeVoiceInput {
    final int type;
    final String address, name;
    NativeVoiceInput(int type, String address, String name) {
        this.type = type; this.address = address; this.name = name;
    }
    static NativeVoiceInput read(JSONObject owner) {
        if (!owner.has("inputDevice")) throw new NativeVoiceJson.InvalidFieldException("inputDevice");
        if (owner.isNull("inputDevice")) return null;
        JSONObject value = NativeVoiceJson.requiredObject(owner, "inputDevice");
        NativeVoiceJson.keys(value, "type", "address", "name");
        if (value.length() != 3) throw new NativeVoiceJson.InvalidFieldException("inputDevice");
        int type = (int) NativeVoiceJson.integer(value, "type", 0, Integer.MAX_VALUE);
        String address = NativeVoiceJson.nullableString(value, "address", 512), name = NativeVoiceJson.string(value, "name", 512);
        if (!name.equals(name.trim()) || name.chars().anyMatch(Character::isISOControl) ||
            address != null && !address.equals(stableAddress(type, address))) throw new NativeVoiceJson.InvalidFieldException("inputDevice");
        return new NativeVoiceInput(type, address, name);
    }
    @Override public boolean equals(Object other) {
        if (!(other instanceof NativeVoiceInput)) return false;
        NativeVoiceInput value = (NativeVoiceInput) other;
        return type == value.type && Objects.equals(address, value.address) && name.equals(value.name);
    }
    @Override public int hashCode() { return Objects.hash(type, address, name); }
    JSONObject json() { return NativeVoiceJson.object("type", type, "address", address, "name", name); }
    static String stableAddress(int type, String raw) {
        if (raw == null) return null;
        String address = raw.trim();
        // USB ALSA card/device numbers, like AudioDeviceInfo IDs, are assigned on each connection.
        if (address.isEmpty() || address.length() > 512 || address.chars().anyMatch(Character::isISOControl) ||
            (type == 11 || type == 12 || type == 22) && address.matches("(?i).*card=\\d+.*")) return null;
        if (type == 7 || type == 26) {
            address = address.toUpperCase(Locale.ROOT);
            if (address.equals("02:00:00:00:00:00") || address.equals("00:00:00:00:00:00")) return null;
        }
        return address;
    }
    boolean matches(NativeVoiceInput candidate) {
        return type == candidate.type && (address != null ? address.equals(candidate.address) : name.equals(candidate.name));
    }
    /** An ambiguous identity stays unavailable; list order is never a routing policy. */
    static int resolve(NativeVoiceInput preferred, List<NativeVoiceInput> devices) {
        if (preferred == null) return -1;
        int result = -1;
        for (int i = 0; i < devices.size(); i++) if (preferred.matches(devices.get(i))) {
            if (result >= 0) return -1;
            result = i;
        }
        return result;
    }
}
