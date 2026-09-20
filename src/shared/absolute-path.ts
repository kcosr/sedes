export function normalizedAbsolutePath(value: string): boolean {
  if (/\p{Cc}/u.test(value)) return false;
  if (value.startsWith("/") && !value.includes("\\")) {
    return (
      value === "/" ||
      value
        .slice(1)
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        )
    );
  }
  // Native Windows absolute paths, never drive-relative paths or device
  // namespaces. Reject ambiguous Win32 names and alternate data streams.
  const drive = /^[a-z]:\\/iu.test(value);
  const unc = value.startsWith("\\\\");
  if ((!drive && !unc) || value.includes("/")) return false;
  const remainder = value.slice(drive ? 3 : 2);
  if (drive && remainder === "") return true;
  const segments = remainder.split("\\");
  // A UNC share root has the native canonical trailing separator. Child
  // paths, like drive-relative children, cannot end in a separator.
  if (unc && segments.length === 2) return false;
  if (unc && segments.length === 3 && segments[2] === "") segments.pop();
  return (
    (!unc || segments.length >= 2) &&
    segments.every(
      (segment) =>
        segment !== "" &&
        !/[<>:"|?*\u0000-\u001f]/u.test(segment) &&
        !/[. ]$/u.test(segment) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  );
}
