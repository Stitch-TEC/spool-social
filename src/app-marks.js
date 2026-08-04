// app-marks — the canonical Stitch Suite app marks.
// Kept BYTE-IDENTICAL across every repo's copy, exactly like stitch-apps, and
// deliberately JSX-free so it stays a plain data module.
//
// Each mark is ONE flat, single-colour silhouette on a 0 0 64 64 grid. The
// Stitch TEC crescent appears on every app mark in a place the object already
// had a hole or a detail — a charge on POM's shield, the band at the top of
// Spool's stylus, the exhaust flame under Sender's rocket.
//
// fill-rule="evenodd" is REQUIRED when rendering: without it the crescent
// knockouts fill in solid.
//
// Presentation: paint the mark WHITE on the app's gradient tile. A gradient
// mark on a gradient tile is effectively invisible — this was tested.

export const STITCH_MARK_PATHS = {
  site:   "M13.161 13.286A28 28 0 1 0 50.839 13.286A20 20 0 1 1 13.161 13.286Z",
  pom:    "M24.7 13H39.3A8.5 8.5 0 0 1 47.8 21.5V29C47.8 43.57 41.8 52.5 32 52.5C22.2 52.5 16.2 43.57 16.2 29V21.5A8.5 8.5 0 0 1 24.7 13ZM25.81 20.69A9.2 9.2 0 1 0 38.19 20.69A6.57 6.57 0 1 1 25.81 20.69Z",
  spool:  "M36.105 12.39A4.8 4.8 0 0 1 42.662 10.633L43.008 10.833A4.8 4.8 0 0 1 44.765 17.39L25.854 50.145A1.4 1.4 0 0 1 25.337 50.66L24.573 51.097A1 1 0 0 0 24.569 51.099L23.507 51.713A1 1 0 0 0 23.503 51.716L22.47 52.32A1 1 0 0 0 22.465 52.323L21.461 52.918A1 1 0 0 0 21.456 52.921L20.48 53.506A1 1 0 0 0 20.475 53.509L19.527 54.085A1 1 0 0 0 19.522 54.088L18.602 54.654A1 1 0 0 0 18.597 54.657L17.704 55.215A0.224 0.224 0 0 0 17.703 55.216L17.7 55.218A0.536 0.536 0 0 1 16.878 54.743L16.878 54.743A0.997 0.997 0 0 0 16.878 54.736L16.915 53.686A1 1 0 0 0 16.915 53.68L16.945 52.6A1 1 0 0 0 16.946 52.594L16.97 51.486A1 1 0 0 0 16.97 51.48L16.989 50.342A1 1 0 0 0 16.989 50.336L17.002 49.169A1 1 0 0 0 17.002 49.163L17.009 47.966A1 1 0 0 0 17.009 47.961L17.01 46.735A1 1 0 0 0 17.01 46.73L17.006 45.851A1.4 1.4 0 0 1 17.194 45.145ZM39.52 9.74A5 5 0 1 0 45.35 13.11A3.57 3.57 0 1 1 39.52 9.74Z",
  sender: "M45.38 8.265A1.204 1.204 0 0 1 46.878 9.13L46.882 9.146A0.339 0.339 0 0 1 46.886 9.164L47.118 10.344A1 1 0 0 1 47.127 10.397L47.288 11.544A1 1 0 0 1 47.295 11.6L47.389 12.729A1 1 0 0 1 47.392 12.787L47.42 13.899A1 1 0 0 1 47.42 13.959L47.381 15.056A1 1 0 0 1 47.377 15.117L47.272 16.198A1 1 0 0 1 47.265 16.259L47.094 17.325A1 1 0 0 1 47.082 17.387L46.892 18.231A1.6 1.6 0 0 1 46.717 18.68L35.501 38.105A1.6 1.6 0 0 0 35.299 38.711L34.724 43.415A2.4 2.4 0 0 1 31.141 45.202L29.195 44.078L23.956 41.053L22.01 39.929A2.4 2.4 0 0 1 21.766 35.934L25.552 33.083A1.6 1.6 0 0 0 25.975 32.605L37.19 13.18A1.6 1.6 0 0 1 37.491 12.804L38.128 12.217A1 1 0 0 1 38.175 12.176L39.013 11.495A1 1 0 0 1 39.062 11.457L39.946 10.826A1 1 0 0 1 39.997 10.792L40.927 10.211A1 1 0 0 1 40.979 10.181L41.956 9.648A1 1 0 0 1 42.008 9.622L43.033 9.139A1 1 0 0 1 43.085 9.117L44.158 8.683A1 1 0 0 1 44.209 8.664L45.331 8.28A0.987 0.987 0 0 1 45.38 8.265ZM23.05 56.74A6 6 0 1 0 16.06 52.7A4.29 4.29 0 1 1 23.05 56.74Z",
};

// Per-app tile: each is one slice of the suite's cyan -> blue -> violet ramp.
// The site keeps the near-black badge its raster logo has always used.
export const STITCH_MARK_TILE = {
  site:   "#0b0d12",
  pom:    "linear-gradient(135deg,#22d3ee,#3b82f6)",
  spool:  "linear-gradient(135deg,#7c6cf6,#a855f7)",
  sender: "linear-gradient(135deg,#3b82f6,#6366f1)",
};

// Ink colour for the mark sitting on that tile.
export const STITCH_MARK_INK = {
  site:   "#22d3ee",
  pom:    "#ffffff",
  spool:  "#ffffff",
  sender: "#ffffff",
};
