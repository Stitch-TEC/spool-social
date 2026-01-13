import { PLATFORMS } from '../constants';

export const resolveImage = (imgRef, mediaMap) => {
    if (!imgRef) return null;
    return imgRef.startsWith('data:') ? imgRef : mediaMap[imgRef] || null;
};

// ✅ RESTORED: Image Compression Logic
export const processImageFile = (file) => {
  return new Promise((resolve, reject) => {
    if (!file) reject("No file provided");
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800; 
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // Compress to JPEG at 60% quality
        resolve(canvas.toDataURL('image/jpeg', 0.6)); 
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
};

export const TRANSFORMATIONS = {
  punchy: (text) => {
    const suffix = "\n\n👇\n#Growth #Building";
    if (text.includes("#Growth #Building")) return text; 
    let clean = text.replace(/\b(I think|I believe|Just wanted to say|basically|actually)\b/gi, '').replace(/\s+/g, ' ').trim();
    return `${clean}${suffix}`;
  },
  professional: (text) => {
    const prefix = "💡 Professional Update:\n\n";
    const suffix = "\n\nI'd love to hear your perspective on this in the comments below.\n\n#Leadership #IndustryTrends";
    if (text.startsWith("💡 Professional Update")) return text;
    return `${prefix}${text}${suffix}`;
  },
  emojify: (text) => {
    const map = { 'launch': '🚀', 'growth': '📈', 'money': '💰', 'team': '👥', 'idea': '💡', 'love': '❤️', 'happy': '😊', 'work': '💼' };
    let newText = text;
    Object.keys(map).forEach(key => {
      const emoji = map[key];
      const regex = new RegExp(`\\b${key}\\b(?!\\s*${emoji})`, 'gi'); 
      newText = newText.replace(regex, `${key} ${emoji}`);
    });
    return newText;
  }
};