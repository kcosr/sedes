import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconSvg = await readFile(
  path.join(repositoryRoot, "assets/branding/sedes-icon.svg"),
  "utf8",
);
const glyphSvg = await readFile(
  path.join(repositoryRoot, "assets/branding/sedes-glyph.svg"),
  "utf8",
);
const iconDataUrl = svgDataUrl(iconSvg);
const glyphDataUrl = svgDataUrl(glyphSvg);
const androidAdaptiveForegroundScale = 0.68;
const androidAdaptiveLayerToMaskScale = 1.5;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  deviceScaleFactor: 1,
  viewport: { height: 512, width: 512 },
});
const page = await context.newPage();

try {
  await renderImage({
    dataUrl: iconDataUrl,
    height: 192,
    output: "public/favicon.png",
    width: 192,
  });
  await renderImage({
    dataUrl: iconDataUrl,
    height: 192,
    output: "public/sedes-mark.png",
    width: 192,
  });
  await renderImage({
    dataUrl: iconDataUrl,
    height: 1024,
    output: "electron/assets/icon.png",
    width: 1024,
  });

  const launcherDensities = [
    { directory: "mipmap-mdpi", foreground: 108, legacy: 48 },
    { directory: "mipmap-hdpi", foreground: 162, legacy: 72 },
    { directory: "mipmap-xhdpi", foreground: 216, legacy: 96 },
    { directory: "mipmap-xxhdpi", foreground: 324, legacy: 144 },
    { directory: "mipmap-xxxhdpi", foreground: 432, legacy: 192 },
  ];

  for (const density of launcherDensities) {
    const resourceDirectory = `android/app/src/main/res/${density.directory}`;
    await renderImage({
      dataUrl: iconDataUrl,
      height: density.legacy,
      output: `${resourceDirectory}/ic_launcher.png`,
      width: density.legacy,
    });
    await renderRoundLauncher({
      output: `${resourceDirectory}/ic_launcher_round.png`,
      size: density.legacy,
    });
    await renderImage({
      dataUrl: glyphDataUrl,
      height: density.foreground,
      imageScale: androidAdaptiveForegroundScale,
      output: `${resourceDirectory}/ic_launcher_foreground.png`,
      width: density.foreground,
    });
  }

  const splashDensities = [
    { directory: "mdpi", height: 320, icon: 80, width: 480 },
    { directory: "hdpi", height: 480, icon: 120, width: 800 },
    { directory: "xhdpi", height: 720, icon: 160, width: 1280 },
    { directory: "xxhdpi", height: 960, icon: 240, width: 1600 },
    { directory: "xxxhdpi", height: 1280, icon: 320, width: 1920 },
  ];

  for (const density of splashDensities) {
    await renderImage({
      background: "#111419",
      dataUrl: glyphDataUrl,
      height: density.height,
      imageHeight: density.icon,
      imageWidth: density.icon,
      output: `android/app/src/main/res/drawable-land-${density.directory}/splash.png`,
      width: density.width,
    });
    await renderImage({
      background: "#111419",
      dataUrl: glyphDataUrl,
      height: density.width,
      imageHeight: density.icon,
      imageWidth: density.icon,
      output: `android/app/src/main/res/drawable-port-${density.directory}/splash.png`,
      width: density.height,
    });
  }

  await renderImage({
    background: "#111419",
    dataUrl: glyphDataUrl,
    height: 320,
    imageHeight: 80,
    imageWidth: 80,
    output: "android/app/src/main/res/drawable/splash.png",
    width: 480,
  });

  await verifyGeometry();
} finally {
  await browser.close();
}

async function verifyGeometry() {
  const iconBounds = await inspectRenderedBounds({
    dataUrl: iconDataUrl,
    mode: "light",
  });
  const iconTopGap = iconBounds.top - 16;
  const iconBottomGap = 495 - iconBounds.bottom;
  if (Math.abs(iconTopGap - iconBottomGap) > 2) {
    throw new Error(
      `Sedes mark is not vertically centered: top gap ${iconTopGap}px, bottom gap ${iconBottomGap}px`,
    );
  }

  const foregroundBounds = await inspectRenderedBounds({
    dataUrl: glyphDataUrl,
    imageScale: androidAdaptiveForegroundScale,
    mode: "alpha",
  });
  const androidSafeZoneRadius = (512 * 33) / 108;
  if (foregroundBounds.maximumRadius > androidSafeZoneRadius) {
    throw new Error(
      `Android foreground exceeds its circular safe zone: ${foregroundBounds.maximumRadius.toFixed(2)}px > ${androidSafeZoneRadius.toFixed(2)}px`,
    );
  }
}

async function inspectRenderedBounds({ dataUrl, imageScale = 1, mode }) {
  return page.evaluate(
    async ({ dataUrl: source, imageScale: scale, mode: pixelMode }) => {
      const image = new Image();
      image.src = source;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.height = 512;
      canvas.width = 512;
      const renderingContext = canvas.getContext("2d", { willReadFrequently: true });
      if (!renderingContext) throw new Error("Could not create branding verification canvas");
      const renderedSize = 512 * scale;
      const renderedOffset = (512 - renderedSize) / 2;
      renderingContext.drawImage(
        image,
        renderedOffset,
        renderedOffset,
        renderedSize,
        renderedSize,
      );

      const pixels = renderingContext.getImageData(0, 0, 512, 512).data;
      let bottom = -1;
      let left = 512;
      let maximumRadius = 0;
      let right = -1;
      let top = 512;
      for (let y = 0; y < 512; y += 1) {
        for (let x = 0; x < 512; x += 1) {
          const offset = (y * 512 + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const alpha = pixels[offset + 3];
          const selected =
            pixelMode === "alpha"
              ? alpha > 16
              : alpha > 16 && red > 220 && green > 220 && blue > 220;
          if (!selected) continue;
          bottom = Math.max(bottom, y);
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          maximumRadius = Math.max(maximumRadius, Math.hypot(x - 255.5, y - 255.5));
        }
      }
      if (bottom < 0) throw new Error("Branding verification found no selected pixels");
      return { bottom, left, maximumRadius, right, top };
    },
    { dataUrl, imageScale, mode },
  );
}

async function renderImage({
  background,
  dataUrl,
  height,
  imageHeight = height,
  imageScale = 1,
  width,
  imageWidth = width,
  output,
}) {
  await page.setViewportSize({ height, width });
  await page.setContent(`
    <style>
      html, body {
        align-items: center;
        background: ${background ?? "transparent"};
        display: flex;
        height: 100%;
        justify-content: center;
        margin: 0;
        overflow: hidden;
        width: 100%;
      }
      img {
        display: block;
        height: ${imageHeight * imageScale}px;
        width: ${imageWidth * imageScale}px;
      }
    </style>
    <img alt="" src="${dataUrl}">
  `);
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({
    omitBackground: background === undefined,
    path: path.join(repositoryRoot, output),
  });
}

async function renderRoundLauncher({ output, size }) {
  await page.setViewportSize({ height: size, width: size });
  await page.setContent(`
    <style>
      html, body {
        height: 100%;
        margin: 0;
        overflow: hidden;
        width: 100%;
      }
      .icon {
        align-items: center;
        background: radial-gradient(circle at 50% 42%, #1d2128 0%, #171a20 62%, #111419 100%);
        border-radius: 50%;
        display: flex;
        height: 100%;
        justify-content: center;
        overflow: hidden;
        width: 100%;
      }
      img {
        display: block;
        height: ${androidAdaptiveForegroundScale * androidAdaptiveLayerToMaskScale * 100}%;
        width: ${androidAdaptiveForegroundScale * androidAdaptiveLayerToMaskScale * 100}%;
      }
    </style>
    <div class="icon"><img alt="" src="${glyphDataUrl}"></div>
  `);
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({
    omitBackground: true,
    path: path.join(repositoryRoot, output),
  });
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
