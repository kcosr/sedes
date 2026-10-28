import tls from "node:tls";

/** Match desktop certificate trust before Node fetch or ws opens a connection.
 * Keep Node's bundled/extra roots as well as the operating system's trusted CAs.
 * Certificate-chain and hostname verification remain enabled. This sets the
 * current main-process thread's defaults, not an endpoint-specific exception. */
export function enableSystemCertificateTrust() {
  tls.setDefaultCACertificates([
    ...tls.getCACertificates("default"),
    ...tls.getCACertificates("system"),
  ]);
}
