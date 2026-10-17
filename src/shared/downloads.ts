/** Identity of the immutable resource revision, rather than a file digest. */
export const SEDES_DOWNLOAD_REVISION_HEADER = "X-Sedes-Download-Revision";

export function attachmentContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string,
): string {
  const asciiFallback =
    fileName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_")
      .slice(0, 180) || "attachment";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
