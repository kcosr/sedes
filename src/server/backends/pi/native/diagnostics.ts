/** Safe recovery guidance; native paths and transport details stay private. */
export function piNativeRecoveryMessage(code: string): string | undefined {
  if (code === "pi_session_native_writer_cleanup_required")
    return "A previous Pi writer has not been proven stopped. On the execution host, verify that the old Pi process and its descendants have exited before removing that session's stale .sedes-native-writer marker. See the Pi backend recovery guide.";
  if (code === "pi_native_session_configuration_conflict")
    return "Pi is retaining a session with earlier environment settings. Release its retained work before applying the new settings.";
  if (code === "pi_native_session_ended")
    return "The Pi process ended. Release its retained session before reconnecting; unresolved operation outcomes remain available for recovery.";
  return undefined;
}
