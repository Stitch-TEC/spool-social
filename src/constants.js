import { MapPin, Linkedin, Twitter, Instagram } from 'lucide-react';

export const PLATFORMS = {
  gmb: { 
    id: 'gmb', 
    name: 'Google Business', 
    color: 'bg-blue-600', 
    text: 'text-blue-600', 
    border: 'border-blue-600',
    icon: MapPin, 
    url: 'https://business.google.com',
    placeholder: 'Share an update, offer, or event...',
    maxChars: 1500
  },
  linkedin: { 
    id: 'linkedin', 
    name: 'LinkedIn', 
    color: 'bg-sky-700', 
    text: 'text-sky-700',
    border: 'border-sky-700',
    icon: Linkedin, 
    url: 'https://www.linkedin.com',
    placeholder: 'Share a professional insight or milestone...',
    maxChars: 3000
  },
  twitter: { 
    id: 'twitter', 
    name: 'X / Twitter', 
    color: 'bg-black', 
    text: 'text-black',
    border: 'border-black',
    icon: Twitter, 
    url: 'https://twitter.com/compose/tweet',
    placeholder: 'What\'s happening?',
    maxChars: 280
  },
  instagram: { 
    id: 'instagram', 
    name: 'Instagram', 
    color: 'bg-pink-600', 
    text: 'text-pink-600',
    border: 'border-pink-600',
    icon: Instagram, 
    url: 'https://www.instagram.com',
    placeholder: 'Write a caption...',
    maxChars: 2200
  }
};

export const STATUS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  POSTED: 'posted',
  ARCHIVED: 'archived'
};

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested'
};

export const SPARK_PROMPTS = [
  "Share a 'behind the scenes' photo of your workspace.",
  "Highlight a recent customer review or success story.",
  "Explain a common misconception in your industry.",
  "Share a tool or resource that saves you time.",
  "Post a throwback to when you first started.",
  "Ask your audience a 'This or That' question.",
  "Introduce yourself or a team member.",
  "Share a mistake you made and what you learned.",
  "Post a quick tip that solves a small problem.",
  "Celebrate a small win or milestone.",
  "Share what you are currently reading or learning.",
  "Answer a Frequently Asked Question (FAQ)."
];

// ⚡ OPTIMIZATION: A stable empty object to prevent unnecessary re-renders
// when a component doesn't have associated client settings.
export const DEFAULT_CLIENT_SETTINGS = Object.freeze({});

// --- AI generation presets ------------------------------------------------

// Platform-specific guidance fed into the model's system instruction so drafts
// match each channel's norms and limits.
export const PLATFORM_AI_GUIDANCE = {
  gmb: 'a Google Business Profile update — local and action-oriented with a clear call to action; avoid hashtags.',
  linkedin: 'a LinkedIn post — professional and insightful, 1–3 short paragraphs; up to ~3 relevant hashtags.',
  twitter: 'an X/Twitter post — punchy and concise; it MUST stay under 280 characters; at most 1–2 hashtags.',
  instagram: 'an Instagram caption — engaging and friendly; a few relevant hashtags grouped at the end.'
};

export const TONE_PRESETS = [
  { id: 'professional', label: 'Professional', instruction: 'professional, precise, and credible — no hype or overclaiming' },
  { id: 'friendly', label: 'Friendly', instruction: 'warm, approachable, and conversational' },
  { id: 'bold', label: 'Bold', instruction: 'bold, confident, and punchy' },
  { id: 'educational', label: 'Educational', instruction: 'clear, informative, and explanatory' }
];

export const LENGTH_PRESETS = [
  { id: 'short', label: 'Short', maxTokens: 160, instruction: 'Keep it brief: 1–2 sentences.' },
  { id: 'medium', label: 'Medium', maxTokens: 400, instruction: 'A medium-length post of a few sentences.' },
  { id: 'long', label: 'Long', maxTokens: 900, instruction: 'A longer, more detailed post with a few short paragraphs.' }
];