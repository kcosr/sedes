/** Opt out of real Bubblewrap launches only; policy and validation stay active. */
export const realBubblewrapTestsEnabled =
  process.platform === "linux" && process.env.SEDES_SKIP_SANDBOX_TESTS !== "1";
