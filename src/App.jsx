import React, { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, useDeferredValue } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  writeBatch
} from 'firebase/firestore';

import { db } from './config/firebase';
import { STATUS, PLATFORMS, APPROVAL_STATUS, DEFAULT_CLIENT_SETTINGS } from './constants';
import { convertToCSV, parseImportFile, postsToJSON, downloadFile } from './utils/csv';
import useAuth from './hooks/useAuth';
import usePosts from './hooks/usePosts';
import useToast from './hooks/useToast';
import ErrorBoundary from './components/ErrorBoundary';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import DashboardHeader from './components/DashboardHeader';
import PostGrid from './components/PostGrid';
import StatusFilterChips from './components/StatusFilterChips';
import Toast from './components/Toast';
import ConfirmModal from './components/ConfirmModal';
import ReviewModal from './components/ReviewModal';
import CalendarView from './components/CalendarView';
import ClientSettingsModal from './components/ClientSettingsModal';
import MediaLibrary from './components/MediaLibrary';
import ImportModal from './components/ImportModal';

const Editor = lazy(() => import('./components/Editor'));

const App = () => {
  // --- Session & data ---
  const { toast, showToast, hideToast } = useToast();
  const { user, authLoading, sharedUid, isReadOnly, signIn, signOutAndExit } = useAuth(showToast);
  const { posts, clientMap, isLoading: postsLoading, error: postsError } = usePosts(user, sharedUid);
  const isLoading = authLoading || postsLoading;

  const clientParam = useMemo(
    () => new URLSearchParams(window.location.search).get('client'),
    []
  );

  // --- UI state ---
  const [view, setView] = useState('grid'); // 'grid' | 'calendar' | 'editor'
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [filterClient, setFilterClient] = useState(clientParam);
  const [filterStatus, setFilterStatus] = useState(null); // null | status | 'changes_requested'
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Deferred so the input stays responsive while filtering large lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [reviewingPost, setReviewingPost] = useState(null);
  const [isClientSettingsOpen, setIsClientSettingsOpen] = useState(false);
  const [isMediaOpen, setIsMediaOpen] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [importData, setImportData] = useState(null); // { posts, fileName } — drives the import-preview modal

  // 🛡️ SECURITY: Sync postsRef for guest authorization checks in callbacks.
  const postsRef = useRef([]);
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  // --- Dynamic Title ---
  useEffect(() => {
    if (isReadOnly) {
      document.title = clientParam ? `${clientParam} | Spool Review` : 'Spool Client View';
    } else {
      document.title = 'Spool | Creator Dashboard';
    }
  }, [isReadOnly, clientParam]);

  // --- Link sharing ---
  const handleCopyLink = useCallback(async () => {
    if (!user) return;

    const baseUrl = window.location.origin + window.location.pathname;

    let link = `${baseUrl}?uid=${user.uid}`;
    let message = "Master Link (All Clients) Copied! 📋";

    if (filterClient) {
      link += `&client=${encodeURIComponent(filterClient)}`;
      message = `Review Link for "${filterClient}" Copied! 📋`;
    }

    try {
      await navigator.clipboard.writeText(link);
      showToast(message);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      showToast("Couldn't copy — your browser blocked clipboard access", "error");
    }
  }, [filterClient, user, showToast]);

  // --- CRUD Handlers ---
  const handleSavePost = useCallback(async (formData) => {
    if (isReadOnly) return;

    // 🔒 SECURITY: Input Validation & Sanitization
    const client = (formData.client || "").trim().replace(/\//g, '').slice(0, 50);
    const content = (formData.content || "").trim();
    const platformId = formData.platform || 'gmb';
    const platform = PLATFORMS[platformId] || PLATFORMS.gmb;

    // Sanitize tags: max 10 tags, 20 chars each
    const tags = (formData.tags || [])
      .slice(0, 10)
      .map(tag => String(tag).trim().slice(0, 20))
      .filter(Boolean);

    if (!client) return showToast("Client name is required", "error");
    if (!content) return showToast("Content cannot be empty", "error");
    if (content.length > platform.maxChars) {
      return showToast(`Content exceeds ${platform.name} limit (${platform.maxChars} chars)`, "error");
    }

    try {
      // Safe Date Conversion Helper
      const getSafeDateString = (val) => {
        if (!val) return null;
        if (typeof val === 'string') return val; // Already a string from the input
        if (val instanceof Date && !isNaN(val)) return val.toISOString(); // Valid Date object
        return null; // Invalid/Empty
      };

      // 🔒 EXPLICIT MAPPING to prevent mass assignment
      const status = Object.values(STATUS).includes(formData.status) ? formData.status : STATUS.DRAFT;
      const approvalStatus = Object.values(APPROVAL_STATUS).includes(formData.approvalStatus) ? formData.approvalStatus : APPROVAL_STATUS.PENDING;

      const postData = {
        client,
        content,
        title: (formData.title || "").trim().slice(0, 200),
        altText: (formData.altText || "").trim().slice(0, 300),
        metaDescription: (formData.metaDescription || "").trim().slice(0, 200),
        slug: (formData.title || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
        platform: platformId,
        status,
        approvalStatus,
        feedback: (formData.feedback || "").trim().slice(0, 500),
        imageUrl: (formData.imageUrl || '').slice(0, 500000),
        tags,
        uid: user.uid,
        scheduledDate: getSafeDateString(formData.scheduledDate),
        updatedAt: new Date().toISOString()
      };

      if (formData.id) {
        await updateDoc(doc(db, 'posts', formData.id), postData);
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
  }, [isReadOnly, user, showToast]);

  // Delete immediately with an Undo toast (less friction than a confirm modal,
  // but still recoverable). Undo re-creates the doc with explicit field mapping.
  const handleDeleteClick = useCallback(async (postId) => {
    if (isReadOnly || !user) return;
    const post = postsRef.current.find(p => p.id === postId);
    if (!post) return;

    try {
      await deleteDoc(doc(db, 'posts', postId));
      showToast("Thread deleted", "success", {
        label: "Undo",
        onClick: async () => {
          try {
            await addDoc(collection(db, 'posts'), {
              uid: user.uid,
              client: post.client || '',
              content: post.content || '',
              title: (post.title || '').slice(0, 200),
              altText: (post.altText || '').slice(0, 300),
              platform: post.platform || 'gmb',
              status: Object.values(STATUS).includes(post.status) ? post.status : STATUS.DRAFT,
              approvalStatus: Object.values(APPROVAL_STATUS).includes(post.approvalStatus) ? post.approvalStatus : APPROVAL_STATUS.PENDING,
              feedback: (post.feedback || '').slice(0, 500),
              imageUrl: (post.imageUrl || '').slice(0, 500000),
              tags: post.tags || [],
              scheduledDate: post._raw_scheduledDate || null,
              createdAt: post._raw_createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            showToast("Thread restored");
          } catch (error) {
            console.error("Undo Error:", error);
            showToast("Couldn't restore thread", "error");
          }
        }
      });
    } catch (error) {
      console.error("Delete Error:", error);
      showToast("Delete failed", "error");
    }
  }, [isReadOnly, user, showToast]);

  const handleArchivePost = useCallback(async (postId) => {
    if (isReadOnly) return;
    try {
      await updateDoc(doc(db, 'posts', postId), { status: STATUS.ARCHIVED });
      showToast("Thread archived");
    } catch {
      showToast("Archive failed", "error");
    }
  }, [isReadOnly, showToast]);

  const handleRestorePost = useCallback(async (postId) => {
    if (isReadOnly) return;
    try {
      await updateDoc(doc(db, 'posts', postId), { status: STATUS.DRAFT });
      showToast("Thread restored to drafts");
    } catch {
      showToast("Restore failed", "error");
    }
  }, [isReadOnly, showToast]);

  const handleStatusChange = useCallback(async (postId, newStatus) => {
    // 🔒 SECURITY: Validate status enum
    if (!Object.values(STATUS).includes(newStatus)) return;

    // 🔒 SECURITY: Guests can ONLY approve (status -> scheduled)
    const isApproving = newStatus === STATUS.SCHEDULED;
    if (isReadOnly) {
      if (!isApproving) return;
      // 🛡️ DEFENSE-IN-DEPTH: Verify postId belongs to the guest's view
      if (!postsRef.current.some(p => p.id === postId)) {
        console.warn("⛔ ACCESS DENIED: Post not in guest view.");
        return;
      }
    }

    try {
      await updateDoc(doc(db, 'posts', postId), {
        status: newStatus,
        ...(isApproving ? { approvalStatus: APPROVAL_STATUS.APPROVED } : {})
      });
      showToast(`Status updated to ${newStatus}`);
    } catch {
      showToast("Update failed", "error");
    }
  }, [isReadOnly, showToast]);

  // Parse a CSV/JSON file and open the preview modal — nothing is written until
  // the user confirms (see handleConfirmImport). parseImportFile normalizes &
  // sanitizes every row (single source of truth for field mapping).
  const handleImportFile = useCallback((e) => {
    if (isReadOnly) return;
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = parseImportFile(event.target.result, file.name);
        setImportData({ posts: parsed, fileName: file.name });
      } catch (err) {
        console.error("Import parse error:", err);
        showToast("Couldn't read that file — use a Spool CSV or JSON export", "error");
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset input so re-selecting the same file fires again
  }, [isReadOnly, showToast]);

  // Commit the previewed rows. Rows are already sanitized by parseImportFile;
  // here we only attach ownership/timestamps and chunk to the 500-op batch cap.
  const handleConfirmImport = useCallback(async (rows) => {
    if (isReadOnly || !user || !rows?.length) { setImportData(null); return; }
    try {
      const now = new Date().toISOString();
      const CHUNK = 450; // Firestore writeBatch hard limit is 500 ops
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = writeBatch(db);
        rows.slice(i, i + CHUNK).forEach(item => {
          batch.set(doc(collection(db, 'posts')), {
            uid: user.uid,
            client: item.client,
            content: item.content,
            title: item.title || '',
            altText: item.altText || '',
            metaDescription: item.metaDescription || '',
            slug: item.slug || '',
            platform: item.platform,
            status: item.status,
            approvalStatus: item.approvalStatus,
            feedback: item.feedback || '',
            imageUrl: item.imageUrl || '',
            tags: item.tags || [],
            scheduledDate: item.scheduledDate || null,
            createdAt: now,
            updatedAt: now,
            source: 'import'
          });
        });
        await batch.commit();
      }
      showToast(`Imported ${rows.length} thread${rows.length === 1 ? '' : 's'}! 🚀`);
    } catch (err) {
      console.error("Import error:", err);
      showToast("Import failed. Please try again.", "error");
    } finally {
      setImportData(null);
    }
  }, [isReadOnly, user, showToast]);

  const handleRequestChanges = useCallback(async (postId, feedback) => {
    // 🔒 SECURITY: Input Validation & Sanitization
    const sanitizedFeedback = (feedback || "").trim().slice(0, 500);
    if (!sanitizedFeedback) return showToast("Feedback cannot be empty", "error");

    // 🛡️ DEFENSE-IN-DEPTH: Verify postId belongs to the guest's view
    if (isReadOnly && !postsRef.current.some(p => p.id === postId)) {
      console.warn("⛔ ACCESS DENIED: Post not in guest view.");
      return;
    }

    try {
      await updateDoc(doc(db, 'posts', postId), {
        feedback: sanitizedFeedback,
        approvalStatus: APPROVAL_STATUS.CHANGES_REQUESTED
      });
      showToast("Feedback sent!");
      setReviewingPost(null);
    } catch (error) {
      console.error("Feedback Error:", error);
      showToast("Failed to send feedback", "error");
    }
  }, [isReadOnly, showToast]);

  // --- Derived data ---
  // ⚡ Stabilize uniqueClients reference: derive from a hash string that only
  // changes when the set of clients actually changes. Null-char separator
  // handles names containing commas.
  const clientsHash = useMemo(() => {
    return [...new Set(posts.map(p => p.client).filter(Boolean))].sort().join('\0');
  }, [posts]);

  const uniqueClients = useMemo(() => {
    return clientsHash ? clientsHash.split('\0') : [];
  }, [clientsHash]);

  const handleCloneToAll = useCallback((post) => {
    if (isReadOnly) return;

    const targetClients = uniqueClients.filter(c => c !== post.client);
    if (targetClients.length === 0) return showToast("No other clients found.");

    setConfirmModal({
      title: "Blast: Clone to All Clients?",
      message: `This will create a draft of this thread for ${targetClients.length} other clients.`,
      onConfirm: async () => {
        try {
          const batch = writeBatch(db);
          targetClients.forEach(clientName => {
            const newDocRef = doc(collection(db, 'posts'));

            batch.set(newDocRef, {
              uid: user.uid,
              client: String(clientName).replace(/\//g, '').slice(0, 50),
              content: post.content || "",
              title: (post.title || '').slice(0, 200),
              altText: (post.altText || '').slice(0, 300),
              platform: post.platform || 'gmb',
              status: STATUS.DRAFT,
              approvalStatus: APPROVAL_STATUS.PENDING,
              feedback: "",
              imageUrl: (post.imageUrl || '').slice(0, 500000),
              tags: post.tags || [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              scheduledDate: post.scheduledDate instanceof Date ? post.scheduledDate.toISOString() : post.scheduledDate
            });
          });
          await batch.commit();
          showToast(`Cloned to ${targetClients.length} clients! 🚀`);
          setConfirmModal(null);
        } catch (error) {
          console.error("Clone Error:", error);
          showToast("Cloning failed", "error");
        }
      }
    });
  }, [isReadOnly, uniqueClients, showToast, user]);

  const handleSelectPost = useCallback((p) => {
    if (isReadOnly) {
      setReviewingPost(p);
    } else {
      setEditingPost(p);
      setView('editor');
    }
  }, [isReadOnly]);

  const handleDuplicatePost = useCallback((p) => {
    // Reset review state — a copy of an approved post is a fresh draft,
    // and inherited client feedback wouldn't apply to it.
    handleSavePost({
      ...p,
      id: undefined,
      status: STATUS.DRAFT,
      approvalStatus: APPROVAL_STATUS.PENDING,
      feedback: ''
    });
  }, [handleSavePost]);

  // Batch-create draft posts (used by "Repurpose blog → social"). Returns count.
  const handleCreateDrafts = useCallback(async (drafts) => {
    if (isReadOnly || !user) return 0;
    const valid = (drafts || []).filter(d => d && d.content && PLATFORMS[d.platform]);
    if (valid.length === 0) return 0;

    const batch = writeBatch(db);
    valid.forEach(d => {
      const platform = PLATFORMS[d.platform] || PLATFORMS.gmb;
      const ref = doc(collection(db, 'posts'));
      batch.set(ref, {
        uid: user.uid,
        client: (d.client || '').trim().replace(/\//g, '').slice(0, 50),
        content: (d.content || '').trim().slice(0, platform.maxChars),
        title: '',
        platform: d.platform,
        status: STATUS.DRAFT,
        approvalStatus: APPROVAL_STATUS.PENDING,
        feedback: '',
        imageUrl: '',
        tags: [],
        scheduledDate: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    await batch.commit();
    return valid.length;
  }, [isReadOnly, user]);

  // Client/archive/search filters (status chips applied separately so chip
  // counts always reflect the current context).
  const baseFilteredPosts = useMemo(() => {
    const searchLower = deferredSearchQuery.toLowerCase();

    return posts.filter(post => {
      const matchesClient = filterClient ? post.client === filterClient : true;
      const matchesArchive = showArchived ? post.status === STATUS.ARCHIVED : post.status !== STATUS.ARCHIVED;
      const matchesSearch =
        !searchLower ||
        post._searchContent?.includes(searchLower) ||
        post._searchClient?.includes(searchLower);

      return matchesClient && matchesArchive && matchesSearch;
    });
  }, [posts, filterClient, showArchived, deferredSearchQuery]);

  const statusCounts = useMemo(() => {
    const counts = {
      all: baseFilteredPosts.length,
      [STATUS.DRAFT]: 0,
      [STATUS.SCHEDULED]: 0,
      [STATUS.POSTED]: 0,
      [APPROVAL_STATUS.CHANGES_REQUESTED]: 0
    };
    baseFilteredPosts.forEach(p => {
      if (counts[p.status] !== undefined) counts[p.status]++;
      if (p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) counts[APPROVAL_STATUS.CHANGES_REQUESTED]++;
    });
    return counts;
  }, [baseFilteredPosts]);

  const filteredPosts = useMemo(() => {
    if (!filterStatus) return baseFilteredPosts;
    if (filterStatus === APPROVAL_STATUS.CHANGES_REQUESTED) {
      return baseFilteredPosts.filter(p => p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED);
    }
    return baseFilteredPosts.filter(p => p.status === filterStatus);
  }, [baseFilteredPosts, filterStatus]);

  const calendarPosts = useMemo(() => {
    if (view !== 'calendar') return [];
    return filteredPosts.filter(p => p.scheduledDate instanceof Date);
  }, [filteredPosts, view]);

  const handleExport = useCallback((mode, format = 'csv') => {
    let exportPosts = [];
    if (mode === 'current') exportPosts = filteredPosts;
    else if (mode === 'archived') exportPosts = posts.filter(p => p.status === STATUS.ARCHIVED);
    else exportPosts = posts;

    if (exportPosts.length === 0) return showToast("Nothing to export", "error");

    const date = new Date().toISOString().split('T')[0];
    if (format === 'json') {
      downloadFile(postsToJSON(exportPosts), `spool-backup-${mode}-${date}.json`, 'application/json');
    } else {
      downloadFile(convertToCSV(exportPosts), `spool-export-${mode}-${date}.csv`, 'text/csv;charset=utf-8;');
    }
    showToast(`Exported ${exportPosts.length} thread${exportPosts.length === 1 ? '' : 's'} 📥`);
  }, [posts, filteredPosts, showToast]);

  // --- Render ---

  if (!user && !sharedUid) {
    return <LoginScreen onSignIn={signIn} />;
  }

  if (view === 'editor') {
    return (
      <ErrorBoundary>
        {/* ⚡ Lazy-loaded Editor keeps the initial dashboard bundle small. */}
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center h-screen bg-white">
            <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
            <p className="text-slate-400 font-medium animate-pulse">Loading Editor...</p>
          </div>
        }>
          <Editor
            post={editingPost}
            isReadOnly={isReadOnly}
            clientMap={clientMap}
            uniqueClients={uniqueClients}
            showToast={showToast}
            onSave={handleSavePost}
            onCreateDrafts={handleCreateDrafts}
            onCancel={() => { setView('grid'); setEditingPost(null); }}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 flex">

        {!isReadOnly && (
          <Sidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            showArchived={showArchived}
            onShowArchived={(v) => { setShowArchived(v); setFilterStatus(null); }}
            filterClient={filterClient}
            onFilterClient={setFilterClient}
            uniqueClients={uniqueClients}
            onOpenClientSettings={() => setIsClientSettingsOpen(true)}
            onOpenMedia={() => setIsMediaOpen(true)}
            onImport={handleImportFile}
            onExport={handleExport}
          />
        )}

        <main className="flex-1 min-w-0 flex flex-col min-h-screen">

          <DashboardHeader
            isReadOnly={isReadOnly}
            view={view}
            onViewChange={setView}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onToggleSidebar={() => setSidebarOpen(o => !o)}
            linkCopied={linkCopied}
            onCopyLink={handleCopyLink}
            filterClient={filterClient}
            onNew={() => setView('editor')}
            onSignOut={signOutAndExit}
          />

          {postsError && (
            <div className="bg-rose-50 border-b border-rose-100 px-4 sm:px-6 py-2 text-sm text-rose-700 font-medium text-center" role="alert">
              Connection issue — live updates may be delayed. Retrying automatically…
            </div>
          )}

          <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                {view === 'calendar' ? 'Calendar' : (filterClient ? `${filterClient} Threads` : 'All Threads')}
                {filterClient && !isReadOnly && (
                  <button onClick={() => setFilterClient(null)} title="Clear Filter" aria-label="Clear Filter" className="text-slate-400 hover:text-rose-500"><X size={20}/></button>
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
                {isReadOnly && !clientParam ? (
                  <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
                    <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <ShieldCheck className="text-rose-400" size={32} />
                    </div>
                    <h3 className="text-slate-900 font-bold text-lg">Access Restricted</h3>
                    <p className="text-slate-500 mt-2">You must use a specific client link to view content.</p>
                  </div>
                ) : view === 'calendar' ? (
                  <CalendarView
                    posts={calendarPosts}
                    currentDate={currentDate}
                    onDateChange={setCurrentDate}
                    onEdit={handleSelectPost}
                  />
                ) : (
                  <>
                  {!showArchived && (
                    <StatusFilterChips value={filterStatus} onChange={setFilterStatus} counts={statusCounts} />
                  )}
                  <PostGrid
                    posts={filteredPosts}
                    clientMap={clientMap}
                    isReadOnly={isReadOnly}
                    onEdit={handleSelectPost}
                    onCloneToAll={handleCloneToAll}
                    onDuplicate={handleDuplicatePost}
                    onDelete={handleDeleteClick}
                    onStatusChange={handleStatusChange}
                    onArchive={handleArchivePost}
                    onRestore={handleRestorePost}
                    onCreate={() => setView('editor')}
                  />
                  </>
                )}
              </>
            )}
          </div>

          <footer className="py-6 text-center border-t border-slate-200 bg-white">
            <p className="text-slate-400 text-[10px] font-bold tracking-widest uppercase">
              Powered by <a href="https://stitchtec.dev" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800 transition-colors">Spool</a>
            </p>
          </footer>

        </main>
      </div>

      {confirmModal && (
        <ConfirmModal
          {...confirmModal}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {toast && <Toast message={toast.message} type={toast.type} action={toast.action} onClose={hideToast}/>}
      {reviewingPost && (
        <ReviewModal
          post={reviewingPost}
          clientSettings={clientMap[reviewingPost.client] || DEFAULT_CLIENT_SETTINGS}
          onClose={() => setReviewingPost(null)}
          onApprove={() => { handleStatusChange(reviewingPost.id, STATUS.SCHEDULED); setReviewingPost(null); }}
          onRequestChanges={(fb) => handleRequestChanges(reviewingPost.id, fb)}
        />
      )}
      {isClientSettingsOpen && (
        <ClientSettingsModal onClose={() => setIsClientSettingsOpen(false)} uniqueClients={uniqueClients} clientMap={clientMap} uid={user?.uid} isReadOnly={isReadOnly} />
      )}
      {isMediaOpen && (
        <MediaLibrary
          onClose={() => setIsMediaOpen(false)}
          uniqueClients={uniqueClients}
          initialClient={filterClient || ''}
          showToast={showToast}
        />
      )}
      {importData && (
        <ImportModal
          posts={importData.posts}
          existingPosts={posts}
          fileName={importData.fileName}
          onConfirm={handleConfirmImport}
          onCancel={() => setImportData(null)}
        />
      )}
    </ErrorBoundary>
  );
};

export default App;
