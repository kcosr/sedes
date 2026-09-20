import { useContext, useEffect, useRef, useState } from "react";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../../app/appearance.js";
import {
  getChatAtmosphereEnabled,
  subscribeChatAtmosphereEnabled,
} from "../../app/settings.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

const SOURCE_SIZE = 400;
const DESKTOP_CHAT_BREAKPOINT = 860;
const DESKTOP_SKETCH_WIDTH = 768;
const SKETCH_OVERSCAN = 1.12;
const POINT_COUNT = 20_000;
const RADIANS_PER_FRAME = Math.PI / 80;
const FRAME_MS = 1000 / 60;
const MAX_DEVICE_PIXEL_RATIO = 2;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Port of @yuruyurau's つぶやきProcessing sketch
 * https://x.com/yuruyurau/status/2091203263811199186
 *
 * Plots 20k points per frame in the original 400×400 space. `i` is both the
 * loop index and a parameter of the curve — do not subsample by striding i.
 */
function paintSketch(
  ctx: CanvasRenderingContext2D,
  t: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  dark: boolean,
): void {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const dpr = Math.min(devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scaleBasis =
    width > DESKTOP_CHAT_BREAKPOINT
      ? DESKTOP_SKETCH_WIDTH
      : Math.max(width, height);
  const scale = (scaleBasis / SOURCE_SIZE) * SKETCH_OVERSCAN;
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-SOURCE_SIZE / 2, -SOURCE_SIZE / 2);
  ctx.fillStyle = dark ? "rgba(255, 255, 255, 0.38)" : "rgba(24, 28, 44, 0.22)";
  const point = 1 / scale;

  for (let i = POINT_COUNT; i--;) {
    const y = i / 663;
    const k = (4 + Math.cos(y)) * Math.cos(i);
    const e = y / 5 - 11;
    const d = Math.hypot(k, e) - 5;
    const c = d / 2.5 - t / 2 + (i % 2) * 8;
    const px = (79 + k * k) * Math.cos(c) + 200;
    const py =
      99 * Math.sin(c / 3) +
      200 +
      d * d * Math.sin(t * 2 - d) +
      3 * Math.sin(k * 2) +
      Math.sin(y / 9 + 6) * k * (e + Math.sin(e * 4 - d * 4));
    ctx.fillRect(px, py, point, point);
  }
}

function ChatAtmosphereCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    let frame = 0;
    let t = 0;
    let last = performance.now();
    let dark = getResolvedAppearance() === "dark";
    let cssWidth = 0;
    let cssHeight = 0;
    let renderedDevicePixelRatio = 0;
    let disposed = false;

    const fit = () => {
      const nextWidth = parent.clientWidth;
      const nextHeight = parent.clientHeight;
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        MAX_DEVICE_PIXEL_RATIO,
      );
      if (
        nextWidth === cssWidth &&
        nextHeight === cssHeight &&
        dpr === renderedDevicePixelRatio
      ) {
        return;
      }
      cssWidth = nextWidth;
      cssHeight = nextHeight;
      renderedDevicePixelRatio = dpr;
      canvas.width = Math.max(1, Math.floor(nextWidth * dpr));
      canvas.height = Math.max(1, Math.floor(nextHeight * dpr));
      canvas.style.width = `${nextWidth}px`;
      canvas.style.height = `${nextHeight}px`;
    };

    const tick = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(tick);
      if (document.visibilityState === "hidden") {
        last = now;
        return;
      }
      const elapsed = Math.min(48, now - last);
      last = now;
      t += RADIANS_PER_FRAME * (elapsed / FRAME_MS);
      fit();
      paintSketch(
        ctx,
        t,
        cssWidth,
        cssHeight,
        Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO),
        dark,
      );
    };

    const unsubscribeAppearance = subscribeResolvedAppearance((appearance) => {
      dark = appearance === "dark";
    });
    const observer = new ResizeObserver(() => fit());
    observer.observe(parent);
    fit();
    frame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribeAppearance();
    };
  }, []);

  return (
    <canvas
      className="chat-atmosphere"
      data-testid="chat-atmosphere"
      aria-hidden="true"
      ref={canvasRef}
    />
  );
}

export function ChatAtmosphere(): React.JSX.Element | null {
  const chatVisible = useContext(ChatViewVisibilityContext);
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [enabled, setEnabled] = useState(getChatAtmosphereEnabled);
  useEffect(() => subscribeChatAtmosphereEnabled(setEnabled), []);
  if (!enabled || !chatVisible || reduceMotion) {
    return null;
  }
  return <ChatAtmosphereCanvas />;
}
