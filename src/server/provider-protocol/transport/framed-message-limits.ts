/**
 * One carrier capacity for every provider protocol frame owned by Sedes.
 * Product-level request sizing must remain beneath this encoded-wire bound.
 */
export const MAXIMUM_PROVIDER_FRAME_BYTES = 128 * 1_024 * 1_024;
