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
  POSTED: 'posted'
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