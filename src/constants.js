import { MapPin, Facebook, Linkedin, Twitter, Instagram, FileText, Briefcase } from 'lucide-react';
import { PLATFORM_META } from './generation/prompts';

// Display metadata (icons/colors/placeholders) for each platform. The character
// limit + long-form flag are sourced from PLATFORM_META (src/generation/prompts.js)
// — the single source of truth shared with the Worker — so they can never drift.
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
    maxChars: PLATFORM_META.gmb.maxChars
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    color: 'bg-[#1877F2]',
    text: 'text-[#1877F2]',
    border: 'border-[#1877F2]',
    icon: Facebook,
    url: 'https://www.facebook.com',
    placeholder: 'Share an update with your community...',
    maxChars: PLATFORM_META.facebook.maxChars
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
    maxChars: PLATFORM_META.linkedin.maxChars
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
    maxChars: PLATFORM_META.twitter.maxChars
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
    maxChars: PLATFORM_META.instagram.maxChars
  },
  blog: {
    id: 'blog',
    name: 'Blog',
    color: 'bg-emerald-600',
    text: 'text-emerald-600',
    border: 'border-emerald-600',
    icon: FileText,
    url: '',
    placeholder: 'Write your post in Markdown — use # headings, **bold**, lists, and links…',
    maxChars: PLATFORM_META.blog.maxChars,
    longForm: PLATFORM_META.blog.longForm
  },
  job: {
    id: 'job',
    name: 'Job Posting',
    color: 'bg-violet-600',
    text: 'text-violet-600',
    border: 'border-violet-600',
    icon: Briefcase,
    url: '',
    placeholder: 'Write the job posting in Markdown — role, responsibilities, requirements, how to apply…',
    maxChars: PLATFORM_META.job.maxChars,
    longForm: PLATFORM_META.job.longForm
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
// These live in the pure src/generation/prompts.js module (shared with the
// Worker, no lucide/React) and are re-exported here so existing UI imports
// (AIGenerate, etc.) keep working from '../constants' unchanged.
export {
  PLATFORM_AI_GUIDANCE,
  TONE_PRESETS,
  LENGTH_PRESETS,
  IMAGE_STYLE_PRESETS,
  PLATFORM_IMAGE_ASPECT
} from './generation/prompts';