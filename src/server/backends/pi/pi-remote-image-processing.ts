export interface RemotePiProcessedImage {
  readonly ok: boolean;
  readonly data?: string;
  readonly mimeType?: string;
  readonly hints?: readonly string[];
  readonly message?: string;
}

type PiImageProcessor = (
  bytes: Uint8Array,
  mimeType: string,
  options: { readonly autoResizeImages: boolean },
) => Promise<RemotePiProcessedImage>;

let processorPromise: Promise<PiImageProcessor> | undefined;

/**
 * Runs the pinned Pi byte-oriented image pipeline without ever resolving the
 * remote semantic path on the Sedes host.
 */
export async function processRemotePiImage(
  input: { readonly contentBase64: string; readonly mediaType: string },
  options: { readonly autoResizeImages: boolean } = {
    autoResizeImages: true,
  },
  processor?: PiImageProcessor,
): Promise<RemotePiProcessedImage> {
  const bytes = Buffer.from(input.contentBase64, "base64");
  const processImage = processor ?? (await loadPinnedPiImageProcessor());
  return await processImage(bytes, input.mediaType, options);
}

async function loadPinnedPiImageProcessor(): Promise<PiImageProcessor> {
  processorPromise ??= (async () => {
    const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const moduleUrl = new URL("./utils/image-process.js", packageEntry);
    const loaded = (await import(moduleUrl.href)) as {
      readonly processImage?: PiImageProcessor;
    };
    if (typeof loaded.processImage !== "function") {
      throw new Error("pi_image_processor_unavailable");
    }
    return loaded.processImage;
  })();
  return await processorPromise;
}
