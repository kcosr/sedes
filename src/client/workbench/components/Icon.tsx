import type { ReactNode } from "react";
import { cx } from "../lib/cx";

const circle = <circle cx="8" cy="8" r="6.25" />;
const dot = (x: number, y: number) => (
  <circle cx={x} cy={y} r="1" fill="currentColor" stroke="none" />
);

/**
 * 16px stroke icons (currentColor, 1.5 stroke, round caps): a core set
 * (pull request and issue states, commit, branch, tag, star, pin, chevrons…)
 * plus generic app icons. Size them with CSS (`.wb-icon`) or the `size` prop.
 */
const PATHS = {
  // ---- core set
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="8.5" r="1.75" />
      <path d="M4.5 5.25v5.5M4.5 5.5c0 2.2 1.8 3 5.25 3" />
    </>
  ),
  "pr-open": (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3L7.5 4.5 9 6" />
    </>
  ),
  "pr-draft": (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 3.5v.5M11.5 6.25v.5M11.5 9v.5" />
    </>
  ),
  "pr-closed": (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 8.25v2.5M9.75 2.75l3.5 3.5M13.25 2.75l-3.5 3.5" />
    </>
  ),
  issue: (
    <>
      {circle}
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.5 8h4M10.5 8h4" />
    </>
  ),
  fork: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="11.5" cy="3.5" r="1.75" />
      <circle cx="8" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v.75a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-.75M8 8v2.75" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="3.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 5.25v.5a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 0-2.5 2.5" />
    </>
  ),
  tag: (
    <>
      <path d="M2.25 2.25h5.1l6.4 6.4-5.1 5.1-6.4-6.4z" />
      <circle cx="5.25" cy="5.25" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  star: (
    <path d="M8 1.75l1.93 3.9 4.3.63-3.11 3.03.73 4.28L8 11.57l-3.85 2.02.73-4.28L1.77 6.28l4.3-.63z" />
  ),
  "star-fill": (
    <path
      d="M8 1.75l1.93 3.9 4.3.63-3.11 3.03.73 4.28L8 11.57l-3.85 2.02.73-4.28L1.77 6.28l4.3-.63z"
      fill="currentColor"
    />
  ),
  lock: (
    <>
      <rect x="3.25" y="7" width="9.5" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.5 8a5.5 5.5 0 0 1-9.9 3.3M2.5 8a5.5 5.5 0 0 1 9.9-3.3" />
      <path d="M12.75 1.75v3h-3M3.25 14.25v-3h3" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </>
  ),
  moon: <path d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z" />,
  external: (
    <path d="M9.5 2.5h4v4M13.5 2.5L8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  ),
  pin: (
    <>
      <path d="M10.2 1.8l4 4-1.6.6-2.8 2.8.2 3-1.3 1.3-6.2-6.2L3.8 6l3 .2 2.8-2.8z" />
      <path d="M5 11l-3.25 3.25" />
    </>
  ),
  "chevron-down": <path d="M4.5 6.25L8 9.75l3.5-3.5" />,
  "chevron-up": <path d="M4.5 9.75L8 6.25l3.5 3.5" />,
  "chevron-right": <path d="M6.25 4.5L9.75 8l-3.5 3.5" />,
  "chevron-left": <path d="M9.75 4.5L6.25 8l3.5 3.5" />,
  "chevrons-up-down": <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  braces: (
    <path d="M5.5 2.5c-1.4 0-2 .6-2 2v1.4c0 1-.5 1.7-1.5 2.1 1 .4 1.5 1.1 1.5 2.1v1.4c0 1.4.6 2 2 2M10.5 2.5c1.4 0 2 .6 2 2v1.4c0 1 .5 1.7 1.5 2.1-1 .4-1.5 1.1-1.5 2.1v1.4c0 1.4-.6 2-2 2" />
  ),
  markdown: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M4 10.25v-4.5l1.75 2 1.75-2v4.5M10.75 5.75v4.5M9.25 8.75l1.5 1.5 1.5-1.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.25 1.5v3M10.75 1.5v3" />
    </>
  ),
  sliders: (
    <>
      <path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2M7 11.5h7" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="5.5" cy="11.5" r="1.5" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  grid: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  layers: (
    <>
      <path d="M8 2l6 3-6 3-6-3z" />
      <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  bookmark: <path d="M4 2.5h8v11l-4-2.75-4 2.75z" />,
  pulse: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  book: (
    <path d="M3 13.25V3.5a1 1 0 0 1 1-1h8.5V12H4.25A1.25 1.25 0 0 0 3 13.25zm0 0a1.25 1.25 0 0 0 1.25 1.25h8.25V12" />
  ),
  chart: <path d="M2 14h12M4.5 11V7.5M8 11V3.5M11.5 11V9" />,
  enter: <path d="M13 3v5a2 2 0 0 1-2 2H3M6 7l-3 3 3 3" />,
  more: (
    <>
      {dot(3.5, 8)}
      {dot(8, 8)}
      {dot(12.5, 8)}
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8c.9-3 3.5-5 6.5-5s5.6 2 6.5 5c-.9 3-3.5 5-6.5 5s-5.6-2-6.5-5z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  "eye-off": (
    <path d="M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.3C2.8 5.2 1.9 6.5 1.5 8c.9 3 3.5 5 6.5 5 1.3 0 2.5-.4 3.6-1M7 3.1c.3 0 .7-.1 1-.1 3 0 5.6 2 6.5 5-.3.9-.7 1.7-1.3 2.4" />
  ),
  key: (
    <>
      <circle cx="5" cy="11" r="2.75" />
      <path d="M7 9l6.5-6.5M11 5l1.75 1.75M9.5 6.5l1.5 1.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  trash: (
    <path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6" />
  ),
  alert: (
    <>
      <path d="M8 2l6.5 11.5h-13z" />
      <path d="M8 6.5v3M8 11.5h.01" />
    </>
  ),
  "file-text": (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5M6 8.5h4.5M6 11h4.5" />
    </>
  ),
  diff: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5M8.25 6.5v3.5M6.5 8.25h3.5M6.5 12h3.5" />
    </>
  ),
  comment: (
    <path d="M3.5 2.75h9a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-1.25 1.25H7.25L4.5 13.5v-2.25h-1A1.25 1.25 0 0 1 2.25 10V4A1.25 1.25 0 0 1 3.5 2.75z" />
  ),

  // ---- generic app icons
  gear: (
    <>
      <path d="M12.53 6.12L12.77 6.9L14.54 7.08L14.54 8.92L12.77 9.1L12.53 9.88L12.16 10.6L13.27 11.97L11.97 13.27L10.6 12.16L9.88 12.53L9.1 12.77L8.92 14.54L7.08 14.54L6.9 12.77L6.12 12.53L5.4 12.16L4.03 13.27L2.73 11.97L3.84 10.6L3.47 9.88L3.23 9.1L1.46 8.92L1.46 7.08L3.23 6.9L3.47 6.12L3.84 5.4L2.73 4.03L4.03 2.73L5.4 3.84L6.12 3.47L6.9 3.23L7.08 1.46L8.92 1.46L9.1 3.23L9.88 3.47L10.6 3.84L11.97 2.73L13.27 4.03L12.16 5.4z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14c.6-2.9 2.7-4.5 5.25-4.5s4.65 1.6 5.25 4.5" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="5.75" r="2.5" />
      <path d="M1.5 13.75c.5-2.5 2.2-3.9 4.5-3.9s4 1.4 4.5 3.9M10.25 3.35a2.4 2.4 0 0 1 0 4.8M11.75 9.95c1.45.45 2.35 1.65 2.75 3.8" />
    </>
  ),
  shield: (
    <path d="M8 1.75l5.25 2v4.1c0 3.2-2.2 5.4-5.25 6.4-3.05-1-5.25-3.2-5.25-6.4v-4.1z" />
  ),
  "shield-check": (
    <>
      <path d="M8 1.75l5.25 2v4.1c0 3.2-2.2 5.4-5.25 6.4-3.05-1-5.25-3.2-5.25-6.4v-4.1z" />
      <path d="M5.75 8.1l1.5 1.5 3-3.1" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.25" y="7" width="9.5" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.85-.85" />
    </>
  ),
  minus: <path d="M3 8h10" />,
  pencil: (
    <path d="M11.25 2.25l2.5 2.5-8.5 8.5-3.25.75.75-3.25zM9.75 3.75l2.5 2.5" />
  ),
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M5 3.25v9.5l7.5-4.75z" />,
  filter: <path d="M2 3h12l-4.75 5.5v4.75L6.75 14.5V8.5z" />,
  monitor: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 14h5M8 11v3" />
    </>
  ),
  "log-out": (
    <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6" />
  ),
  clock: (
    <>
      {circle}
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  "alert-circle": (
    <>
      {circle}
      <path d="M8 4.75v3.75M8 11h.01" />
    </>
  ),
  info: (
    <>
      {circle}
      <path d="M8 7.25v4M8 4.9h.01" />
    </>
  ),
  help: (
    <>
      {circle}
      <path d="M6.25 6.25a1.85 1.85 0 0 1 3.6.6c0 1.25-1.85 1.65-1.85 2.65M8 11.5h.01" />
    </>
  ),
  "circle-check": (
    <>
      {circle}
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>
  ),
  "circle-x": (
    <>
      {circle}
      <path d="M6 6l4 4M10 6l-4 4" />
    </>
  ),
  ban: (
    <>
      {circle}
      <path d="M3.6 3.6l8.8 8.8" />
    </>
  ),
  grip: (
    <>
      {dot(6, 4)}
      {dot(10, 4)}
      {dot(6, 8)}
      {dot(10, 8)}
      {dot(6, 12)}
      {dot(10, 12)}
    </>
  ),
  "arrow-up": <path d="M8 13V3M4 7l4-4 4 4" />,
  "arrow-down": <path d="M8 3v10M4 9l4 4 4-4" />,
  "arrow-left": <path d="M13 8H3M7 4L3 8l4 4" />,
  "arrow-right": <path d="M3 8h10M9 4l4 4-4 4" />,
  "arrows-up-down": (
    <path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" />
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.75" rx="5.25" ry="1.75" />
      <path d="M2.75 3.75v8.5c0 1 2.35 1.75 5.25 1.75s5.25-.75 5.25-1.75v-8.5M2.75 8c0 1 2.35 1.75 5.25 1.75S13.25 9 13.25 8" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="2.25" width="12" height="5" rx="1.25" />
      <rect x="2" y="8.75" width="12" height="5" rx="1.25" />
      <path d="M4.75 4.75h.01M4.75 11.25h.01" />
    </>
  ),
  activity: <path d="M1.5 8h2.75l1.75-4.5 4 9 1.75-4.5h2.75" />,
  "trending-up": (
    <path d="M1.75 11.75l4-4 2.75 2.75 5.75-5.75M10 4.75h4.25V9" />
  ),
  file: (
    <>
      <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
      <path d="M9 1.75V5.25h3.5" />
    </>
  ),
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />,
  sidebar: (
    <>
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  command: (
    <path d="M6 6h4v4H6zM6 6V4.25A1.75 1.75 0 1 0 4.25 6H6M10 6V4.25A1.75 1.75 0 1 1 11.75 6H10M6 10v1.75A1.75 1.75 0 1 1 4.25 10H6M10 10v1.75A1.75 1.75 0 1 0 11.75 10H10" />
  ),
  home: <path d="M2.5 7.5L8 2.75l5.5 4.75M4 6.5v7h8v-7" />,
  link: (
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.25-2.25a2.5 2.5 0 0 0-3.5-3.5L8 4.5M9.25 6.75a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5L8 11.5" />
  ),
  download: <path d="M8 2.5v8M4.75 7.25L8 10.5l3.25-3.25M2.5 13.5h11" />,
  upload: <path d="M8 10.5v-8M4.75 5.75L8 2.5l3.25 3.25M2.5 13.5h11" />,
  globe: (
    <>
      {circle}
      <path d="M1.75 8h12.5M8 1.75c1.75 1.75 2.5 3.9 2.5 6.25S9.75 12.5 8 14.25C6.25 12.5 5.5 10.35 5.5 8S6.25 3.5 8 1.75z" />
    </>
  ),
  zap: <path d="M9 1.75L3.25 9h4.25L7 14.25 12.75 7H8.5z" />,
  bell: <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.25H3zM6.5 14.25h3" />,
  history: (
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.25 2.5v2.25h2.25M8 5v3l2 1.25" />
  ),
  flask: (
    <path d="M6 1.75v4.5L2.75 12.5a1.25 1.25 0 0 0 1.1 1.75h8.3a1.25 1.25 0 0 0 1.1-1.75L10 6.25v-4.5M5 1.75h6M4.25 9.75h7.5" />
  ),
  inbox: (
    <path d="M1.75 8.5l1.75-5.5h9l1.75 5.5v4.25a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1zM1.75 8.5h3.5l1 1.75h3.5l1-1.75h3.5" />
  ),
  package: (
    <path d="M8 1.75l5.75 3v6.5L8 14.25l-5.75-3v-6.5zM2.25 4.75L8 7.75l5.75-3M8 7.75v6.5" />
  ),
  table: (
    <path d="M2.75 2.25h10.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1zM1.75 6h12.5M1.75 9.75h12.5M6 6v7.75" />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** Every icon name, for pickers and the gallery. */
export const iconNames = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  className?: string | undefined;
  /** Accessible name; without it the icon is decorative (aria-hidden). */
  title?: string | undefined;
  /** Rendered size in px (default 16; CSS usually sets it per context). */
  size?: number | undefined;
}

export function Icon({ name, className, title, size = 16 }: IconProps) {
  return (
    <svg
      className={cx("wb-icon", className)}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
