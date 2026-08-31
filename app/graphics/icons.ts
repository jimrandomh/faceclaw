import { GrayImage } from "./image";

declare const com: any;
declare const global: any;

/**
 * Vector icons for window indicators (and anywhere else). SVGs are rendered
 * once to a correctly sized grayscale bitmap by the Java IconRenderer (a
 * small SVG subset: path/circle/rect/line/polyline) and cached here. To add
 * an icon, drop its SVG source into ICON_SVGS — Lucide icons
 * (https://lucide.dev, stroked, 24px viewBox) work as-is; simple single-color
 * Noun Project glyphs also work.
 */

// Stroke width in viewBox units (Lucide's default is 2).
const ICON_STROKE_WIDTH = 2;

// Lucide icons (MIT/ISC licensed). Kept verbatim so they can be diffed
// against upstream if an icon needs updating.
export const ICON_SVGS = {
  "layout-grid":
    '<svg viewBox="0 0 24 24" fill="none"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  timer:
    '<svg viewBox="0 0 24 24" fill="none"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
  calculator:
    '<svg viewBox="0 0 24 24" fill="none"><rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>',
  // Not a Lucide icon: an L-tetromino built from four squares, for Blocks.
  "l-piece":
    '<svg viewBox="0 0 24 24" fill="none"><rect width="6" height="6" x="5" y="1.5" rx="1"/><rect width="6" height="6" x="5" y="9" rx="1"/><rect width="6" height="6" x="5" y="16.5" rx="1"/><rect width="6" height="6" x="12.5" y="16.5" rx="1"/></svg>',
  bomb:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="13" r="9"/><path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"/><path d="m22 2-1.5 1.5"/></svg>',
  // Not a Lucide icon: a ball above two angled flippers, for Pinball.
  pinball:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="6" r="3"/><path d="M4 14l7 5"/><path d="M20 14l-7 5"/><circle cx="4" cy="14" r="1"/><circle cx="20" cy="14" r="1"/></svg>',
  spade:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 18v4"/><path d="M2 14.499a5.5 5.5 0 0 0 9.591 3.675.6.6 0 0 1 .818.001A5.5 5.5 0 0 0 22 14.5c0-2.29-1.5-4-3-5.5l-5.492-5.312a2 2 0 0 0-3-.02L5 8.999c-1.5 1.5-3 3.2-3 5.5"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" fill="none"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>',
  "file-text":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  // The same Lucide folder shape without fill="none", so the renderer fills
  // it: launcher folders use this to read differently from the Files app.
  "folder-filled":
    '<svg viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  film:
    '<svg viewBox="0 0 24 24" fill="none"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M21 7.5h-4"/><path d="M21 16.5h-4"/></svg>',
  type:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/></svg>',
  "hard-drive":
    '<svg viewBox="0 0 24 24" fill="none"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  package:
    '<svg viewBox="0 0 24 24" fill="none"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  activity:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
  bell:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
  "cloud-sun":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v2"/><path d="m4.93 4.93 1.42 1.42"/><path d="M20 12h2"/><path d="m19.07 4.93-1.42 1.42"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
  "flask-conical":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>',
  wrench:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',
  mic:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>',
  map:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>',
  compass:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/></svg>',
  // The Roam Research logo, potrace-traced from the official PNG (no
  // fill="none", so the renderer fills it; hole contours wind opposite).
  roam:
    '<svg viewBox="0 0 24 24"><path d="M11.2 24C11.1 24 10.7 23.9 10.5 23.9C4.5 23.1 0 18.1 0 12C0 4.1 7.4 -1.6 15.1 0.4C18.9 1.4 22.1 4.4 23.4 8.2C25.7 15.3 21.1 22.7 13.7 23.9C13.2 23.9 11.5 24 11.2 24ZM18.9 19.1C19.9 18.2 20.5 17.4 21.1 16.3C21.4 15.7 21.8 14.5 21.7 14.4C21.7 14.4 21.6 14.3 21.4 14.3C21.2 14.3 21.1 14.2 21.1 14.1C21.1 14 21 13.9 21 13.7C20.9 13.4 20.9 13.4 20.6 13.1C20.2 12.9 20.2 12.9 19.7 12.9L19.1 12.9L19.1 12.7L19.1 12.4L16.6 12.4L14 12.4L13.7 12.8C13.5 13.1 12.9 13.6 12.6 13.7C12.5 13.8 12.5 13.8 12.5 14.7L12.5 15.6L12.8 15.8L13 16.1L13 16.4C12.9 17.1 13.1 17.3 14.1 17.1C14.9 17 15.3 17.1 15.3 17.5C15.3 17.7 15 18.1 14.7 18.4C14.4 18.6 14.4 18.7 14.7 18.9C15.1 19.1 15.5 19.1 16.2 18.7C17.1 18.2 17.5 18.2 17.7 18.8C17.8 19 17.8 19.9 17.7 20.1C17.7 20.3 18.3 19.7 18.9 19.1ZM6.2 19.9C6 19.2 6.2 18.6 6.5 18.4C6.9 18.2 7.2 18.3 7.9 18.8C8.3 19.1 8.6 19.1 9.1 18.9C9.3 18.8 9.5 18.7 9.5 18.7C9.5 18.6 9.4 18.5 9.2 18.4C8.8 17.9 8.6 17.4 8.9 17.1C9 17 9 17 9.5 17.1C10.7 17.2 10.8 17.2 10.9 17C11 16.8 11 16.8 10.9 16.4L10.8 16.1L11.1 15.8L11.4 15.5L11.4 14.8C11.4 14.1 11.4 14.1 11.3 14.1C11.2 14.1 9.9 14.9 8.3 15.8C6.7 16.7 5.4 17.4 5.4 17.4C5.3 17.4 5.3 17.3 5.3 17.2C5.3 17.1 5.3 17 5.3 17C5.2 17 3.8 17.6 3.8 17.7C3.7 17.8 4.8 19 5.7 19.7C6 19.9 6.2 20.1 6.2 20.1C6.2 20.1 6.2 20 6.2 19.9ZM6.1 15.6C7.5 14.6 8.6 13.9 8.6 13.9C8.6 13.8 8.4 13.5 8.2 13.1L7.8 12.5L6.4 12.4L4.9 12.4L4.9 12.7L4.9 12.9L4.3 12.9L3.7 12.9L3.3 13.5C2.9 14 2.8 14.1 2.6 14.2L2.3 14.4L2.3 14.6C2.4 15.3 3.3 17.2 3.5 17.2C3.5 17.2 4.6 16.5 6.1 15.6ZM9.7 13.3C9.9 13.1 10.1 13 10.1 13C10.1 13 10.1 12.8 10 12.7L9.9 12.4L9.2 12.4L8.4 12.4L8.5 12.6C8.5 12.7 8.7 12.9 8.8 13.1C9 13.4 9.1 13.6 9.2 13.6C9.2 13.6 9.4 13.4 9.7 13.3ZM10.3 11.1C10.5 10.8 11 10.3 11.3 10.2L11.4 10.1L11.4 7.4L11.4 4.7L11.3 4.7L11.1 4.7L11.1 4.2C11.1 3.2 10.7 2.8 9.8 2.8C9.6 2.8 9.3 2.8 9.2 2.9C9.1 2.9 9 2.9 8.9 2.7C8.8 2.4 8.8 2.4 8.3 2.6C6 3.5 4.1 5.2 3 7.4C2.7 8.1 2.3 9 2.3 9.2C2.3 9.3 2.4 9.4 2.6 9.6C2.9 9.7 3 9.9 3.4 10.4L3.8 10.9L4.3 10.9L4.9 10.9L4.9 11.1L4.9 11.3L7.5 11.3L10.1 11.3L10.3 11.1ZM15.9 11.3C15.9 11.3 15.4 10.5 15.1 10.1L15 9.9L14.4 10.2C14.1 10.4 13.8 10.6 13.8 10.6C13.8 10.7 13.8 10.8 14.1 11.1L14.2 11.3L15.1 11.3C15.5 11.3 15.9 11.3 15.9 11.3ZM19.1 11.1L19.1 10.9L19.7 10.9L20.2 10.9L20.6 10.6C20.9 10.3 21 10.2 21 10C21 9.7 21.1 9.7 21.4 9.5C21.6 9.4 21.7 9.3 21.7 9.3C21.8 9.3 20.9 7.2 20.6 6.8C20.5 6.7 20.4 6.8 18.2 8.1C16.9 8.9 15.8 9.6 15.8 9.6C15.8 9.6 15.9 9.8 16.1 10L16.4 10.4L16.4 10.9L16.4 11.3L17.8 11.3L19.1 11.3L19.1 11.1ZM13.6 9.2L14.4 8.8L14.4 8.6C14.4 8.4 14.4 8.3 14.5 8.2C14.6 8.1 14.7 8.1 14.8 8.3L15 8.5L16.7 7.4C17.6 6.9 18.3 6.4 18.4 6.4C18.4 6.4 18.4 6.5 18.4 6.6C18.4 6.8 18.4 6.9 18.5 6.9C18.6 6.9 20.1 6.3 20.2 6.2C20.3 6.1 19.7 5.4 19 4.7C18.1 3.8 17.1 3.1 15.9 2.7C15 2.3 15 2.3 14.8 2.6L14.7 2.8L14.1 2.8C13.4 2.8 13.2 2.9 13 3.2C12.9 3.4 12.8 3.9 12.8 4.3C12.8 4.6 12.8 4.7 12.6 4.7L12.5 4.7L12.5 7.2L12.5 9.8L12.7 9.7C12.7 9.7 13.2 9.4 13.6 9.2Z"/></svg>',
  nightscout:
    '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="70.29 0 371.43 512"><g fill="#fff"><path d="M245.67.33c-26.83 1.88-48.51 7.53-71.01 18.48-12.93 6.31-23.82 13.24-35.58 22.6-6.52 5.14-22.75 21.43-28 27.95C89.04 97 76.06 127.65 71.22 163.38c-1.12 8.6-1.27 37.06-.25 47.85 3.46 35.53 12.16 69.02 27.33 105.37 18.83 45.25 49.17 93.31 88.52 140.44 12.17 14.56 33.39 37.72 39.76 43.47 15.17 13.54 36.19 15.27 52.94 4.33 4.38-2.85 10.44-8.76 23.62-23.06 31.2-33.75 58.18-69.33 78.8-103.84 25.1-42 40.72-78.7 50.8-119.37 8.91-35.89 11.35-74.52 6.57-103.08-3.16-18.94-7.99-33.7-17-51.92C401.59 61.68 366.77 29.76 323 12.5 300.04 3.49 269.34-1.35 245.67.33m21.99 29.42c12.83.66 31.61 4.94 45.2 10.28 35.99 14.15 65.87 41.64 82.97 76.25 8.76 17.71 13.34 33.24 15.58 52.69.66 5.9.76 10.38.56 22.14-.25 14.81-.51 18.17-2.44 31.82-8.35 58.95-36.6 121.71-83.08 184.27-21.38 28.71-57.93 70.3-65 73.86-3 1.53-7.99 1.58-10.94.2-7.13-3.41-42.56-43.62-64.65-73.3-33.09-44.39-55.79-86.33-70.3-129.81-11.5-34.61-16.59-65.16-15.83-95.9.41-17.36 2.44-29.52 7.53-45.15 18.43-56.71 68.87-98.65 127.77-106.39 7.18-.92 19.6-1.68 24.13-1.43 1.68.12 5.5.32 8.5.47"/><path d="M247.05 58.51c-11.56.97-23.31 3.41-33.49 6.87-6.36 2.19-18.94 8.2-24.89 11.96-13.49 8.4-26.27 20.26-36.35 33.7l-1.43 1.93 3.31-1.27c8.65-3.26 18.73-4.84 30.7-4.84 13.03 0 22.5 1.73 33.7 6.21 6.67 2.65 12.78 6.11 18.78 10.64 5.09 3.87 13.64 12.52 16.44 16.65.97 1.43 1.88 2.6 2.04 2.6s1.17-1.27 2.29-2.85c5.14-7.18 14.86-16.14 22.91-21.02 21.18-12.98 50.34-16.09 74.68-7.94l4.94 1.68-1.58-2.29c-7.33-10.69-22.25-24.48-35.28-32.78-14.86-9.42-32.93-15.93-51.26-18.48-7.04-.97-18.74-1.33-25.51-.77"/><path d="M178.07 133.9c-20.46 2.39-36.04 13.44-44.64 31.66-3.41 7.13-4.89 13.44-5.19 21.99-.71 18.68 4.99 41.39 14.91 59.41 20.46 37.16 57.27 62 98.55 66.53 11.5 1.27 28.56.46 40.37-1.99 22.7-4.63 44.29-15.88 61.39-31.97 6.82-6.41 16.29-17.97 21.18-25.81 15.17-24.38 22.55-57.88 17.26-78.29-1.43-5.65-4.73-12.98-7.99-17.71-3.41-5.04-9.88-11.45-14.91-14.76-5.14-3.41-12.78-6.57-19.14-7.89-5.29-1.17-19.9-1.32-24.69-.31-19.7 4.28-34.61 16.75-41.03 34.31-3.82 10.33-3.67 8.55-3.87 51.57-.15 42.2-.1 41.08-3 42.45-.81.36-5.09.56-11.66.56h-10.44l-1.63-1.48-1.68-1.48-.31-39.4c-.31-42.76-.2-41.44-3.31-50.7-3.56-10.69-11.61-21.23-21.02-27.59-10.9-7.32-25.41-10.68-39.15-9.1m12.22 6.06c10.74 1.22 20.31 5.85 28.61 13.74 6.67 6.36 11 13.54 13.64 22.65 1.02 3.61 1.17 5.14 1.12 12.98 0 8.2-.1 9.26-1.37 13.39-4.17 13.49-12.73 23.82-25.04 30.24-11.05 5.7-23.62 7.02-35.79 3.72-13.69-3.77-25.76-14.15-31.87-27.59-6.11-13.29-5.5-30.29 1.53-43.12 7.94-14.61 21.94-24.08 38.33-26.01 4.88-.56 5.95-.56 10.84 0m141.66 0c23.57 2.7 41.39 20.41 44.13 43.88 2.44 20.72-9.52 41.54-28.86 50.34-13.08 5.9-29.17 5.65-41.74-.66-13.18-6.62-22.55-18.17-26.52-32.73-1.48-5.5-1.37-18.33.2-24.18 1.48-5.4 4.48-11.86 7.43-15.93 2.49-3.56 9.06-10.03 12.62-12.47 6.01-4.12 14.91-7.43 22.04-8.2 5.82-.61 5.66-.61 10.7-.05"/><path d="M180.62 168.47c-11.2 2.39-18.58 13.39-16.39 24.54 3.26 16.59 23.42 22.81 35.33 10.89 10.28-10.33 7.28-27.44-5.96-33.7-4.08-1.89-9.01-2.55-12.98-1.73m141.92.2c-8.4 1.83-14.91 8.81-16.29 17.41-1.02 6.26 1.37 13.29 6.11 17.92 13.69 13.49 36.8 2.9 35.48-16.29a21.05 21.05 0 0 0-17.1-19.24c-3.37-.61-4.64-.61-8.2.2M163.15 318.02c8.4 16.8 18.12 33.55 28.71 49.48 7.18 10.84 9.01 13.29 9.52 12.98 1.37-.87 26.32-39.81 25.81-40.27-.05-.05-3.05-.81-6.72-1.63-19.9-4.58-39.35-13.44-55.89-25.45-2.19-1.63-4.43-3.21-4.99-3.61-.71-.51.41 2.14 3.56 8.5m183.57-4.68c-13.39 9.82-30.9 18.48-46.98 23.11-10.33 2.95-23.47 5.19-35.63 6.01l-5.75.36-3.82 6.82c-8.5 15.22-21.69 35.99-31.05 48.97-2.34 3.26-4.28 6.06-4.28 6.21 0 1.27 23.21 28.4 33.49 39.2l3.26 3.41 3.46-3.67c37.01-39.71 67.55-82.62 88.42-124.31 4.17-8.3 4.89-9.98 4.33-9.93-.21 0-2.65 1.73-5.45 3.82"/></g></svg>',
} as const;

export type IconName = keyof typeof ICON_SVGS;

// The "_" element of the terminal icon, swapped out for a session glyph in
// renderIconWithGlyph.
const TERMINAL_UNDERSCORE = '<path d="M11 13h4"/>';

/**
 * Session-marker glyphs for per-terminal window icons: the terminal icon's
 * "_" replaced by a character, drawn in the same stroked style. Hand-fitted
 * to the box x 11.5–16.5, y 8–16 beside the ">" chevron. The zero is slashed
 * to keep it distinct from the letter O.
 */
const TERMINAL_GLYPH_SHAPES: Record<string, string> = {
  "0": '<ellipse cx="14" cy="12" rx="2.5" ry="4"/><path d="m13 13.6 2-3.2"/>',
  "1": '<path d="m12.5 9.5 1.5-1.5v8"/><path d="M12.5 16h3"/>',
  "2": '<path d="M11.8 9.8a2.3 2.3 0 0 1 4.5.6c0 2.5-4.6 3-4.6 5.6h4.8"/>',
  "3": '<path d="M12 8h2.2a2 2 0 0 1 0 4H13h1.2a2 2 0 0 1 0 4H12"/>',
  "4": '<path d="M15.5 16V8l-4 5.2h5"/>',
  "5": '<path d="M16.2 8h-4.2v3.4h2.2a2.3 2.3 0 0 1 0 4.6H12"/>',
  "6": '<path d="M15.8 8a5.6 5.6 0 0 0-3.8 5.5"/><circle cx="14" cy="13.7" r="2.3"/>',
  "7": '<path d="M11.8 8h4.7l-3.4 8"/>',
  "8": '<circle cx="14" cy="9.9" r="1.9"/><circle cx="14" cy="13.9" r="2.1"/>',
  "9": '<circle cx="14" cy="10.3" r="2.3"/><path d="M12.2 16a5.6 5.6 0 0 0 3.8-5.5"/>',
  A: '<path d="M11.5 16 14 8l2.5 8"/><path d="M12.6 13h2.8"/>',
  B: '<path d="M12 16V8h1.8a2 2 0 0 1 0 4H12h2a2 2 0 0 1 0 4z"/>',
  C: '<path d="M16.4 9.6a3.2 4.3 0 1 0 0 4.8"/>',
  D: '<path d="M12 8h1a3.4 4 0 0 1 0 8h-1z"/>',
  E: '<path d="M16.3 8H12v8h4.3"/><path d="M12 12h3.4"/>',
  F: '<path d="M16.3 8H12v8"/><path d="M12 12h3.4"/>',
  G: '<path d="M16.4 9.6a3.2 4.3 0 1 0 .1 4.9"/><path d="M16.5 14.5V12h-2.3"/>',
  H: '<path d="M12 8v8"/><path d="M16.3 8v8"/><path d="M12 12h4.3"/>',
  I: '<path d="M12.7 8h2.9"/><path d="M14.1 8v8"/><path d="M12.7 16h2.9"/>',
  J: '<path d="M16 8v5.8a2.1 2.1 0 0 1-4.2 0"/>',
  K: '<path d="M12 8v8"/><path d="m16.3 8-4.3 4 4.3 4"/>',
  L: '<path d="M12 8v8h4.3"/>',
  M: '<path d="M11.6 16V8l2.4 4.5L16.4 8v8"/>',
  N: '<path d="M12 16V8l4.3 8V8"/>',
  O: '<ellipse cx="14" cy="12" rx="2.5" ry="4"/>',
  P: '<path d="M12 16V8h2a2.2 2.2 0 0 1 0 4.4h-2"/>',
  Q: '<ellipse cx="14" cy="12" rx="2.5" ry="4"/><path d="m15 13.8 1.6 2.2"/>',
  R: '<path d="M12 16V8h2a2.2 2.2 0 0 1 0 4.4h-2"/><path d="m14.4 12.4 2 3.6"/>',
  S: '<path d="M16.2 9a2.7 2.7 0 0 0-4.3 2c.3 2.3 4.4.7 4.3 3a2.7 2.7 0 0 1-4.4 1.2"/>',
  T: '<path d="M11.7 8h4.6"/><path d="M14 8v8"/>',
  U: '<path d="M12 8v5.8a2.15 2.15 0 0 0 4.3 0V8"/>',
  V: '<path d="m11.6 8 2.4 8 2.4-8"/>',
  W: '<path d="m11.5 8 1 8 1.5-4.6L15.5 16l1-8"/>',
  X: '<path d="m11.8 8 4.4 8"/><path d="m16.2 8-4.4 8"/>',
  Y: '<path d="m11.8 8 2.2 4.2L16.2 8"/><path d="M14 12.2V16"/>',
  Z: '<path d="M11.8 8h4.4l-4.4 8h4.4"/>',
};

/** Characters usable as terminal-icon glyphs, in allocation order (1-9 first, 0 as the tenth). */
export const TERMINAL_ICON_GLYPHS = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const cache = new Map<string, GrayImage | null>();

/** Render an icon SVG to a size×size grayscale bitmap, rendered once and cached. */
export function renderIcon(name: IconName, size: number): GrayImage | null {
  return renderSvgCached(name, ICON_SVGS[name], size);
}

/** Render an app-provided SVG using the same small renderer and cache. */
export function renderSvgIcon(cacheName: string, svg: string, size: number): GrayImage | null {
  return renderSvgCached(`custom:${cacheName}`, svg, size);
}

/**
 * Render an icon with a glyph character substituted in — currently only the
 * terminal icon, whose "_" becomes the glyph (">3" instead of ">_"). Falls
 * back to the plain icon for other names or unsupported characters.
 */
export function renderIconWithGlyph(name: IconName, glyph: string, size: number): GrayImage | null {
  const shape = name === "terminal" ? TERMINAL_GLYPH_SHAPES[glyph] : undefined;
  if (!shape) return renderIcon(name, size);
  return renderSvgCached(`${name}[${glyph}]`, ICON_SVGS.terminal.replace(TERMINAL_UNDERSCORE, shape), size);
}

function renderSvgCached(cacheName: string, svg: string, size: number): GrayImage | null {
  const key = `${cacheName}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let icon: GrayImage | null = null;
  if (global.isAndroid) {
    try {
      const bytes = com.faceclaw.app.IconRenderer.renderSvgGray(svg, Math.round(size), ICON_STROKE_WIDTH);
      if (bytes && bytes.length >= size * size) {
        icon = new GrayImage(size, size, 0);
        for (let i = 0; i < size * size; i++) {
          icon.pixels[i] = bytes[i] & 0xff;
        }
      }
    } catch (error) {
      console.warn(`renderIcon(${cacheName}) failed: ${error}`);
    }
  }
  cache.set(key, icon);
  return icon;
}
