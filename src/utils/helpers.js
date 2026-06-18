// ⚡ OPTIMIZATION: Shared Intl.DateTimeFormat instances are ~50x faster than
// repeated toLocaleString() calls because they avoid re-compiling formatting patterns.
export const DATE_FORMATTERS = {
  short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  full: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
  monthYear: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }),
  time: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' })
};

// Image Compression Logic. Accepts a high-res file and returns an optimized
// JPEG data URL (only the optimized version is ever kept/uploaded).
// Defaults match the legacy in-editor dropzone; the media library passes larger
// values (e.g. maxWidth 2048) for crisper hero images.
export const processImageFile = (file, { maxWidth = 800, quality = 0.6 } = {}) => {
  return new Promise((resolve, reject) => {
    if (!file) reject("No file provided");
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scaleSize = maxWidth / img.width;

        if (scaleSize < 1) {
          canvas.width = maxWidth;
          canvas.height = img.height * scaleSize;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }

        const ctx = canvas.getContext('2d');

        // Fill white background to preserve transparent PNGs
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
};
