import React, { useState, useEffect, useMemo, useRef, Component } from 'react';
import { 
  Plus, 
  Calendar as CalendarIcon, 
  CheckCircle, 
  Copy, 
  ExternalLink, 
  Trash2, 
  Edit3, 
  MapPin, 
  Linkedin, 
  Twitter, 
  Instagram, 
  Layout, 
  Clock,
  Save,
  X,
  Menu,
  Search,
  CopyPlus,
  UploadCloud,
  Link as LinkIcon,
  AlertCircle,
  Hash,
  Grid,
  List,
  ChevronLeft,
  ChevronRight,
  Share2,
  Eye,
  Smartphone,
  Zap,
  RefreshCw,
  MoreHorizontal,
  Heart,
  MessageCircle,
  Repeat,
  Send,
  ThumbsUp,
  Layers,
  Tag,
  BarChart2,
  Loader2,
  AlertTriangle,
  Wand2,
  Sparkles,
  Scroll,
  LogOut,
  Briefcase,
  Download,
  ArrowRight,
  ThumbsDown,
  MessageSquare,
  Check
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup,
  signInAnonymously,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  onSnapshot, 
  serverTimestamp,
  getDoc,
  setDoc,
  writeBatch
} from 'firebase/firestore';

// --- Error Boundary ---
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Spool Crash:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-rose-100">
            <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-xl flex items-center justify-center mb-4 mx-auto">
              <AlertTriangle size={24} />
            </div>
            <h2 className="text-xl font-bold text-slate-800 text-center mb-2">Something went wrong</h2>
            <p className="text-slate-500 text-sm text-center mb-4">The application encountered an unexpected error.</p>
            <div className="bg-slate-100 p-3 rounded-lg text-xs font-mono text-slate-600 overflow-auto max-h-40 mb-6">
              {this.state.error && this.state.error.toString()}
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 transition-colors"
            >
              Reload Spool
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Firebase Configuration ---
// UPDATED: Now uses secure environment variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

// Validate Config
if (!firebaseConfig.apiKey) {
  console.error("CRITICAL: Missing Firebase API Key in .env file");
}

// Initialize Firebase safely
let app, auth, db, googleProvider;
try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  googleProvider = new GoogleAuthProvider();
} catch (e) {
  console.error("Firebase Init Error:", e);
}

const appId = 'spool-app';

// --- Constants ---
const PLATFORMS = {
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

const STATUS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  POSTED: 'posted'
};

const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested'
};

const SPARK_PROMPTS = [
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

// --- Optimized Image Processor ---
// FIX: Compresses images to ensure they fit in Firestore (Limit: 1MB)
const processImageFile = (file) => {
  return new Promise((resolve, reject) => {
    if (!file) reject("No file provided");
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        // Max dimension 800px is perfect for social preview, saves huge space
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

// --- Mock AI Logic (Duplicate Prevention) ---
const TRANSFORMATIONS = {
  punchy: (text) => {
    const suffix = "\n\n👇\n#Growth #Building";
    if (text.includes("#Growth #Building")) return text; // Already applied
    
    let clean = text
      .replace(/\b(I think|I believe|Just wanted to say|basically|actually)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `${clean}${suffix}`;
  },
  professional: (text) => {
    const prefix = "💡 Professional Update:\n\n";
    const suffix = "\n\nI'd love to hear your perspective on this in the comments below.\n\n#Leadership #IndustryTrends #CareerGrowth";
    
    if (text.includes("💡 Professional Update")) return text; // Already applied

    return `${prefix}${text}${suffix}`;
  },
  emojify: (text) => {
    const map = {
      'launch': '🚀', 'growth': '📈', 'money': '💰', 'team': '👥', 
      'idea': '💡', 'love': '❤️', 'happy': '😊', 'work': '💼',
      'coffee': '☕', 'time': '⏰', 'question': '❓', 'goal': '🎯',
      'stitch': '🧵', 'spool': '🧵', 'tech': '💻'
    };
    let newText = text;
    Object.keys(map).forEach(key => {
      const emoji = map[key];
      // Regex checks if word exists AND isn't already followed by the emoji
      const regex = new RegExp(`\\b${key}\\b(?!\\s*${emoji})`, 'gi'); 
      newText = newText.replace(regex, `${key} ${emoji}`);
    });
    return newText;
  }
};

// --- Components ---

const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-6 right-6 px-6 py-3 rounded-lg shadow-lg text-white transform transition-all duration-300 flex items-center gap-2 z-[60] ${
      type === 'success' ? 'bg-indigo-900' : 'bg-rose-900'
    }`}>
      {type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
      <span className="font-medium">{message}</span>
    </div>
  );
};

const PlatformIcon = ({ platformId, size = 18, className = "" }) => {
  const platform = PLATFORMS[platformId] || PLATFORMS.gmb;
  const Icon = platform.icon || AlertCircle; 
  return (
    <div className={`flex items-center justify-center rounded-full text-white ${platform.color} ${className}`} style={{ width: size, height: size }}>
      <Icon size={size * 0.6} />
    </div>
  );
};

const CharCountCircle = ({ current, max }) => {
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const percentage = Math.min(100, (current / max) * 100);
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  
  let color = 'stroke-indigo-500';
  if (percentage > 80) color = 'stroke-amber-500';
  if (percentage > 95) color = 'stroke-rose-500';

  return (
    <div className="relative w-8 h-8 flex items-center justify-center">
      <svg className="transform -rotate-90 w-full h-full">
        <circle className="text-slate-200" strokeWidth="3" stroke="currentColor" fill="transparent" r={radius} cx="16" cy="16" />
        <circle className={`${color} transition-all duration-300`} strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={strokeDashoffset} strokeLinecap="round" stroke="currentColor" fill="transparent" r={radius} cx="16" cy="16" />
      </svg>
      {percentage > 100 && (
         <div className="absolute inset-0 flex items-center justify-center"><span className="text-[10px] font-bold text-rose-600">!</span></div>
      )}
    </div>
  );
};

// --- Modals ---

const ConfirmModal = ({ title, message, onConfirm, onCancel, type = 'action' }) => (
  <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 animate-in fade-in zoom-in duration-200">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 mx-auto ${type === 'danger' ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-600'}`}>
         {type === 'danger' ? <AlertTriangle size={24} /> : <Layers size={24} />}
      </div>
      <h3 className="text-lg font-bold text-slate-800 mb-2 text-center">{title}</h3>
      <p className="text-slate-600 text-sm mb-6 text-center">{message}</p>
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-xl hover:bg-slate-200 transition-colors">Cancel</button>
        <button onClick={onConfirm} className={`flex-1 py-2.5 text-white font-medium rounded-xl transition-colors ${type === 'danger' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
          {type === 'danger' ? 'Delete' : 'Confirm'}
        </button>
      </div>
    </div>
  </div>
);

const ReviewModal = ({ post, onApprove, onRequestChanges, onClose }) => {
  const [feedback, setFeedback] = useState('');
  const [activeTags, setActiveTags] = useState([]);
  const [mode, setMode] = useState('view'); // 'view' or 'reject'

  const feedbackTags = ["Fix Text", "Change Image", "Wrong Link", "Tone Issue"];

  const toggleTag = (tag) => {
    setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSubmitRejection = () => {
    const finalFeedback = `${activeTags.join(', ')}${activeTags.length > 0 && feedback ? ' - ' : ''}${feedback}`;
    onRequestChanges(finalFeedback || "Changes requested");
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col md:flex-row overflow-hidden animate-in fade-in zoom-in duration-200">
        
        {/* Left: Mobile Preview (Clean, no double frame) */}
        <div className="flex-1 bg-slate-100 p-8 flex items-center justify-center border-r border-slate-200">
             <MobilePreview post={post} />
        </div>

        {/* Right: Controls */}
        <div className="flex-1 flex flex-col bg-white">
          <div className="p-6 border-b border-slate-100 flex justify-between items-start">
            <div>
              <h3 className="text-xl font-bold text-slate-800">Review Thread</h3>
              <p className="text-sm text-slate-500">Scheduled for: {new Date(post.scheduledDate).toLocaleString()}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full"><X size={20} className="text-slate-400" /></button>
          </div>

          <div className="p-6 flex-1 overflow-y-auto">
             {mode === 'view' ? (
               <div className="space-y-6">
                 <div>
                   <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Content</label>
                   <div className="p-4 bg-slate-50 rounded-xl text-slate-700 text-sm whitespace-pre-wrap leading-relaxed border border-slate-100">
                     {post.content}
                   </div>
                 </div>
                 {post.tags && post.tags.length > 0 && (
                   <div className="flex gap-2">
                     {post.tags.map(t => <span key={t} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs rounded-full font-medium">{t}</span>)}
                   </div>
                 )}
               </div>
             ) : (
               <div className="space-y-4 animate-in slide-in-from-right-4 duration-200">
                 <div className="flex items-center gap-2 text-rose-600 font-bold">
                    <AlertCircle size={20} />
                    <h3>Request Changes</h3>
                 </div>
                 <div className="flex flex-wrap gap-2">
                    {feedbackTags.map(tag => (
                      <button 
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${activeTags.includes(tag) ? 'bg-rose-100 border-rose-200 text-rose-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}
                      >
                        {tag}
                      </button>
                    ))}
                 </div>
                 <textarea 
                    className="w-full h-32 p-4 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 resize-none"
                    placeholder="Add specific notes here..."
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                 />
               </div>
             )}
          </div>

          <div className="p-6 border-t border-slate-100 bg-slate-50/50">
            {mode === 'view' ? (
              <div className="flex gap-4">
                <button 
                  onClick={() => setMode('reject')}
                  className="flex-1 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-xl hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 transition-all flex items-center justify-center gap-2"
                >
                  <ThumbsDown size={18} /> Request Changes
                </button>
                <button 
                  onClick={onApprove}
                  className="flex-1 py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
                >
                  <CheckCircle size={18} /> Approve Thread
                </button>
              </div>
            ) : (
              <div className="flex gap-4">
                <button 
                  onClick={() => setMode('view')}
                  className="px-6 py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleSubmitRejection}
                  className="flex-1 py-3 bg-rose-600 text-white font-bold rounded-xl hover:bg-rose-700 transition-all shadow-lg shadow-rose-600/20"
                >
                  Submit Feedback
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Mobile Preview Component ---
const MobilePreview = ({ post }) => {
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;

  const renderContent = () => {
    switch(post.platform) {
      case 'twitter':
        return (
          <div className="bg-white p-4 font-sans text-sm h-full">
             <div className="flex gap-3">
               <div className="w-10 h-10 rounded-full bg-slate-200 shrink-0" />
               <div className="flex-1">
                 <div className="flex items-center gap-1">
                   <span className="font-bold text-slate-900">You</span>
                   <span className="text-slate-500">@yourhandle · 1m</span>
                 </div>
                 <p className="text-slate-900 mt-1 whitespace-pre-wrap">{post.content || "Your post text..."}</p>
                 {post.imageUrl && (
                   <div className="mt-3 rounded-2xl overflow-hidden border border-slate-100">
                     <img src={post.imageUrl} className="w-full h-auto object-cover" alt="Preview" />
                   </div>
                 )}
               </div>
             </div>
          </div>
        );
      case 'instagram':
        return (
          <div className="bg-white font-sans text-sm pb-4 h-full">
             <div className="flex items-center justify-between p-3">
               <div className="flex items-center gap-2">
                 <div className="w-8 h-8 rounded-full bg-slate-200" />
                 <span className="font-semibold text-xs text-slate-900">your_username</span>
               </div>
               <MoreHorizontal size={16} />
             </div>
             <div className="bg-slate-100 w-full aspect-square flex items-center justify-center overflow-hidden">
               {post.imageUrl ? (
                 <img src={post.imageUrl} className="w-full h-full object-cover" alt="Preview" />
               ) : (
                 <span className="text-slate-400 text-xs">No Image</span>
               )}
             </div>
             <div className="p-3">
               <p className="text-slate-900 text-xs">
                 <span className="font-semibold mr-2">your_username</span>
                 {post.content || "Your caption..."}
               </p>
             </div>
          </div>
        );
      case 'linkedin':
        return (
          <div className="bg-white font-sans text-sm pb-4 border border-slate-200 my-4 rounded-lg h-full">
             <div className="flex gap-2 p-3">
               <div className="w-10 h-10 rounded bg-slate-200" />
               <div>
                 <div className="font-semibold text-xs text-slate-900">Your Name</div>
                 <div className="text-[10px] text-slate-500">Your Title • 1st</div>
               </div>
             </div>
             <div className="px-3 pb-2 text-xs text-slate-900 whitespace-pre-wrap">
               {post.content || "Your post content..."}
             </div>
             {post.imageUrl && (
               <img src={post.imageUrl} className="w-full h-auto object-cover" alt="Preview" />
             )}
          </div>
        );
      case 'gmb':
      default:
        return (
          <div className="bg-white font-sans text-sm p-4 h-full">
             <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white"><MapPin size={20} /></div>
                <div>
                   <div className="font-bold text-slate-900">Your Business</div>
                   <div className="text-xs text-slate-500">Posted on Google</div>
                </div>
             </div>
             {post.imageUrl && (
                <div className="rounded-lg overflow-hidden mb-3">
                   <img src={post.imageUrl} className="w-full h-40 object-cover" alt="Preview" />
                </div>
             )}
             <p className="text-slate-800 text-sm mb-4 whitespace-pre-wrap">{post.content || "Your update text..."}</p>
             <button className="w-full py-2 bg-slate-100 text-blue-700 font-medium rounded-full text-xs hover:bg-slate-200">Learn More</button>
          </div>
        );
    }
  };

  return (
    <div className="flex items-center justify-center p-4 bg-slate-100 rounded-xl h-full min-h-[500px]">
       <div className="w-[300px] bg-white rounded-[2rem] border-[6px] border-slate-800 shadow-2xl overflow-hidden relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-800 rounded-b-xl z-10" />
          <div className="h-full overflow-y-auto pt-8 scrollbar-hide">{renderContent()}</div>
       </div>
    </div>
  );
};

// --- Calendar View Component ---
const CalendarView = ({ posts, onEdit, currentDate, setCurrentDate }) => {
  const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  
  const days = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-slate-100">
        <h3 className="font-bold text-slate-800 text-lg">
          {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
        </h3>
        <div className="flex gap-1">
          <button onClick={prevMonth} className="p-1 hover:bg-slate-100 rounded"><ChevronLeft size={20} /></button>
          <button onClick={nextMonth} className="p-1 hover:bg-slate-100 rounded"><ChevronRight size={20} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-semibold text-slate-400 bg-slate-50 border-b border-slate-100">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="py-2">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 auto-rows-fr bg-slate-50 gap-px border-b border-slate-200">
        {days.map((day, idx) => {
          if (!day) return <div key={idx} className="bg-white min-h-[100px]" />;
          
          const dayPosts = posts.filter(p => {
             if (!p.scheduledDate) return false;
             const d = new Date(p.scheduledDate);
             return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
          });

          return (
            <div key={idx} className="bg-white min-h-[100px] p-1 sm:p-2 transition-colors hover:bg-slate-50">
              <span className={`text-xs font-medium mb-1 block ${
                new Date().getDate() === day && new Date().getMonth() === month ? 'text-indigo-600 bg-indigo-100 w-6 h-6 flex items-center justify-center rounded-full' : 'text-slate-400'
              }`}>{day}</span>
              <div className="space-y-1">
                {dayPosts.map(post => (
                  <button 
                    key={post.id}
                    onClick={() => onEdit(post)}
                    className={`w-full text-left text-[10px] px-1.5 py-1 rounded border truncate flex items-center gap-1 ${
                      post.status === STATUS.POSTED ? 'bg-indigo-50 border-indigo-100 text-indigo-800' : 'bg-white border-slate-100 text-slate-600 shadow-sm hover:border-indigo-300'
                    }`}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${PLATFORMS[post.platform]?.color || 'bg-slate-400'}`} />
                    <span className="truncate">{post.client ? `[${post.client}] ` : ''}{PLATFORMS[post.platform]?.name}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- Hashtag Manager Component ---
const HashtagManager = ({ onSelect, stacks, onSaveStack, onDeleteStack }) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newStackName, setNewStackName] = useState('');
  const [newStackTags, setNewStackTags] = useState('');

  const handleSave = () => {
    if (!newStackName || !newStackTags) return;
    onSaveStack({ name: newStackName, tags: newStackTags });
    setNewStackName('');
    setNewStackTags('');
    setIsAdding(false);
  };

  return (
    <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1">
          <Hash size={12} /> Hashtag Stacks
        </h4>
        <button onClick={() => setIsAdding(!isAdding)} className="text-xs text-indigo-700 font-medium hover:underline">
          {isAdding ? 'Cancel' : '+ New Stack'}
        </button>
      </div>

      {isAdding && (
        <div className="mb-4 space-y-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
          <input 
            type="text" 
            placeholder="Stack Name (e.g. Monday Motivation)" 
            className="w-full text-xs p-2 border border-slate-200 rounded"
            value={newStackName}
            onChange={e => setNewStackName(e.target.value)}
          />
          <textarea 
            placeholder="#hashtags #go #here" 
            className="w-full text-xs p-2 border border-slate-200 rounded resize-none h-16"
            value={newStackTags}
            onChange={e => setNewStackTags(e.target.value)}
          />
          <button onClick={handleSave} className="w-full bg-indigo-700 text-white text-xs py-1.5 rounded font-medium">Save Stack</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {stacks.map(stack => (
          <div key={stack.id} className="group flex items-center bg-white border border-slate-200 rounded-lg pl-2 pr-1 py-1 shadow-sm hover:border-indigo-300 transition-colors">
            <button 
              onClick={() => onSelect(stack.tags)}
              className="text-xs text-slate-600 font-medium hover:text-indigo-700 mr-2"
              title={stack.tags}
            >
              {stack.name}
            </button>
            <button onClick={() => onDeleteStack(stack.id)} className="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity">
              <X size={12} />
            </button>
          </div>
        ))}
        {stacks.length === 0 && !isAdding && (
          <span className="text-xs text-slate-400 italic">No saved stacks yet.</span>
        )}
      </div>
    </div>
  );
};


const PostCard = ({ post, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, isReadOnly, onClick }) => {
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const formattedDate = post.scheduledDate ? new Date(post.scheduledDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No date set';

  const copyToClipboard = (text) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  const getStatusColor = () => {
    if (post.approvalStatus === APPROVAL_STATUS.APPROVED) return 'border-l-4 border-l-emerald-500';
    if (post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) return 'border-l-4 border-l-rose-500';
    if (isPosted) return 'opacity-90';
    return '';
  };

  return (
    <div 
      onClick={onClick}
      className={`group relative bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden flex flex-col cursor-pointer ${getStatusColor()}`}
    >
      <div className={`h-1.5 w-full ${isPosted ? 'bg-indigo-500' : isScheduled ? 'bg-amber-400' : 'bg-slate-300'}`} />
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-2">
            <PlatformIcon platformId={post.platform} size={28} />
            <div>
              <h4 className="font-semibold text-slate-800 text-sm">{platform.name}</h4>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 text-xs text-slate-400"><Clock size={10} /><span>{formattedDate}</span></div>
                {post.client && <span className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded border border-indigo-100 font-medium truncate max-w-[80px]">{post.client}</span>}
              </div>
            </div>
          </div>
          
          {/* Approval Status Badge */}
          {post.approvalStatus === APPROVAL_STATUS.APPROVED && <div className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded flex items-center gap-1"><CheckCircle size={12} /> Approved</div>}
          {post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED && <div className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded flex items-center gap-1"><AlertCircle size={12} /> Review</div>}

          {!isReadOnly && (
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Platforms" className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md"><Layers size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md"><CopyPlus size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} className="p-1.5 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded-md"><Edit3 size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(post.id); }} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md"><Trash2 size={14} /></button>
            </div>
          )}
        </div>

        {/* Tags Display */}
        {post.tags && post.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {post.tags.map((tag, i) => (
              <span key={i} className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mb-4 flex-1">
          <p className="text-slate-600 text-sm line-clamp-3 leading-relaxed whitespace-pre-wrap font-medium">{post.content || <span className="italic text-slate-300">Empty draft...</span>}</p>
          {post.imageUrl && (
            <div className="mt-3 relative h-32 w-full bg-slate-50 rounded-lg overflow-hidden border border-slate-100 group">
               <img src={post.imageUrl} alt="Post asset" className="w-full h-full object-cover" onError={(e) => e.target.style.display = 'none'} />
               <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a href={post.imageUrl} download="social-post-image" target="_blank" rel="noreferrer" className="bg-white/90 p-1.5 rounded-full shadow-sm text-slate-600 hover:text-indigo-700 block"><UploadCloud size={14} className="transform rotate-180" /></a>
               </div>
            </div>
          )}
        </div>
        
        {/* Results Display */}
        {isPosted && post.resultStats && (
          <div className="mb-4 p-2 bg-indigo-50 rounded-lg border border-indigo-100">
             <div className="flex items-center gap-1.5 text-[10px] font-bold text-indigo-800 uppercase tracking-wider mb-1"><BarChart2 size={10} /> Results</div>
             <p className="text-xs text-indigo-900 font-medium">{post.resultStats}</p>
          </div>
        )}

        {/* Feedback Display (if any) */}
        {post.feedback && (
           <div className="mb-4 p-2 bg-rose-50 rounded-lg border border-rose-100">
              <div className="flex items-center gap-1.5 text-[10px] font-bold text-rose-800 uppercase tracking-wider mb-1"><MessageSquare size={10} /> Feedback</div>
              <p className="text-xs text-rose-900 italic">"{post.feedback}"</p>
           </div>
        )}

        {!isReadOnly && (
          <div className="flex items-center justify-between pt-3 border-t border-slate-50 mt-auto">
            <button onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-700 transition-colors active:scale-95"><Copy size={12} /><span>Copy</span></button>
            <a href={platform.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"><ExternalLink size={12} /><span>Open App</span></a>
            <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, isPosted ? STATUS.DRAFT : STATUS.POSTED); }} className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-full transition-colors ${isPosted ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{isPosted ? 'Posted' : 'Mark Done'}</button>
          </div>
        )}
      </div>
    </div>
  );
};

const Editor = ({ post, onSave, onCancel, isSaving, hashtagStacks, onSaveStack, onDeleteStack, uniqueClients }) => {
  const [formData, setFormData] = useState({ platform: 'gmb', content: '', scheduledDate: new Date().toISOString().slice(0, 16), imageUrl: '', tags: [], resultStats: '', client: '', ...post });
  const [dragActive, setDragActive] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isMagicMenuOpen, setIsMagicMenuOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const fileInputRef = useRef(null);

  const handleChange = (field, value) => setFormData(prev => ({ ...prev, [field]: value }));
  const appendHashtags = (tags) => setFormData(prev => ({ ...prev, content: prev.content + (prev.content ? '\n\n' : '') + tags }));

  const handleMagicReword = (type, e) => {
    e.stopPropagation(); // Stop bubbling
    if (!formData.content) return;
    const newText = TRANSFORMATIONS[type](formData.content);
    setFormData(prev => ({ ...prev, content: newText }));
    setIsMagicMenuOpen(false);
  };

  const handleAddTag = () => {
    if (tagInput.trim() && !formData.tags?.includes(tagInput.trim())) {
      setFormData(prev => ({ ...prev, tags: [...(prev.tags || []), tagInput.trim()] }));
      setTagInput('');
    }
  };

  const removeTag = (tagToRemove) => {
    setFormData(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tagToRemove) }));
  };

  const processFile = (file) => {
    if (!file || file.size > 10 * 1024 * 1024) return alert("File too large (>10MB)");
    setIsProcessingImage(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width, height = img.height;
        const MAX = 800;
        if (width > height && width > MAX) { height *= MAX / width; width = MAX; }
        else if (height > MAX) { width *= MAX / height; height = MAX; }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        handleChange('imageUrl', canvas.toDataURL('image/jpeg', 0.6));
        setIsProcessingImage(false);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]);
  };

  const currentPlatform = PLATFORMS[formData.platform];
  const charCount = formData.content.length;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="border-b border-slate-100 px-6 py-4 flex items-center justify-between bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">{post ? 'Edit Thread' : 'New Thread'}</h2>
        <div className="flex gap-2">
          {/* Toggle Preview Button */}
          <button 
            onClick={() => setShowPreview(!showPreview)} 
            className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-2 ${showPreview ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            title="Toggle Mobile Preview"
          >
            <Smartphone size={16} />
            <span className="hidden sm:inline">{showPreview ? 'Edit' : 'Preview'}</span>
          </button>
          
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50 rounded-lg">Cancel</button>
          <button onClick={() => onSave(formData)} disabled={isSaving || isProcessingImage} className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"><Save size={16} />{isSaving ? 'Saving...' : 'Save Draft'}</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-2xl mx-auto space-y-8">
          
          {/* Client Selection */}
          <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
             <div className="flex items-center gap-2 text-slate-500">
                <Briefcase size={18} />
                <span className="text-xs font-bold uppercase tracking-wider">Client Account</span>
             </div>
             <div className="flex-1 relative">
                <input 
                  type="text"
                  list="clients-list"
                  placeholder="e.g. Stitch TEC, Coffee Shop..."
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  value={formData.client || ''}
                  onChange={(e) => handleChange('client', e.target.value)}
                />
                <datalist id="clients-list">
                   {uniqueClients.map(c => <option key={c} value={c} />)}
                </datalist>
             </div>
          </div>

          {/* Platform Selector */}
          <div className="space-y-3">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Destination</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.values(PLATFORMS).map((p) => (
                <button key={p.id} onClick={() => handleChange('platform', p.id)} className={`flex flex-col items-center justify-center p-4 rounded-xl border transition-all duration-200 ${formData.platform === p.id ? 'border-indigo-600 bg-indigo-50 text-indigo-900 ring-1 ring-indigo-600' : 'border-slate-200 hover:border-indigo-300 hover:bg-slate-50 text-slate-600'}`}>
                  <PlatformIcon platformId={p.id} size={24} className="mb-2" />
                  <span className="text-xs font-medium">{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {showPreview ? (
            <div className="animate-in fade-in duration-300">
               <MobilePreview post={formData} />
            </div>
          ) : (
            <>
              {/* Manual Results Log (Only if Posted) */}
              {formData.status === STATUS.POSTED && (
                 <div className="space-y-3 animate-in fade-in slide-in-from-top-4 duration-500">
                    <label className="text-xs font-bold text-indigo-700 uppercase tracking-wider flex items-center gap-2"><BarChart2 size={12} /> Performance Notes</label>
                    <textarea 
                      value={formData.resultStats} 
                      onChange={(e) => handleChange('resultStats', e.target.value)} 
                      placeholder="E.g., 25 likes, 3 leads generated. Best performing post this week!" 
                      className="w-full h-24 p-4 bg-indigo-50 border border-indigo-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none text-indigo-900 text-sm leading-relaxed placeholder:text-indigo-700/50" 
                    />
                 </div>
              )}

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Content</label>
                  
                  <div className="flex items-center gap-3">
                    {/* Magic Wand Menu */}
                    <div className="relative">
                      <button 
                        onClick={(e) => { e.stopPropagation(); setIsMagicMenuOpen(!isMagicMenuOpen); }}
                        className={`text-xs font-bold flex items-center gap-1 transition-colors px-2 py-1 rounded-md ${isMagicMenuOpen ? 'bg-rose-100 text-rose-700' : 'text-rose-600 hover:bg-rose-50'}`}
                        title="AI Magic Reword"
                      >
                        <Wand2 size={14} /> Magic Wand
                      </button>
                      
                      {isMagicMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsMagicMenuOpen(false)}></div>
                          <div className="absolute right-0 top-8 w-48 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in duration-200">
                            <div className="p-2 border-b border-slate-100 bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                              Choose Style
                            </div>
                            <button onClick={(e) => handleMagicReword('punchy', e)} className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-rose-50 hover:text-rose-700 flex items-center gap-2 border-b border-slate-50">
                              <Zap size={14} /> Make it Punchy
                            </button>
                            <button onClick={(e) => handleMagicReword('professional', e)} className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 flex items-center gap-2 border-b border-slate-50">
                              <Linkedin size={14} /> Professional
                            </button>
                            <button onClick={(e) => handleMagicReword('emojify', e)} className="w-full text-left px-4 py-3 text-sm text-slate-700 hover:bg-amber-50 hover:text-amber-700 flex items-center gap-2">
                              <Sparkles size={14} /> Emojify
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${charCount > currentPlatform.maxChars ? 'text-rose-500 font-bold' : 'text-slate-400'}`}>{charCount} / {currentPlatform.maxChars}</span>
                      <CharCountCircle current={charCount} max={currentPlatform.maxChars} />
                    </div>
                  </div>
                </div>
                
                <div className="relative">
                  <textarea value={formData.content} onChange={(e) => handleChange('content', e.target.value)} placeholder={currentPlatform.placeholder} className={`w-full h-48 p-4 bg-slate-50 border rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none text-slate-700 text-base leading-relaxed placeholder:text-slate-400 ${charCount > currentPlatform.maxChars ? 'border-rose-300' : 'border-slate-200'}`} />
                </div>
                
                {/* Campaign Tags */}
                <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-2">
                   <Tag size={16} className="text-slate-400 ml-2" />
                   <div className="flex flex-wrap gap-2 flex-1">
                      {formData.tags?.map((tag, i) => (
                        <span key={i} className="px-2 py-1 text-xs font-medium rounded-full bg-slate-100 text-slate-700 flex items-center gap-1">
                          {tag}
                          <button onClick={() => removeTag(tag)} className="hover:text-rose-500"><X size={10} /></button>
                        </span>
                      ))}
                      <input 
                        type="text" 
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                        placeholder={formData.tags?.length > 0 ? "Add another..." : "Add tags (e.g. Promo, Blog)..."} 
                        className="text-xs outline-none bg-transparent min-w-[120px] text-slate-600 placeholder:text-slate-400"
                      />
                   </div>
                   <button onClick={handleAddTag} className="text-xs font-medium text-slate-500 hover:text-indigo-700 px-2">Add</button>
                </div>

                <HashtagManager stacks={hashtagStacks} onSelect={appendHashtags} onSaveStack={onSaveStack} onDeleteStack={onDeleteStack} />
              </div>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Media</label>
                  {!formData.imageUrl ? (
                    <div className={`border-2 border-dashed rounded-xl h-40 flex flex-col items-center justify-center text-center p-4 cursor-pointer transition-all ${dragActive ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50'}`} onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}>
                      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => processFile(e.target.files[0])} />
                      <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 mb-2"><UploadCloud size={20} /></div>
                      <p className="text-sm font-medium text-slate-600">Click to upload or drag image</p>
                      <p className="text-xs text-slate-400 mt-1">Supports JPG, PNG (Max 5MB)</p>
                      {isProcessingImage && (
                        <div className="mt-2 flex items-center gap-2 text-xs text-indigo-600 font-medium">
                           <Loader2 size={12} className="animate-spin" /> Compressing image...
                        </div>
                      )}
                      <div className="mt-3 pt-3 border-t border-slate-200 w-full" onClick={(e) => e.stopPropagation()}><div className="flex items-center gap-2 bg-white rounded-lg border border-slate-200 p-1.5"><LinkIcon size={14} className="text-slate-400 ml-1.5" /><input type="text" placeholder="Or paste URL..." className="text-xs w-full outline-none text-slate-600" value={formData.imageUrl} onChange={(e) => handleChange('imageUrl', e.target.value)} /></div></div>
                    </div>
                  ) : (
                    <div className="relative h-40 w-full rounded-xl bg-slate-900 group overflow-hidden border border-slate-200"><img src={formData.imageUrl} alt="Preview" className="h-full w-full object-cover opacity-90" /><div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"><button onClick={() => handleChange('imageUrl', '')} className="bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5"><Trash2 size={12} />Remove</button></div></div>
                  )}
                </div>
                <div className="space-y-3">
                   <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Schedule For</label>
                   <input type="datetime-local" value={formData.scheduledDate} onChange={(e) => handleChange('scheduledDate', e.target.value)} className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-slate-600" />
                   <div className="p-4 bg-indigo-50/50 rounded-xl border border-indigo-100 mt-2"><h4 className="text-xs font-bold text-indigo-800 mb-1 flex items-center gap-1"><AlertCircle size={12} /> Pro Tip</h4><p className="text-xs text-indigo-700/80 leading-relaxed">{formData.platform === 'gmb' && "GMB Offer posts expire. Set your schedule for the start date of your sale."}{formData.platform === 'linkedin' && "LinkedIn engagement peaks Tuesday-Thursday mornings."}{formData.platform === 'instagram' && "Don't forget to paste your hashtags in the first comment."}{formData.platform === 'twitter' && "Threads perform better than single tweets. Break this up if it's long."}</p></div>
                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
};

// --- Main Application ---
export default function SpoolApp() {
  return (
    <ErrorBoundary>
        <SpoolAppContent />
    </ErrorBoundary>
  );
}

function SpoolAppContent() {
  const [user, setUser] = useState(null);
  const [posts, setPosts] = useState([]);
  const [hashtagStacks, setHashtagStacks] = useState([]);
  const [view, setView] = useState('landing'); // 'landing', 'dashboard', 'editor', 'shared'
  const [dashboardView, setDashboardView] = useState('list'); // 'list' or 'calendar'
  const [editingPost, setEditingPost] = useState(null);
  const [reviewingPost, setReviewingPost] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selectedClient, setSelectedClient] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const mainContentRef = useRef(null);
  
  // Spark Deck State
  const [isSparkDeckOpen, setIsSparkDeckOpen] = useState(false);
  
  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState(null); // { title, message, onConfirm, type }
  
  // Shared View State
  const [sharedIdInput, setSharedIdInput] = useState('');
  const [sharedPosts, setSharedPosts] = useState([]);
  const [sharedDocId, setSharedDocId] = useState(null);

  useEffect(() => {
    // 1. Setup Auth Listener (Separate from routing)
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. Separate Effect for Initial Redirect
  useEffect(() => {
    if (loading) return; // Wait for auth check

    if (user && view === 'landing') {
        // If Google User (Owner), go to dashboard
        if (!user.isAnonymous) {
            setView('dashboard'); 
        }
        // If Anonymous, stay on landing (waiting for Load Shared action)
    } else if (!user && view !== 'landing' && view !== 'shared') {
        // If logged out and trying to access private areas, kick to landing
        setView('landing');
    }
  }, [user, loading]); // Removed 'view' from dependency array to prevent loops!

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed", error);
      showToast('Login failed', 'error');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setPosts([]); // Clear local posts immediately
      setView('landing');
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const changeView = (newView) => {
    setView(newView);
    if (mainContentRef.current) {
      mainContentRef.current.scrollTo(0, 0);
    }
  };

  const uniqueClients = useMemo(() => {
    return [...new Set(posts.map(p => p.client).filter(Boolean))].sort();
  }, [posts]);

  useEffect(() => {
    // Only subscribe to posts if we have a user AND they are an OWNER (not anonymous guest)
    if (!user || user.isAnonymous) return;

    const postsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'posts');
    const unsubPosts = onSnapshot(postsRef, (snapshot) => {
        const fetchedPosts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        fetchedPosts.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));
        setPosts(fetchedPosts);
    });

    const hashtagsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'hashtags');
    const unsubTags = onSnapshot(hashtagsRef, (snapshot) => {
        const fetchedTags = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setHashtagStacks(fetchedTags);
    });

    return () => {
        unsubPosts();
        unsubTags();
    };
  }, [user]); // Re-run when user changes

  const handleSave = async (postData) => {
    if (!user) return;
    setSaving(true);
    const now = new Date();
    const scheduled = new Date(postData.scheduledDate);
    const status = postData.status === STATUS.POSTED ? STATUS.POSTED : (scheduled > now ? STATUS.SCHEDULED : STATUS.DRAFT);
    const payload = { ...postData, status, updatedAt: serverTimestamp() };

    try {
      if (postData.id) {
        await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'posts', postData.id), payload);
        showToast('Draft updated successfully');
      } else {
        await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'posts'), { ...payload, createdAt: serverTimestamp() });
        showToast('New spark captured');
      }
      changeView('dashboard');
      setEditingPost(null);
    } catch (error) { 
      console.error("Save Error:", error);
      showToast('Error saving draft - Check Console', 'error'); 
    } finally { setSaving(false); }
  };

  const handleDeleteClick = (postId) => {
    setConfirmModal({
        title: "Delete Draft?",
        message: "This action cannot be undone. Are you sure you want to delete this post?",
        type: 'danger',
        onConfirm: () => {
            handleDelete(postId);
            setConfirmModal(null);
        }
    });
  };

  const handleDelete = async (postId) => {
    if (!user) return;
    try { await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'posts', postId)); showToast('Draft deleted'); } catch (e) { showToast('Could not delete', 'error'); }
  };

  const handleDuplicate = (post) => {
    const { id, ...postData } = post;
    setEditingPost({ ...postData, status: STATUS.DRAFT, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    changeView('editor');
    showToast('Draft cloned! Make your edits.');
  };

  const handleCloneToAllClick = (originalPost) => {
    if (!user) return;
    const { platform: originalPlatform } = originalPost;
    const targetPlatforms = Object.keys(PLATFORMS).filter(p => p !== originalPlatform);
    
    setConfirmModal({
        title: "Blast to all platforms?",
        message: `This will create ${targetPlatforms.length} new drafts for ${targetPlatforms.map(p => PLATFORMS[p].name).join(', ')}.`,
        onConfirm: () => {
            performCloneToAll(originalPost, targetPlatforms);
            setConfirmModal(null);
        }
    });
  };

  const performCloneToAll = async (originalPost, targetPlatforms) => {
    const { id, platform, resultStats, ...baseData } = originalPost;
    const batch = writeBatch(db);
    const postsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'posts');

    targetPlatforms.forEach(p => {
      const newRef = doc(postsRef);
      batch.set(newRef, {
        ...baseData,
        platform: p,
        status: STATUS.DRAFT,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });

    try {
      await batch.commit();
      showToast(`Boom! Cloned to ${targetPlatforms.length} platforms.`);
    } catch (e) {
      console.error(e);
      showToast('Blast failed', 'error');
    }
  };

  const handleStatusChange = async (postId, newStatus) => {
    if (!user) return;
    try { await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'posts', postId), { status: newStatus }); showToast(newStatus === STATUS.POSTED ? 'Great job! Marked as Posted.' : 'Status updated'); } catch (e) { showToast('Update failed', 'error'); }
  };

  const handleUseSpark = (prompt) => {
    setEditingPost({
      content: prompt,
      platform: 'gmb',
      scheduledDate: new Date().toISOString().slice(0, 16),
      imageUrl: '',
      status: STATUS.DRAFT,
      tags: ['Spark Idea']
    });
    setIsSparkDeckOpen(false);
    changeView('editor');
    showToast('Spark activated!');
  };

  const handleSaveStack = async (stack) => {
    if (!user) return;
    try { await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'hashtags'), stack); showToast('Hashtag stack saved'); } catch(e) { showToast('Error saving stack', 'error'); }
  };

  const handleDeleteStack = async (id) => {
    if (!user) return;
    try { await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'hashtags', id)); showToast('Stack removed'); } catch(e) { showToast('Error removing stack', 'error'); }
  };

  const handleShareSchedule = async () => {
    if (!user) return;
    const shareId = Math.random().toString(36).substring(2, 10);
    
    // Filter posts based on selection
    let postsToShare = posts.filter(p => p.status !== STATUS.DRAFT);
    if (selectedClient) {
        postsToShare = postsToShare.filter(p => p.client === selectedClient);
    }

    if (postsToShare.length === 0) {
        showToast('No published/scheduled posts to share for this selection.', 'error');
        return;
    }

    const publicData = {
      ownerId: user.uid,
      generatedAt: new Date().toISOString(),
      clientFilter: selectedClient || 'All Clients',
      posts: postsToShare.map(p => ({
        // Ensure we keep track of ID for updates if needed, though this snapshot is separate
        // For shared view updates, we rely on array index or consistent ID
        id: p.id, 
        content: p.content,
        platform: p.platform,
        scheduledDate: p.scheduledDate,
        imageUrl: p.imageUrl || null,
        status: p.status,
        approvalStatus: p.approvalStatus || APPROVAL_STATUS.PENDING,
        feedback: p.feedback || '',
        tags: p.tags || [],
        client: p.client || null
      }))
    };
    
    try {
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shares', shareId), publicData);
      prompt(`Share ID generated for ${selectedClient || 'All Clients'}. Provide this ID to your client:`, shareId);
    } catch (e) {
      console.error(e);
      showToast('Could not generate link', 'error');
    }
  };

  const handleLoadShared = async () => {
    if (!sharedIdInput) return;
    setLoading(true);
    try {
      // Auto-login anonymously if needed to read DB
      if (!auth.currentUser) {
         await signInAnonymously(auth);
      }

      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'shares', sharedIdInput);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        setSharedDocId(sharedIdInput);
        // SAFETY: Assign temp IDs if missing (for legacy shares) to prevent "mark all" bug
        setSharedPosts(data.posts.map((p, i) => ({ ...p, id: p.id || `temp-${i}` })));
        changeView('shared');
        showToast(`Loaded schedule for: ${data.clientFilter || 'Shared View'}`);
      } else {
        showToast('Invalid Share ID', 'error');
      }
    } catch (e) {
      console.error("Load Error:", e);
      showToast('Error loading schedule', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateSharedPost = async (updatedPost) => {
    if (!sharedDocId) return;
    
    // Optimistic Update
    const newPosts = sharedPosts.map(p => p.id === updatedPost.id ? updatedPost : p);
    setSharedPosts(newPosts);
    setReviewingPost(null); // Close modal

    // Update in Firestore
    try {
       const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'shares', sharedDocId);
       // We need to fetch the current doc to preserve other fields, then update posts
       const snap = await getDoc(docRef);
       if (snap.exists()) {
          const currentData = snap.data();
          await updateDoc(docRef, {
             posts: newPosts
          });
          showToast("Feedback Saved!");
       }
    } catch (e) {
       console.error("Error saving feedback:", e);
       showToast("Failed to save feedback", "error");
    }
  };

  // CSV Export for Reporting
  const handleExportCSV = () => {
    if (!user || filteredPosts.length === 0) return;
    
    const headers = ["Date", "Client", "Platform", "Content", "Status", "Approval", "Feedback", "Results"];
    const rows = filteredPosts.map(p => [
      p.scheduledDate ? new Date(p.scheduledDate).toLocaleDateString() : 'No Date',
      p.client || 'General',
      PLATFORMS[p.platform]?.name || p.platform,
      `"${(p.content || '').replace(/"/g, '""')}"`, // Escape quotes
      p.status,
      p.approvalStatus || 'Pending',
      `"${(p.feedback || '').replace(/"/g, '""')}"`,
      `"${(p.resultStats || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `spool_report_${selectedClient || 'all'}_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const showToast = (message, type = 'success') => setToast({ message, type });

  const filteredPosts = useMemo(() => {
    let result = posts;
    
    // Client Filter
    if (selectedClient) {
      result = result.filter(p => p.client === selectedClient);
    }

    // Search
    if (searchQuery) {
      const lowerQ = searchQuery.toLowerCase();
      result = result.filter(p => 
        p.content?.toLowerCase().includes(lowerQ) || 
        PLATFORMS[p.platform]?.name.toLowerCase().includes(lowerQ) ||
        p.tags?.some(tag => tag.toLowerCase().includes(lowerQ))
      );
    }

    // Tab Filter
    if (filter === 'all') return result;
    if (filter === 'scheduled') return result.filter(p => p.status === STATUS.SCHEDULED);
    if (filter === 'draft') return result.filter(p => p.status === STATUS.DRAFT);
    if (filter === 'posted') return result.filter(p => p.status === STATUS.POSTED);
    return result;
  }, [posts, filter, searchQuery, selectedClient]);

  const counts = useMemo(() => ({
    all: posts.length,
    scheduled: posts.filter(p => p.status === STATUS.SCHEDULED).length,
    draft: posts.filter(p => p.status === STATUS.DRAFT).length,
    posted: posts.filter(p => p.status === STATUS.POSTED).length
  }), [posts]);

  if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50 text-slate-400"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-4"></div></div>;

  // --- Landing Page (Public Access) ---
  if ((!user || (user && user.isAnonymous && view !== 'shared')) && view === 'landing') {
    return (
      <div className="h-screen w-full bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white max-w-md w-full p-8 rounded-2xl shadow-xl border border-slate-100 text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center text-white mx-auto mb-6 shadow-lg shadow-indigo-200">
            <Scroll size={32} />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Welcome to Spool</h1>
          <p className="text-slate-500 mb-8">Digital craftsmanship by Stitch TEC.</p>
          
          <div className="space-y-4">
            {/* Owner Login */}
            <button 
                onClick={handleLogin}
                className="w-full flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 px-4 rounded-xl transition-all shadow-sm hover:shadow-md"
            >
                <Briefcase size={20} />
                Owner Sign In
            </button>

            <div className="relative flex py-2 items-center">
                <div className="flex-grow border-t border-slate-200"></div>
                <span className="flex-shrink-0 mx-4 text-slate-400 text-xs uppercase tracking-wider">Client Access</span>
                <div className="flex-grow border-t border-slate-200"></div>
            </div>

            {/* Client Shared View Access */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-left">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">View Shared Schedule</label>
                <div className="flex gap-2">
                    <input 
                        type="text" 
                        placeholder="Enter Share ID..." 
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                        value={sharedIdInput} 
                        onChange={(e) => setSharedIdInput(e.target.value)} 
                    />
                    <button 
                        onClick={handleLoadShared}
                        className="bg-white border border-slate-300 text-slate-600 hover:text-indigo-600 hover:border-indigo-300 p-2 rounded-lg transition-colors"
                    >
                        <ArrowRight size={20} />
                    </button>
                </div>
            </div>
          </div>
          
          <p className="mt-8 text-xs text-slate-400">© {new Date().getFullYear()} Stitch TEC</p>
        </div>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </div>
    );
  }

  // --- Shared View (No Auth Required) ---
  if (view === 'shared') {
      return (
        <div className="h-screen w-full bg-slate-50 font-sans flex flex-col">
            <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white"><Scroll size={18} /></div>
                    <div>
                        <h1 className="font-bold text-lg text-slate-800 leading-none">Spool Shared View</h1>
                        <p className="text-xs text-slate-500">Read-Only Access</p>
                    </div>
                </div>
                <button 
                    onClick={() => { setSharedPosts([]); setView('landing'); setSharedIdInput(''); }}
                    className="text-sm font-medium text-slate-500 hover:text-slate-800"
                >
                    Exit View
                </button>
            </header>
            
            <main className="flex-1 overflow-y-auto p-4 md:p-8">
                <div className="max-w-6xl mx-auto">
                    {sharedPosts.length === 0 ? (
                        <div className="text-center py-20 text-slate-400">
                            <p>No posts found in this shared view.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                            {sharedPosts.map((post, idx) => (
                                <PostCard 
                                    key={idx} 
                                    post={post} 
                                    isReadOnly={true} 
                                    onClick={() => setReviewingPost(post)} 
                                />
                            ))}
                        </div>
                    )}
                </div>
            </main>

            {/* Review Modal */}
            {reviewingPost && (
                <ReviewModal 
                    post={reviewingPost} 
                    onClose={() => setReviewingPost(null)}
                    onApprove={() => handleUpdateSharedPost({ ...reviewingPost, approvalStatus: APPROVAL_STATUS.APPROVED })}
                    onRequestChanges={(feedback) => handleUpdateSharedPost({ ...reviewingPost, approvalStatus: APPROVAL_STATUS.CHANGES_REQUESTED, feedback })}
                />
            )}
            
            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
        </div>
      );
  }

  return (
    <div className="h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden bg-white border-b border-slate-200 p-4 flex items-center justify-between z-30 relative shadow-sm">
        <div className="flex items-center gap-2"><div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white"><Scroll size={18} /></div><h1 className="font-bold text-lg tracking-tight text-indigo-950">Spool</h1></div>
        <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg">{isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}</button>
      </div>

      {/* Sidebar */}
      <nav className={`fixed inset-0 bg-white/95 backdrop-blur-sm z-20 transition-transform duration-300 md:relative md:inset-auto md:bg-white md:translate-x-0 md:w-64 md:border-r md:border-slate-200 flex flex-col justify-between shrink-0 ${isMobileMenuOpen ? 'translate-x-0 pt-20' : '-translate-x-full md:pt-0'}`}>
        <div className="p-6 h-full flex flex-col">
          <div className="hidden md:flex items-center gap-2 mb-8"><div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white"><Scroll size={18} /></div>
            <div>
              <h1 className="font-bold text-lg tracking-tight text-indigo-950 leading-none">Spool</h1>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">by Stitch TEC</p>
            </div>
          </div>
          
          <button onClick={() => { setEditingPost(null); changeView('editor'); setIsMobileMenuOpen(false); }} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white p-3 rounded-xl font-medium shadow-lg shadow-indigo-900/10 flex items-center justify-center gap-2 transition-all active:scale-95 mb-6"><Plus size={18} /><span>New Thread</span></button>
          
          <div className="space-y-1">
            <button onClick={() => { changeView('dashboard'); setFilter('all'); setIsMobileMenuOpen(false); }} className={`w-full flex items-center justify-between p-3 rounded-lg text-sm font-medium transition-colors ${view === 'dashboard' && filter === 'all' ? 'bg-indigo-50 text-indigo-900' : 'text-slate-500 hover:bg-slate-50'}`}><div className="flex items-center gap-3"><Layout size={18} /><span>All Threads</span></div><span className="bg-white border border-slate-200 px-2 py-0.5 rounded text-xs text-slate-400">{counts.all}</span></button>
            <button onClick={() => { changeView('dashboard'); setFilter('scheduled'); setIsMobileMenuOpen(false); }} className={`w-full flex items-center justify-between p-3 rounded-lg text-sm font-medium transition-colors ${filter === 'scheduled' ? 'bg-amber-50 text-amber-900' : 'text-slate-500 hover:bg-slate-50'}`}><div className="flex items-center gap-3"><CalendarIcon size={18} /><span>Scheduled</span></div><span className="bg-white border border-slate-200 px-2 py-0.5 rounded text-xs text-slate-400">{counts.scheduled}</span></button>
            <button onClick={() => { changeView('dashboard'); setFilter('posted'); setIsMobileMenuOpen(false); }} className={`w-full flex items-center justify-between p-3 rounded-lg text-sm font-medium transition-colors ${filter === 'posted' ? 'bg-emerald-50 text-emerald-900' : 'text-slate-500 hover:bg-slate-50'}`}><div className="flex items-center gap-3"><CheckCircle size={18} /><span>Posted</span></div><span className="bg-white border border-slate-200 px-2 py-0.5 rounded text-xs text-slate-400">{counts.posted}</span></button>
          </div>
          
          <div className="mt-auto pt-6 border-t border-slate-100 md:hidden flex flex-col gap-2">
             <div className="bg-slate-50 rounded-xl p-4 border border-slate-100"><p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Signed In</p><p className="text-xs font-mono text-slate-400 truncate">{user?.email}</p></div>
             <button onClick={handleLogout} className="w-full bg-rose-50 text-rose-700 hover:bg-rose-100 p-3 rounded-xl text-xs font-medium flex items-center justify-center gap-2 transition-colors"><LogOut size={14} /> Sign Out</button>
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 hidden md:flex flex-col gap-3">
           <div className="bg-slate-50 rounded-xl p-4 border border-slate-100"><p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Signed In</p><p className="text-xs font-mono text-slate-400 truncate">{user?.email}</p></div>
           <button onClick={handleLogout} className="w-full bg-rose-50 text-rose-700 hover:bg-rose-100 p-2 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-colors"><LogOut size={14} /> Sign Out</button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 relative overflow-hidden flex flex-col" ref={mainContentRef}>
        {view === 'editor' ? (
          <Editor 
            post={editingPost} 
            onSave={handleSave} 
            onCancel={() => { changeView('dashboard'); setEditingPost(null); }} 
            isSaving={saving}
            hashtagStacks={hashtagStacks}
            onSaveStack={handleSaveStack}
            onDeleteStack={handleDeleteStack}
            uniqueClients={uniqueClients}
          />
        ) : (
          <div className="h-full overflow-y-auto p-4 md:p-8">
            <header className="mb-8 flex flex-col xl:flex-row xl:items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">
                  {filter === 'all' && 'All Threads'}
                  {filter === 'scheduled' && 'Upcoming Spool'}
                  {filter === 'posted' && 'History'}
                  {filter === 'draft' && 'Idea Bank'}
                </h2>
                <p className="text-slate-500 text-sm mt-1">Stitch your digital presence together.</p>
              </div>
              <div className="flex flex-col md:flex-row gap-3 items-center w-full xl:w-auto">
                
                {/* Client Filter Dropdown */}
                <div className="relative w-full md:w-48">
                   <select 
                      value={selectedClient} 
                      onChange={(e) => setSelectedClient(e.target.value)}
                      className="w-full pl-3 pr-8 py-2 bg-white border border-slate-200 rounded-lg text-sm appearance-none focus:outline-none focus:border-indigo-500 text-slate-600"
                   >
                      <option value="">All Clients</option>
                      {uniqueClients.map(c => <option key={c} value={c}>{c}</option>)}
                   </select>
                   <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                      <ChevronLeft size={14} className="-rotate-90" />
                   </div>
                </div>

                {/* View Toggle */}
                <div className="flex bg-white rounded-lg border border-slate-200 p-1 w-full md:w-auto">
                   <button onClick={() => setDashboardView('list')} className={`flex-1 md:flex-none p-2 rounded ${dashboardView === 'list' ? 'bg-indigo-50 text-indigo-800' : 'text-slate-400 hover:text-slate-600'}`}><List size={18} className="mx-auto" /></button>
                   <button onClick={() => setDashboardView('calendar')} className={`flex-1 md:flex-none p-2 rounded ${dashboardView === 'calendar' ? 'bg-indigo-50 text-indigo-800' : 'text-slate-400 hover:text-slate-600'}`}><Grid size={18} className="mx-auto" /></button>
                </div>

                <div className="relative flex-1 w-full md:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input type="text" placeholder="Search threads or tags..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all" />
                </div>
                
                <div className="flex gap-2 w-full md:w-auto">
                  <button onClick={handleExportCSV} title="Download CSV Report" className="flex-1 md:flex-none bg-emerald-50 border border-emerald-100 text-emerald-600 hover:text-emerald-700 p-2 rounded-lg transition-colors flex justify-center"><Download size={20} /></button>
                  <button onClick={() => setIsSparkDeckOpen(true)} title="Get a content idea" className="flex-1 md:flex-none bg-rose-50 border border-rose-100 text-rose-600 hover:text-rose-700 p-2 rounded-lg transition-colors flex justify-center"><Zap size={20} fill="currentColor" /></button>
                  <button onClick={handleShareSchedule} title="Generate Team Share Link" className="flex-1 md:flex-none bg-white border border-slate-200 text-slate-600 hover:text-indigo-700 hover:border-indigo-300 p-2 rounded-lg transition-colors flex justify-center"><Share2 size={20} /></button>
                </div>
              </div>
            </header>

            {dashboardView === 'calendar' ? (
              <div className="pb-20">
                <CalendarView posts={posts} onEdit={(p) => { setEditingPost(p); changeView('editor'); }} currentDate={currentMonth} setCurrentDate={setCurrentMonth} />
              </div>
            ) : filteredPosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center text-slate-300 mb-4">{searchQuery ? <Search size={32} /> : <Plus size={32} />}</div>
                <h3 className="text-lg font-medium text-slate-700 mb-2">{searchQuery ? 'No results found' : 'No threads here yet'}</h3>
                {!searchQuery && <button onClick={() => { setEditingPost(null); changeView('editor'); }} className="text-indigo-700 font-medium hover:underline">Start your first thread &rarr;</button>}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pb-20">
                {filteredPosts.map(post => (
                  <PostCard key={post.id} post={post} onEdit={(p) => { setEditingPost(p); changeView('editor'); }} onDuplicate={handleDuplicate} onCloneToAll={handleCloneToAllClick} onDelete={handleDeleteClick} onStatusChange={handleStatusChange} />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Modals */}
      {isSparkDeckOpen && <SparkDeck onClose={() => setIsSparkDeckOpen(false)} onUse={handleUseSpark} />}
      {confirmModal && (
        <ConfirmModal a
          title={confirmModal.title} 
          message={confirmModal.message} 
          type={confirmModal.type}
          onConfirm={confirmModal.onConfirm} 
          onCancel={() => setConfirmModal(null)} 
        />
      )}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}