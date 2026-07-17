// Feedback screenshot helpers (v1) — attach one image (paste/drop/file) OR one-click capture the
// current page, always downscaled + JPEG-compressed to a small data URL so a ticket never carries a
// heavy blob. The broker (feedback.stitchtec.dev) stores it in R2 and serves it operator-gated.
//
// The capture library is imported DYNAMICALLY (only when the operator clicks "Capture page") so it
// stays out of the initial bundle — the paste/drop/file path has zero library cost.
//
// We use html2canvas-PRO (a drop-in, API-compatible fork) rather than html2canvas because Spool is
// on Tailwind 4, whose palette emits modern `oklch()` colors. Stock html2canvas throws
// "Attempting to parse an unsupported color function 'oklch'" on those; the pro fork parses
// oklch/oklab/lab/lch/color() natively, so "Capture this page" works on Tailwind-4 surfaces.

const MAX_DIM = 1280;      // longest edge; a feedback screenshot doesn't need retina
const QUALITY = 0.72;      // starting JPEG quality
const TARGET_BYTES = 500_000; // aim under ~500KB (the broker hard-caps ~670KB)

function loadDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = dataUrl;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

// Draw an image element onto a downscaled canvas and return a size-capped JPEG data URL.
function canvasToCappedJpeg(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White matte so a transparent PNG doesn't turn black under JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  let q = QUALITY;
  let url = canvas.toDataURL('image/jpeg', q);
  // base64 is ~1.37x the byte size; shrink quality until under target (floor 0.4).
  while (url.length > TARGET_BYTES * 1.37 && q > 0.4) {
    q -= 0.1;
    url = canvas.toDataURL('image/jpeg', q);
  }
  return url;
}

function scaled(w, h) {
  const s = Math.min(1, MAX_DIM / Math.max(w, h) || 1);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// Accept a File/Blob (paste, drag-drop, file-pick) → a compressed JPEG data URL. Rejects non-images.
export async function imageFileToShot(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('That isn’t an image.');
  const img = await loadDataUrl(await fileToDataUrl(file));
  const { w, h } = scaled(img.naturalWidth || img.width, img.naturalHeight || img.height);
  return canvasToCappedJpeg(img, w, h);
}

// True iff a paste/drop DataTransfer actually carries an IMAGE file — so handlers only intercept
// (preventDefault) real image drops, letting text/link drops fall through to the textarea.
export function dataTransferHasImage(dt) {
  if (!dt) return false;
  if (Array.from(dt.files || []).some((f) => /^image\//.test(f.type))) return true;
  return Array.from(dt.items || []).some((it) => it.kind === 'file' && /^image\//.test(it.type || ''));
}

// Pull the first image off a paste/drop event's items → a compressed shot, or null if none.
export async function shotFromDataTransfer(dt) {
  if (!dt) return null;
  const items = Array.from(dt.files || []);
  const img = items.find((f) => /^image\//.test(f.type))
    || Array.from(dt.items || []).map((it) => (it.kind === 'file' ? it.getAsFile() : null)).find((f) => f && /^image\//.test(f.type));
  return img ? imageFileToShot(img) : null;
}

// One-click capture of the current page (html2canvas, dynamically imported). Returns a compressed
// JPEG data URL. Best-effort: cross-origin images may be blank, but the layout/text captures.
export async function capturePageShot() {
  const { default: html2canvas } = await import('html2canvas-pro');
  const canvas = await html2canvas(document.body, {
    logging: false,
    useCORS: true,
    backgroundColor: '#ffffff',
    // Don't bake the open feedback panel / its launcher into the shot of the page being reported.
    ignoreElements: (el) => typeof el.closest === 'function' && !!el.closest('[data-feedback-widget]'),
    scale: 1,
    windowWidth: document.documentElement.clientWidth,
    windowHeight: document.documentElement.clientHeight,
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });
  const { w, h } = scaled(canvas.width, canvas.height);
  return canvasToCappedJpeg(canvas, w, h);
}
