import React, { useState, useEffect, useMemo, Component } from 'react';
import { 
  Layout, LogOut, Plus, Search, Menu, 
  Calendar as CalendarIcon, Grid, Share2, 
  ShieldCheck, Link as LinkIcon, AlertTriangle,
  Loader2, Filter, X
} from 'lucide-react';
import { 
  signInWithPopup, 
  signInAnonymously, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  onSnapshot,
  query, 
  where 
} from 'firebase/firestore';

import { auth, db, googleProvider } from './config/firebase';
import { STATUS } from './constants';
import Toast from './components/Toast';
import ConfirmModal from './components/ConfirmModal';
import PostCard from './components/PostCard';
import ReviewModal from './components/ReviewModal';
import SparkDeck from './components/SparkDeck';
import CalendarView from './components/CalendarView';
import Editor from './components/Editor';

// --- Error Boundary Component ---
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError(error) { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center border border-rose-100">
            <div className="w-12 h-12 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="text-rose-500" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h2>
            <p className="text-slate-500 mb-6">We encountered an unexpected error.</p>
            <button onClick={() => window.location.reload()} className="bg-slate-900 text-white px-6 py-2 rounded-lg font-bold">
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  // --- State ---
  const [user, setUser] = useState(null);
  const [posts, setPosts] = useState([]);
  const [mediaMap, setMediaMap] = useState({});
  const [view, setView] = useState('grid'); // 'grid', 'calendar', 'editor'
  
  // Filtering & Search
  const [filterClient, setFilterClient] = useState(null); 
  const [searchQuery, setSearchQuery] = useState('');     
  const [sidebarOpen, setSidebarOpen] = useState(false);  

  // UI States
  const [isLoading, setIsLoading] = useState(true);
  const [editingPost, setEditingPost] = useState(null);
  const [reviewingPost, setReviewingPost] = useState(null);
  const [isSparkDeckOpen, setIsSparkDeckOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);

  // Derived State (Read Only Mode)
  const sharedUid = new URLSearchParams(window.location.search).get('uid');
  const isReadOnly = !!sharedUid; 

  // --- 1. Auth Listener ---
  useEffect(() => {
    if (sharedUid) {
      signInAnonymously(auth).catch(err => console.error("Guest Auth Failed", err));
    }
    
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser && !sharedUid) {
        setIsLoading(false);
      }
    });
    return () => unsubscribe();
  }, [sharedUid]);

  // --- 2. Data Fetcher (Secure & Smart) ---
  useEffect(() => {
    if (!user && !sharedUid) return;

    setIsLoading(true);

    const targetUid = sharedUid || user?.uid;
    if (!targetUid) {
        setIsLoading(false);
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const clientParam = params.get('client');

    // 🔒 SECURITY: Guests MUST have a client param
    if (sharedUid && !clientParam) {
      console.warn("⛔ ACCESS DENIED: Missing client filter for guest.");
      setPosts([]); 
      setIsLoading(false);
      return; 
    }

    const constraints = [where('uid', '==', targetUid)];
    if (clientParam) {
      constraints.push(where('client', '==', clientParam));
      setFilterClient(clientParam);
    }

    const q = query(collection(db, 'posts'), ...constraints);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newPosts = snapshot.docs.map(doc => {
        const data = doc.data();
        
        // --- SAFE DATE PARSER ---
        const parseDate = (val) => {
          if (!val) return null;
          const d = new Date(val);
          return isNaN(d.getTime()) ? null : d; // Returns null if invalid
        };

        return {
          id: doc.id,
          ...data,
          scheduledDate: parseDate(data.scheduledDate),
          createdAt: parseDate(data.createdAt) || new Date()
        };
      });
      
      // Sort: Newest First (Safe sort handles nulls)
      newPosts.sort((a, b) => {
        const dateA = a.scheduledDate || a.createdAt;
        const dateB = b.scheduledDate || b.createdAt;
        return dateB - dateA;
      });
      
      setPosts(newPosts);
      
      // Update media map
      const newMedia = {};
      newPosts.forEach(p => { if (p.imageUrl) newMedia[p.imageUrl] = p.imageUrl; });
      setMediaMap(prev => ({ ...prev, ...newMedia }));

      setIsLoading(false);
    }, (error) => {
      console.error("🔥 Firestore Error:", error);
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, [user, sharedUid]);

  // --- 3. Dynamic Title ---
  useEffect(() => {
    if (isReadOnly) {
      const clientName = new URLSearchParams(window.location.search).get('client');
      document.title = clientName ? `${clientName} | Spool Review` : 'Spool Client View';
    } else {
      document.title = 'Spool | Creator Dashboard';
    }
  }, [isReadOnly]);

  // --- Helpers ---
  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleCopyLink = () => {
    if (!user) return;
    
    // ✅ FIX: Use href (split at the ?) to keep the /spool-social/ part of the URL
    const baseUrl = window.location.href.split('?')[0]; 
    
    let link = `${baseUrl}?uid=${user.uid}`;
    let message = "Master Link (All Clients) Copied! 📋";

    if (filterClient) {
      link += `&client=${encodeURIComponent(filterClient)}`;
      message = `Review Link for "${filterClient}" Copied! 📋`;
    }

    navigator.clipboard.writeText(link);
    showToast(message);
  };

  // --- CRUD Handlers ---
  const handleSavePost = async (formData) => {
    if (isReadOnly) return;
    try {
      // 1. Safe Date Conversion Helper
      const getSafeDateString = (val) => {
        if (!val) return null;
        if (typeof val === 'string') return val; // Already a string from the input
        if (val instanceof Date && !isNaN(val)) return val.toISOString(); // Valid Date object
        return null; // Invalid/Empty
      };

      // 2. Prepare Data
      const postData = { 
        ...formData, 
        uid: user.uid, 
        scheduledDate: getSafeDateString(formData.scheduledDate), 
        updatedAt: new Date().toISOString() 
      };
      
      // 3. Clean undefined fields (Firestore rejects them)
      Object.keys(postData).forEach(key => postData[key] === undefined && delete postData[key]);

      // 4. Save
      if (postData.id) {
        await updateDoc(doc(db, 'posts', postData.id), postData);
        showToast("Thread updated");
      } else {
        await addDoc(collection(db, 'posts'), { ...postData, createdAt: new Date().toISOString() });
        showToast("New thread created!");
      }
      
      setView('grid');
      setEditingPost(null);
    } catch (error) {
      console.error("Save Error:", error);
      showToast(`Save failed: ${error.message}`, "error");
    }
  };

  const handleDeleteClick = (postId) => {
    setConfirmModal({
      title: "Delete Thread?",
      message: "This action cannot be undone.",
      type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, 'posts', postId));
        setConfirmModal(null);
        showToast("Thread deleted.");
      }
    });
  };

  const handleStatusChange = async (postId, newStatus) => {
    try {
      await updateDoc(doc(db, 'posts', postId), { status: newStatus });
      showToast(`Status updated to ${newStatus}`);
    } catch (error) {
      showToast("Update failed", "error");
    }
  };
  
  const handleCloneToAll = async (post) => {
    const allClients = [...new Set(posts.map(p => p.client).filter(Boolean))];
    if (allClients.length === 0) return showToast("No other clients found.");
    
    let count = 0;
    for (const clientName of allClients) {
        if (clientName === post.client) continue; 
        const { id, ...cloneData } = post; // Remove ID
        await addDoc(collection(db, 'posts'), {
            ...cloneData,
            client: clientName,
            status: STATUS.DRAFT,
            createdAt: new Date().toISOString(),
            scheduledDate: post.scheduledDate instanceof Date ? post.scheduledDate.toISOString() : post.scheduledDate
        });
        count++;
    }
    showToast(`Cloned to ${count} clients!`);
  };

  // --- Filtering Logic ---
  const uniqueClients = useMemo(() => {
    return [...new Set(posts.map(p => p.client).filter(Boolean))].sort();
  }, [posts]);

  const filteredPosts = useMemo(() => {
    return posts.filter(post => {
      const matchesClient = filterClient ? post.client === filterClient : true;
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = 
        !searchQuery ||
        (post.content && post.content.toLowerCase().includes(searchLower)) ||
        (post.client && post.client.toLowerCase().includes(searchLower));

      return matchesClient && matchesSearch;
    });
  }, [posts, filterClient, searchQuery]);


  // --- Render ---

  if (!user && !sharedUid) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-sm w-full text-center">
          <div className="w-16 h-16 bg-indigo-600 rounded-xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-indigo-200">
             <Layout className="text-white" size={32} />
          </div>
          <h1 className="text-3xl font-black text-slate-900 mb-2">Spool</h1>
          <p className="text-slate-500 mb-8">Creative Workflow Management</p>
          <button 
            onClick={() => signInWithPopup(auth, googleProvider)}
            className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100 flex items-center justify-center gap-2"
          >
            <Layout size={20} /> Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (view === 'editor') {
    return (
      <Editor 
        post={editingPost} 
        onSave={handleSavePost} 
        onCancel={() => { setView('grid'); setEditingPost(null); }} 
        onOpenSparkDeck={() => setIsSparkDeckOpen(true)}
      />
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 flex">
        
        {/* --- SIDEBAR (Desktop) --- */}
        {!isReadOnly && (
          <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 transform transition-transform duration-200 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:static`}>
            <div className="p-6 h-full flex flex-col">
              {/* Sidebar Header with Branding */}
              <div className="flex flex-col mb-8">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                     <Layout className="text-white" size={18} />
                  </div>
                  <span className="font-black text-xl text-slate-900">Spool</span>
                </div>
                {/* ✅ BRANDING RESTORED */}
                <a 
                   href="https://stitchtec.com" 
                   target="_blank" 
                   rel="noopener noreferrer" 
                   className="text-[10px] font-bold text-slate-400 tracking-widest uppercase hover:text-indigo-600 mt-2 ml-1"
                >
                   by Stitch TEC
                </a>
              </div>

              {/* Navigation */}
              <div className="flex-1 overflow-y-auto">
                 <div className="mb-6">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Clients</h3>
                    <div className="space-y-1">
                        <button 
                          onClick={() => { setFilterClient(null); setSidebarOpen(false); }}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${!filterClient ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          All Clients
                        </button>
                        {uniqueClients.map(client => (
                          <button 
                            key={client}
                            onClick={() => { setFilterClient(client); setSidebarOpen(false); }}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${filterClient === client ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}
                          >
                            {client}
                          </button>
                        ))}
                    </div>
                 </div>
              </div>
            </div>
          </aside>
        )}

        {/* --- MAIN CONTENT --- */}
        <main className="flex-1 min-w-0 flex flex-col min-h-screen">
          
          <header className="bg-white border-b border-slate-200 sticky top-0 z-40 px-4 sm:px-6 h-16 flex items-center justify-between shadow-sm">
            
            <div className="flex items-center gap-3">
              {!isReadOnly && (
                <button onClick={() => setSidebarOpen(!sidebarOpen)} className="lg:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
                  <Menu size={24} />
                </button>
              )}
              
              {/* Mobile/Client Branding */}
              <div className={`flex flex-col leading-none ${!isReadOnly ? 'lg:hidden' : ''}`}>
                <h1 className="text-xl font-black text-slate-900">Spool</h1>
                <a href="https://stitchtec.com" target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold text-slate-400 tracking-widest uppercase hover:text-indigo-600">by Stitch TEC</a>
              </div>
            </div>

            <div className="flex-1 max-w-md mx-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input 
                  type="text"
                  placeholder="Search content..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              {!isReadOnly && (
                <div className="hidden sm:flex bg-slate-100 p-1 rounded-lg">
                  <button onClick={() => setView('grid')} className={`p-1.5 rounded-md ${view === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`} title="Grid View"><Grid size={18}/></button>
                  <button onClick={() => setView('calendar')} className={`p-1.5 rounded-md ${view === 'calendar' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`} title="Calendar View"><CalendarIcon size={18}/></button>
                </div>
              )}

              {!isReadOnly && (
                <button 
                  onClick={handleCopyLink} 
                  className="flex items-center gap-2 bg-indigo-50 text-indigo-700 border border-indigo-100 px-3 py-2 rounded-xl font-bold text-sm hover:bg-indigo-100 transition-all"
                  title="Copy Link for Client"
                >
                    <LinkIcon size={16} /> 
                    <span className="hidden sm:inline">{filterClient ? `${filterClient} Link` : 'Master Link'}</span>
                </button>
              )}

              {!isReadOnly && (
                <button onClick={() => setView('editor')} className="hidden sm:flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 hover:scale-105 transition-transform">
                  <Plus size={18} /> <span className="hidden md:inline">New</span>
                </button>
              )}
              
              <button 
                 onClick={() => { signOut(auth); window.location.reload(); }} 
                 className="p-2 text-slate-400 hover:text-rose-600 transition-colors"
                 title={isReadOnly ? "Exit View" : "Log Out"}
               >
                 <LogOut size={20} />
              </button>
            </div>
          </header>

          <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
             <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                  {view === 'calendar' ? 'Calendar' : (filterClient ? `${filterClient} Threads` : 'All Threads')}
                  {filterClient && !isReadOnly && (
                    <button onClick={() => setFilterClient(null)} className="text-slate-400 hover:text-rose-500"><X size={20}/></button>
                  )}
                </h2>
             </div>

             {isLoading ? (
               <div className="flex flex-col items-center justify-center h-64">
                 <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
                 <p className="text-slate-400 font-medium animate-pulse">Loading content...</p>
               </div>
             ) : (
               <>
                 {isReadOnly && !new URLSearchParams(window.location.search).get('client') ? (
                    <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
                        <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-4">
                          <ShieldCheck className="text-rose-400" size={32} />
                        </div>
                        <h3 className="text-slate-900 font-bold text-lg">Access Restricted</h3>
                        <p className="text-slate-500 mt-2">You must use a specific client link to view content.</p>
                    </div>
                 ) : (
                    <>
                       {view === 'calendar' ? (
                         // 🛡️ SAFE CALENDAR: Only show posts that actually have a date
                         <CalendarView 
                            posts={filteredPosts.filter(p => p.scheduledDate instanceof Date)} 
                            onPostClick={(p) => { if(isReadOnly) setReviewingPost(p); else { setEditingPost(p); setView('editor'); }}} 
                         />
                       ) : (
                         <>
                           {filteredPosts.length === 0 ? (
                             <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
                               <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4"><Grid className="text-slate-300" /></div>
                               <h3 className="text-slate-900 font-bold text-lg">No threads found</h3>
                               {!isReadOnly && <button onClick={() => setView('editor')} className="text-indigo-600 font-bold hover:underline">Create Thread</button>}
                             </div>
                           ) : (
                             <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                               {filteredPosts.map(p => (
                                 <PostCard 
                                   key={p.id} 
                                   post={p} 
                                   mediaMap={mediaMap} 
                                   isReadOnly={isReadOnly}
                                   onClick={() => { if (isReadOnly) setReviewingPost(p); else { setEditingPost(p); setView('editor'); } }} 
                                   onEdit={(p) => { setEditingPost(p); setView('editor'); }} 
                                   onCloneToAll={handleCloneToAll} 
                                   onDuplicate={(p) => handleSavePost({...p, id: undefined, status: STATUS.DRAFT})}
                                   onDelete={() => handleDeleteClick(p.id)} 
                                   onStatusChange={handleStatusChange}
                                 />
                               ))}
                             </div>
                           )}
                         </>
                       )}
                    </>
                 )}
               </>
             )}
          </div>

          <footer className="py-6 text-center border-t border-slate-200 bg-white">
            <p className="text-slate-400 text-[10px] font-bold tracking-widest uppercase">
              Powered by <a href="https://stitchtec.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800 transition-colors">Spool</a>
            </p>
          </footer>

        </main>
      </div>

      {confirmModal && <ConfirmModal {...confirmModal} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={()=>setToast(null)}/>}
      {isSparkDeckOpen && <SparkDeck onClose={() => setIsSparkDeckOpen(false)} onSelect={(txt) => { setEditingPost(prev => ({...prev, content: txt})); setIsSparkDeckOpen(false); }} />}
      {reviewingPost && (
        <ReviewModal 
           post={reviewingPost} 
           mediaMap={mediaMap}
           onClose={() => setReviewingPost(null)}
           onApprove={() => { handleStatusChange(reviewingPost.id, STATUS.SCHEDULED); setReviewingPost(null); }}
           onRequestChanges={(fb) => { updateDoc(doc(db, 'posts', reviewingPost.id), { feedback: fb, approvalStatus: 'changes_requested' }); showToast("Feedback sent!"); setReviewingPost(null); }}
        />
      )}
    </ErrorBoundary>
  );
};

export default App;