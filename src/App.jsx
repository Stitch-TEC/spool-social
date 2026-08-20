import React, { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, useDeferredValue } from 'react';
import { Loader2, ShieldCheck, X, CheckSquare, Files, Plus, Lightbulb } from 'lucide-react';
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  doc,
  writeBatch,
  arrayUnion
} from 'firebase/firestore';

import { db } from './config/firebase';
import {
  STATUS, PLATFORMS, APPROVAL_STATUS, DEFAULT_CLIENT_SETTINGS, TEMPLATE_LIMIT_PER_CLIENT,
  REVIEW_STAGE, REVIEW_STATE, MEDIA_FILTER, NEEDS_FILTER, DENSITY, DENSITY_VALUES
} from './constants';
import { reviewStageOf, isStaged, reviewStateOf, hasFeedback } from './utils/review';
import { needsImage, hasBlockers, isOverdue, readinessOf, READINESS_LABELS } from './utils/readiness';
import { convertToCSV, postsToJSON, downloadFile } from './utils/csv';
import { ensureHostedImage, pushToSender, publishToSite } from './utils/generationApi';
import useAuth from './hooks/useAuth';
import usePosts from './hooks/usePosts';
import useToast from './hooks/useToast';
import ErrorBoundary from './components/ErrorBoundary';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import DashboardHeader from './components/DashboardHeader';
import BrandFooter from './components/BrandFooter';
import PostGrid from './components/PostGrid';
import FilterBar, { SUGGESTIONS_LANE } from './components/FilterBar';
import DensityToggle from './components/DensityToggle';
import Toast from './components/Toast';
import FeedbackWidget from './components/FeedbackWidget';
import ConfirmModal from './components/ConfirmModal';
import ReviewModal from './components/ReviewModal';
import { sortPosts, SORT_ORDERS } from './utils/helpers';
import { twitterLength } from './utils/markdownEditing';
import { useClients } from './hooks/useClients';
import BulkActionBar from './components/BulkActionBar';
import { OPERATOR_UID, slugifyClientId } from './config/roles';

// ⚡ Everything below opens on demand (a modal, or the non-default view). Keeping
// them out of the entry chunk is what makes the dashboard's first paint cheap —
// AdminPanel/AutomationsPanel/MediaLibrary/ImportExportModal alone are ~1.3k lines
// the operator may never open in a session.
const Editor = lazy(() => import('./components/Editor'));
const CalendarView = lazy(() => import('./components/CalendarView'));
const ClientSettingsModal = lazy(() => import('./components/ClientSettingsModal'));
const MediaLibrary = lazy(() => import('./components/MediaLibrary'));
const ImportExportModal = lazy(() => import('./components/ImportExportModal'));
const ShareManager = lazy(() => import('./components/ShareManager'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const AutomationsPanel = lazy(() => import('./components/AutomationsPanel'));

// Suspense fallback for the lazily-loaded modals — a modal-shaped shimmer beats a
// blank screen while its chunk lands.
const ModalFallback = () => (
  <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[70] flex items-center justify-center" role="status" aria-label="Loading">
    <Loader2 className="w-8 h-8 text-white animate-spin" />
  </div>
);

// Case/whitespace-insensitive key for roster display-name lookups (rename drift is usually
// casing/spacing: "OMNI  nde" must still find "OMNI NDE"'s canonical slug).
const normClientName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Stable empty list: a fresh [] per render would give every non-operator session a
// new identity each pass and cascade through the memo chain the file relies on.
const EMPTY_POSTS = Object.freeze([]);

// Feed density belongs to the PERSON scanning, not to the workspace's data — so it
// lives in localStorage, not Firestore: no write path, no tenant question, and an
// operator who works in list mode gets list mode again tomorrow. Every access is
// guarded because a Safari private window throws on localStorage, and a view
// preference must never be able to take the dashboard down with it.
const DENSITY_KEY = 'spool.feedDensity';
const readStoredDensity = () => {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return DENSITY_VALUES.includes(v) ? v : DENSITY.CARDS;
  } catch {
    return DENSITY.CARDS;
  }
};

const App = () => {
  // --- Session & data ---
  const { toast, showToast, hideToast } = useToast();
  const { user, authLoading, sharedUid, shareClient, shareClientId, isReadOnly, shareError, authzError, role, clientId: myClientId, isOperator, isClientMember, signIn, signOutAndExit } = useAuth(showToast);
  const { posts, clientMap, isLoading: postsLoading, error: postsError, isStalled: postsStalled } = usePosts(user, sharedUid, myClientId, shareClientId, isOperator);
  const isLoading = authLoading || postsLoading;

  // Canonical POM roster — the ONE fetch (see useClients). Operator-gated: the Worker's
  // /api/clients 403s anyone else, and a client member's writes are pinned to myClientId anyway,
  // so for them the roster stays empty and every consumer fails open to legacy behavior.
  // Feeds the clientIdFor ladder below AND AdminPanel's picker (via props).
  const { clients: rosterClients, loading: rosterLoading } = useClients(isOperator);

  const clientParam = useMemo(
    () => new URLSearchParams(window.location.search).get('client'),
    []
  );

  // --- UI state ---
  const [view, setView] = useState('grid'); // 'grid' | 'calendar' | 'editor'
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [filterClient, setFilterClient] = useState(clientParam);
  // The PRIMARY axis: where a post sits in the client review loop (see utils/review.js).
  // null = all · REVIEW_STATE value · 'suggestions' (the operator-only parked lane).
  const [filterReview, setFilterReview] = useState(null);
  // The workflow axis, now genuinely separate from review state: null | draft | scheduled | posted.
  const [filterStatus, setFilterStatus] = useState(null);
  const [filterPlatform, setFilterPlatform] = useState(null); // null | platform id
  const [filterTag, setFilterTag] = useState(null); // null | tag string
  const [filterMedia, setFilterMedia] = useState(null); // null | MEDIA_FILTER value
  const [filterNeeds, setFilterNeeds] = useState(null); // null | NEEDS_FILTER value
  // Default: what's coming up soonest sits at the top (the next thing to handle).
  const [sortBy, setSortBy] = useState(SORT_ORDERS.SCHEDULED_ASC); // grid sort order
  // How much of each post the feed shows (cards | compact | list) — see constants.DENSITY.
  const [density, setDensityState] = useState(readStoredDensity);
  const [showArchived, setShowArchived] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false); // Templates (evergreen) view
  const [searchQuery, setSearchQuery] = useState('');
  // Deferred so the input stays responsive while filtering large lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [reviewingPost, setReviewingPost] = useState(null);
  const [isClientSettingsOpen, setIsClientSettingsOpen] = useState(false);
  const [isMediaOpen, setIsMediaOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isAutomationsOpen, setIsAutomationsOpen] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  const [isDataOpen, setIsDataOpen] = useState(false); // Import & Export modal
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Session-level dismissal for the "N suggestions parked" nudge — so it isn't naggy, but returns
  // next session (and the Suggestions chip stays as the always-available entry point regardless).
  const [suggestionsBannerDismissed, setSuggestionsBannerDismissed] = useState(false);

  // Coarse clock for the time-dependent facets (overdue, "waiting N days"). Ticked
  // every 5 minutes rather than read inline, so those readouts can't go stale on a
  // tab left open — and so the filter memo has an explicit, honest dependency
  // instead of a hidden Date.now() that React can't invalidate.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // 🛡️ SECURITY: Sync postsRef for guest authorization checks in callbacks.
  const postsRef = useRef([]);
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  // --- Client identity (declared before the CRUD handlers that depend on it) ---
  // Stable display-name → clientId map (clientId is the immutable tenant key,
  // backfilled onto posts). Used to stamp clientId on writes and to bind a
  // review link to the right client. Falls back to a slug for brand-new names.
  // ⚡ Same hash-stabilization trick as uniqueClients below: `posts` gets a new
  // array identity on every snapshot, but the name→id pairs rarely change. Keying
  // the map off a content hash keeps clientIdByName (and everything downstream —
  // clientIdFor → the CRUD callbacks → every memoized PostCard) referentially stable.
  const clientIdPairsHash = useMemo(() => {
    const seen = new Map();
    for (const p of posts) if (p.client && p.clientId && !seen.has(p.client)) seen.set(p.client, p.clientId);
    return [...seen.entries()].map(([n, id]) => `${n}\u0000${id}`).sort().join('\u0001');
  }, [posts]);
  const clientIdByName = useMemo(() => {
    const m = {};
    if (clientIdPairsHash) {
      for (const pair of clientIdPairsHash.split('\u0001')) {
        const [n, id] = pair.split('\u0000');
        m[n] = id;
      }
    }
    return m;
  }, [clientIdPairsHash]);
  // Roster display-name → slug map (normalized keys) + the set of slugs the roster actually
  // issued. Both empty whenever the roster is unavailable (client member, fetch failed, not
  // loaded yet) — the ladder below then degrades to exactly the pre-roster behavior, so
  // drafting never blocks on the roster. COLLISION guard: when two DISTINCT roster slugs
  // claim the same normalized name, name-resolution is REFUSED for that key (deleted from
  // the map, so the ladder falls through to stamped/slugify) — minting a fresh slug is the
  // lesser evil vs silently stamping the wrong tenant. Non-colliding names are unaffected.
  const rosterSlugByName = useMemo(() => {
    const m = new Map();
    const dupes = new Set();
    for (const c of rosterClients) {
      const key = normClientName(c?.name);
      if (!key || !c?.slug) continue;
      const prev = m.get(key);
      if (prev === undefined) m.set(key, c.slug);
      else if (prev !== c.slug) dupes.add(key); // same slug twice = duplicate row, not a collision
    }
    for (const key of dupes) m.delete(key);
    return m;
  }, [rosterClients]);
  const rosterSlugs = useMemo(() => {
    const s = new Set();
    for (const c of rosterClients) if (c?.slug) s.add(c.slug);
    return s;
  }, [rosterClients]);

  // Canonical clientId resolution ladder (roster-aware, fail-open):
  //   1. stamped posts-derived map — but ONLY when the roster issued that id (or the roster is
  //      empty/unavailable and can't vouch either way). A pre-roster phantom mint must NOT
  //      out-rank the canonical slug: this map is fed newest-post-first, so an unconditional
  //      stamped-wins re-minted the phantom on every save FOREVER for any client whose slug
  //      diverges from slugify(name), and the slug-keyed drafts join then hid those drafts
  //      from POM. Mirrors the worker POST /api/drafts roster repair.
  //   2. ROSTER match by normalized display name — a first-time/drifted/phantom-stamped name
  //      resolves to the client's canonical suite slug instead of the phantom;
  //   3. the stamped id anyway — off-roster with NO roster name match (drift beyond
  //      normalization): keep the tenant consolidated on its one existing key rather than
  //      minting a second;
  //   4. slugifyClientId(name) — the LAST-resort legacy mint, kept so resolution never blocks
  //      when the roster is empty/unavailable.
  const clientIdFor = useCallback(
    (name) => {
      const stamped = clientIdByName[name];
      if (stamped && (rosterSlugs.size === 0 || rosterSlugs.has(stamped))) return stamped;
      return rosterSlugByName.get(normClientName(name)) || stamped || slugifyClientId(name);
    },
    [clientIdByName, rosterSlugs, rosterSlugByName]
  );

  // For a client member: their single client's display name (branding doc, else
  // an existing post, else the clientId itself). Their writes are pinned to this.
  const myClientName = useMemo(() => {
    if (!isClientMember) return null;
    const fromBranding = Object.values(clientMap).find(c => c?.clientId === myClientId)?.name;
    const fromPosts = posts.find(p => p.clientId === myClientId)?.client;
    return fromBranding || fromPosts || myClientId;
  }, [isClientMember, myClientId, clientMap, posts]);

  // Selection only makes sense in the grid — drop it when switching views.
  useEffect(() => {
    if (view !== 'grid') { setSelectionMode(false); setSelectedIds(new Set()); }
  }, [view]);

  // --- Dynamic Title ---
  useEffect(() => {
    if (isReadOnly) {
      document.title = shareClient ? `${shareClient} Review | Spool | Stitch TEC` : 'Client Review | Spool | Stitch TEC';
    } else {
      document.title = 'Creator Dashboard | Spool | Stitch TEC';
    }
  }, [isReadOnly, shareClient]);

  // --- Link sharing ---
  // Opens the Share Manager (create/copy/revoke per-client review links).
  const handleOpenShare = useCallback(() => {
    if (!user || isReadOnly) return;
    setIsShareOpen(true);
  }, [user, isReadOnly]);

  // --- CRUD Handlers ---
  const handleSavePost = useCallback(async (formData) => {
    if (isReadOnly) return false;

    // 🔒 SECURITY: Input Validation & Sanitization. A client member can only
    // write to their OWN client (pinned); the operator picks the client. On a
    // member EDIT, reuse the post's stored `client` so it can't drift from
    // resource.data.client (the posts update rule requires that field unchanged,
    // and the branding display name may differ from the stored value).
    const existingPost = formData.id ? postsRef.current.find(p => p.id === formData.id) : null;
    const client = isClientMember
      ? (existingPost ? existingPost.client : (myClientName || myClientId))
      : (formData.client || "").trim().replace(/\//g, '').slice(0, 50);
    const content = (formData.content || "").trim();
    const platformId = formData.platform || 'gmb';
    const platform = PLATFORMS[platformId] || PLATFORMS.gmb;

    // Sanitize tags: max 10 tags, 20 chars each
    const tags = (formData.tags || [])
      .slice(0, 10)
      .map(tag => String(tag).trim().slice(0, 20))
      .filter(Boolean);

    // Returns true only on a real write — the Editor keeps its local autosave
    // safety net alive until then (validation failures toast and return false).
    if (!client) { showToast("Client name is required", "error"); return false; }
    if (!content) { showToast("Content cannot be empty", "error"); return false; }
    // X/Twitter enforces its WEIGHTED count (URLs = 23, emoji/CJK = 2) — the
    // same measure the Editor's counter shows — not the raw string length.
    const effectiveLength = platformId === 'twitter' ? twitterLength(content) : content.length;
    if (effectiveLength > platform.maxChars) {
      showToast(`Content exceeds ${platform.name} limit (${platform.maxChars} chars)`, "error");
      return false;
    }

    // Evergreen cap: block a NEW template (or flipping an existing post into one)
    // once this client is at the per-client limit. Editing a post that's ALREADY
    // a template is always fine — it's already counted.
    if (formData.isTemplate && !existingPost?.isTemplate) {
      const templateCount = postsRef.current.filter(p => p.isTemplate && p.client === client).length;
      if (templateCount >= TEMPLATE_LIMIT_PER_CLIENT) {
        showToast(`Template limit reached (${TEMPLATE_LIMIT_PER_CLIENT}) for ${client}. Delete one to add another.`, "error");
        return false;
      }
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
      const title = (formData.title || "").trim().slice(0, 200);

      // approvalStatus + feedback belong to the CLIENT — they are never authored in
      // the editor, and formData is a snapshot taken when the editor OPENED. Writing
      // them back therefore silently reverted any review that landed in the meantime:
      // a client approval, or a reviewer note from POM, quietly undone by an unrelated
      // typo fix. Read them from the LIVE post instead (postsRef tracks the snapshot).
      const liveApproval = Object.values(APPROVAL_STATUS).includes(existingPost?.approvalStatus)
        ? existingPost.approvalStatus
        : APPROVAL_STATUS.PENDING;

      // An APPROVED post that gets rewritten is no longer the post the client approved.
      // Both downstream gates — publish-to-site and push-to-Sender — admit anything
      // marked `approved`, so carrying the approval across a rewrite walked unreviewed
      // copy straight through the check that exists to prevent exactly that.
      const rewritten = !!existingPost && (
        (existingPost.content || '') !== content ||
        (existingPost.title || '') !== title ||
        (existingPost.imageUrl || '') !== imageUrl
      );
      const approvalReset = liveApproval === APPROVAL_STATUS.APPROVED && rewritten;
      const approvalStatus = existingPost
        ? (approvalReset ? APPROVAL_STATUS.PENDING : liveApproval)
        : (Object.values(APPROVAL_STATUS).includes(formData.approvalStatus) ? formData.approvalStatus : APPROVAL_STATUS.PENDING);
      const feedback = existingPost ? (existingPost.feedback || '') : '';

      // Saving a parked suggestion must NOT silently promote it: stamping a clientId is
      // exactly what makes a post client-visible, so keep it empty — promotion is the
      // explicit "Use this" action on the suggestion card. Checked on BOTH the stored doc
      // and the incoming form data, so an id-stripped copy (duplicate) of a suggestion
      // stays a suggestion instead of minting a live draft.
      const isSuggestion = (existingPost ?? formData)?.source === 'suggestion';

      // Staging axis (utils/review.js). Editing NEVER moves a post between stages —
      // only the explicit Send / Hold verbs do — so an existing post keeps whatever
      // stage it has, and a post whose stage predates this field keeps behaving as
      // in_review. A NEW operator post starts in STAGING: that is the whole point of
      // the change (typing into a client with a live review link no longer publishes
      // the half-written draft to them the instant it saves). A client member's own
      // post has no staging concept — it's already their content — so it goes
      // straight to in_review. Suggestions are pinned private: they aren't client
      // content at all until promoted.
      const reviewStage = isSuggestion
        ? REVIEW_STAGE.PRIVATE
        : existingPost
          ? reviewStageOf(existingPost)
          : (isClientMember || formData.reviewStage === REVIEW_STAGE.IN_REVIEW
            ? REVIEW_STAGE.IN_REVIEW
            : REVIEW_STAGE.PRIVATE);

      // Swap a bulky base64 data URL for a small hosted /media URL (content-addressed
      // in R2, so a reused photo keeps one URL). Also opportunistically migrates
      // legacy data-URL posts whenever they're re-saved. Falls back to the data URL
      // if the upload fails, so saving never blocks on the media API.
      let imageUrl = await ensureHostedImage(formData.imageUrl || '', isClientMember ? myClientId : clientIdFor(client));
      // The Firestore fallback has a hard budget. Truncating base64 mid-stream would
      // store a CORRUPTED image with a success toast — drop it honestly instead.
      if (imageUrl.startsWith('data:') && imageUrl.length > 500000) {
        imageUrl = '';
        showToast("Image couldn't be uploaded and is too large to store offline — saved without it", "error");
      }

      const postData = {
        client,
        content,
        title,
        altText: (formData.altText || "").trim().slice(0, 300),
        metaDescription: (formData.metaDescription || "").trim().slice(0, 200),
        slug: (formData.title || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
        platform: platformId,
        status,
        approvalStatus,
        feedback,
        imageUrl: imageUrl.slice(0, 500000),
        tags,
        // Evergreen flag: templates live in the posts collection but are excluded
        // from the dated queue + the drafts API — surfaced only in the Templates view.
        // Forced off for suggestions: a suggestion-template hybrid would sit in two lanes
        // with two conflicting action rows.
        isTemplate: isSuggestion ? false : !!formData.isTemplate,
        reviewStage,
        // All posts are attributed to the operator uid (so the operator's query
        // + the single per-client review token resolve across multi-author
        // content); clientId is the immutable tenant key.
        uid: OPERATOR_UID,
        clientId: isSuggestion ? '' : (isClientMember ? myClientId : clientIdFor(client)),
        // Suggestions keep their identity through saves. forClientId tracks the CURRENT
        // client name so promote can never mis-tenant a renamed suggestion — but it is
        // re-derived ONLY on an actual rename: the worker's original forClientId is
        // roster-resolved, while clientIdFor is the posts-derived (phantom-slug-prone)
        // resolver, so re-stamping on every save would degrade it. The '' fallback makes
        // promote fail loudly ("couldn't resolve") instead of guessing.
        ...(isSuggestion ? {
          source: 'suggestion',
          // On a rename, ONLY a posts-derived exact name match may re-stamp — clientIdFor's
          // slugify fallback would MINT a phantom slug for a fresh name, and promote would then
          // silently mis-tenant. No match → '' → promote fails loudly and the operator re-picks.
          forClientId: existingPost
            ? (client !== existingPost.client ? (clientIdByName[client] || '') : (existingPost.forClientId || ''))
            : (formData.forClientId || clientIdByName[client] || '')
        } : {}),
        scheduledDate: getSafeDateString(formData.scheduledDate),
        updatedAt: new Date().toISOString()
      };

      if (formData.id) {
        await updateDoc(doc(db, 'posts', formData.id), postData);
        // Never silent: losing an approval is exactly the kind of thing an operator
        // must be told about the moment it happens, not discover at the publish gate.
        showToast(approvalReset
          ? "Thread updated — approval cleared, the content changed since the client signed off"
          : "Thread updated");
      } else {
        await addDoc(collection(db, 'posts'), { ...postData, createdAt: new Date().toISOString() });
        showToast("New thread created!");
      }

      setView('grid');
      setEditingPost(null);
      return true;
    } catch (error) {
      console.error("Save Error:", error);
      showToast(`Save failed: ${error.message}`, "error");
      return false;
    }
  }, [isReadOnly, showToast, isClientMember, myClientName, myClientId, clientIdFor, clientIdByName]);

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
              uid: OPERATOR_UID,
              // Undo on a SUGGESTION must resurrect it into the parked lane, not the client
              // queue: the name-derived clientId backfill (correct for legacy posts that lost
              // theirs) would otherwise silently promote it. Branch on source — '' IS the
              // suggestion's correct tenant key.
              clientId: post.source === 'suggestion' ? '' : (post.clientId || clientIdFor(post.client || '')),
              // Restore identity fields verbatim so an undone suggestion (or any sourced post)
              // returns exactly where it was.
              ...(post.source ? { source: post.source } : {}),
              ...(post.forClientId ? { forClientId: post.forClientId } : {}),
              ...(post.automationId ? { automationId: post.automationId } : {}),
              client: post.client || '',
              content: post.content || '',
              title: (post.title || '').slice(0, 200),
              altText: (post.altText || '').slice(0, 300),
              // Undo must restore the WHOLE post — dropping these silently turned a
              // restored template into a queue draft and lost SEO fields + the
              // client-feedback history.
              metaDescription: (post.metaDescription || '').slice(0, 200),
              slug: (post.slug || '').slice(0, 80),
              isTemplate: !!post.isTemplate,
              // Restore the staging axis verbatim — an undone staged draft must not
              // reappear on the client's review link.
              reviewStage: reviewStageOf(post),
              feedbackThread: Array.isArray(post.feedbackThread) ? post.feedbackThread : [],
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
  }, [isReadOnly, user, showToast, clientIdFor]);

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

    // Only the guest review flow (scheduling == approval) flips approvalStatus.
    // An operator setting "Scheduled" from the card just changes the workflow
    // status — it doesn't stand in for the client's approval.
    const markApproved = isApproving && isReadOnly;
    // A client's approval is a statement about the CONTENT, not about our publishing
    // workflow — but it used to force status='scheduled' unconditionally, so approving
    // an already-POSTED thread rewound it to Scheduled (it then read as unpublished and
    // reappeared as upcoming work). Only advance a post that is still a plain draft.
    const current = markApproved ? postsRef.current.find(p => p.id === postId) : null;
    const advanceStatus = !markApproved || !current || current.status === STATUS.DRAFT;
    try {
      await updateDoc(doc(db, 'posts', postId), {
        ...(advanceStatus ? { status: newStatus } : {}),
        updatedAt: new Date().toISOString(),
        ...(markApproved ? { approvalStatus: APPROVAL_STATUS.APPROVED } : {})
      });
      showToast(markApproved ? "Approved ✓" : `Status updated to ${newStatus}`);
    } catch {
      showToast("Update failed", "error");
    }
  }, [isReadOnly, showToast]);

  // Commit previewed import rows. Rows are already sanitized by parseImportFile
  // (in ImportExportModal); here we attach ownership/timestamps and chunk to the
  // 500-op batch cap. Returns true on success so the modal can close.
  //
  // 🔒 SECURITY: a client member's rows are FORCE-pinned to their own client
  // (name + immutable clientId), ignoring the file's client column — mirrors the
  // save/create-drafts write paths. firestore.rules enforce the same boundary
  // (isEntityMember(clientId) && uid == ownerUid()), so a mislabelled or hostile
  // file can never land content in another tenant.
  const handleImportRows = useCallback(async (rows) => {
    if (isReadOnly || !user || !rows?.length) return false;

    const now = new Date().toISOString();
    // Firestore caps a commit at 500 OPS *and* ~10 MiB. Chunking on ops alone was
    // enough for tiny rows, but an import carrying data-URL images (each up to
    // 500 KB — see the imageUrl cap on the save path) blows the byte cap long
    // before op 450, and the commit REJECTS. Earlier batches are already durable at
    // that point, so the operator got a flat "Import failed" on a half-imported
    // file. Flush BEFORE adding a row that would cross the line; checking after the
    // fact still lets one oversized row straddle it.
    const MAX_OPS = 450;
    const MAX_BYTES = 8 * 1024 * 1024; // headroom under the 10 MiB commit cap
    let committed = 0;
    let batch = writeBatch(db);
    let ops = 0, bytes = 0;
    const flush = async () => {
      if (ops === 0) return;
      await batch.commit();
      committed += ops;
      batch = writeBatch(db);
      ops = 0; bytes = 0;
    };

    try {
      for (const item of rows) {
        const size = (item.imageUrl?.length || 0) + (item.content?.length || 0) + 512;
        if (ops >= MAX_OPS || (ops > 0 && bytes + size > MAX_BYTES)) await flush();
        const client = isClientMember ? (myClientName || myClientId) : item.client;
        batch.set(doc(collection(db, 'posts')), {
          uid: OPERATOR_UID,
          clientId: isClientMember ? myClientId : clientIdFor(item.client),
          client,
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
          // Preserve templates through a backup → restore round-trip (otherwise a
          // full-backup import floods the dated queue with evergreen content).
          isTemplate: !!item.isTemplate,
          // A bulk import lands in STAGING, never straight onto the client's review
          // link — restoring a 400-row backup used to flood it in one commit.
          reviewStage: REVIEW_STAGE.PRIVATE,
          scheduledDate: item.scheduledDate || null,
          createdAt: now,
          updatedAt: now,
          source: 'import'
        });
        ops++; bytes += size;
      }
      await flush();
      showToast(`Imported ${rows.length} thread${rows.length === 1 ? '' : 's'}! 🚀`);
      return true;
    } catch (err) {
      // Report what ACTUALLY landed. A flat "Import failed" after 900 of 1200 rows
      // were already durable sent the operator to re-run the file and duplicate them.
      console.error("Import error:", err);
      showToast(
        committed > 0
          ? `Imported ${committed} of ${rows.length} — the rest failed. Re-import only the remaining rows.`
          : "Import failed. Please try again.",
        "error"
      );
      return false;
    }
  }, [isReadOnly, user, isClientMember, myClientName, myClientId, showToast, clientIdFor]);

  // Operator: after addressing client feedback, send the revised post back for
  // another review round — reset approvalStatus to pending and clear the current
  // feedback note (the full feedbackThread history is preserved for the reviewer).
  const handleResubmitForReview = useCallback(async (postId) => {
    if (isReadOnly) return;
    try {
      await updateDoc(doc(db, 'posts', postId), {
        approvalStatus: APPROVAL_STATUS.PENDING,
        feedback: '',
        // "Back for review" is a SEND. If the operator pulled the post into staging
        // to rework it, leaving the stage alone would reset the badge to "awaiting"
        // while the client still couldn't see it — a silent dead end.
        reviewStage: REVIEW_STAGE.IN_REVIEW,
        sentForReviewAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      showToast("Sent back for review 🔁");
    } catch {
      showToast("Couldn't update — please try again", "error");
    }
  }, [isReadOnly, showToast]);

  // Send a staged draft to the client: the one verb that makes a post visible on the
  // review link. Refuses posts with hard blockers (nothing to read, over the platform
  // limit, no image on an image-first channel) — sending one of those wastes a review
  // round. Warnings never block: asking a client about an unfinished idea is legitimate.
  const handleSendForReview = useCallback(async (post) => {
    if (isReadOnly) return;
    const { blockers } = readinessOf(post);
    if (blockers.length) {
      return showToast(`Not ready to send — ${READINESS_LABELS[blockers[0]].toLowerCase()}`, "error");
    }
    try {
      await updateDoc(doc(db, 'posts', post.id), {
        reviewStage: REVIEW_STAGE.IN_REVIEW,
        // Re-arm the review round. An already-approved post keeps its approval (the
        // client's decision stands); only an undecided one is (re)armed as pending.
        ...(post.approvalStatus === APPROVAL_STATUS.APPROVED ? {} : { approvalStatus: APPROVAL_STATUS.PENDING }),
        sentForReviewAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      showToast("Sent for review — it's on the client's link now ✓");
    } catch {
      showToast("Couldn't send for review", "error");
    }
  }, [isReadOnly, showToast]);

  // The inverse: pull a post OFF the client's review link and back into staging.
  // Its approval history is left untouched — reviewStateOf keeps showing what the
  // client actually decided, because that happened whether or not we hold the post now.
  const handleHoldFromReview = useCallback(async (post) => {
    if (isReadOnly) return;
    try {
      await updateDoc(doc(db, 'posts', post.id), {
        reviewStage: REVIEW_STAGE.PRIVATE,
        updatedAt: new Date().toISOString()
      });
      showToast("Moved to staging — the client can no longer see it");
    } catch {
      showToast("Couldn't move to staging", "error");
    }
  }, [isReadOnly, showToast]);

  // Promote a parked suggestion into the client's normal review queue. Stamping the real
  // clientId (forClientId — the roster slug the Worker resolved at generation time) is what
  // makes it client-visible: rules and subscriptions both key on it. Promote TRUSTS
  // forClientId because every rename path keeps it current (handleSavePost re-stamps on a
  // client change; handleMergeClient moves it) — re-resolving from the display name here
  // would route through clientIdFor, the phantom-slug-prone resolver, and degrade the
  // worker's roster-resolved slug on every promote. forClientId stays behind as provenance;
  // the source relabel + tag removal take it out of the suggestions lane.
  const handlePromoteSuggestion = useCallback(async (post) => {
    if (isReadOnly || !isOperator) return;
    const target = post.forClientId || clientIdFor(post.client || '');
    if (!target) return showToast("Couldn't resolve a client for this suggestion", "error");
    try {
      await updateDoc(doc(db, 'posts', post.id), {
        clientId: target,
        source: 'automation',
        // Promoting adopts the suggestion as REAL client content — but into STAGING,
        // not straight onto the client's review link. The operator reads it once more
        // (and usually adds the image) before "Send for review".
        reviewStage: REVIEW_STAGE.PRIVATE,
        tags: (post.tags || []).filter(t => t !== 'suggested'),
        // Promote always lands a LIVE pending draft — un-archive and clear any template
        // flag so the client actually sees what the success toast promises.
        ...(post.status === STATUS.ARCHIVED ? { status: STATUS.DRAFT } : {}),
        ...(post.isTemplate ? { isTemplate: false } : {}),
        updatedAt: new Date().toISOString()
      });
      showToast(`Moved into ${post.client || 'the client'}'s staging area — send it when it's ready ✓`);
    } catch (error) {
      console.error("Promote Error:", error);
      showToast("Couldn't use the suggestion", "error");
    }
  }, [isReadOnly, isOperator, clientIdFor, showToast]);

  // Dismissing deletes outright — a suggestion never reached a client, so there's nothing to
  // archive; the automation's cadence brings fresh options next run.
  const handleDismissSuggestion = useCallback(async (post) => {
    if (isReadOnly || !isOperator) return;
    try {
      await deleteDoc(doc(db, 'posts', post.id));
      showToast("Suggestion dismissed");
    } catch {
      showToast("Dismiss failed", "error");
    }
  }, [isReadOnly, isOperator, showToast]);

  // Push a template/blog post into the client's Sender tenant as a campaign-ready email template.
  // Server-side end to end (worker → broker → Sender); re-push UPDATES the same template
  // (provenance-keyed), so the button is safely idempotent. Honest outcomes: a client without a
  // Sender workspace gets a clear message, not a silent failure.
  const handlePushToSender = useCallback(async (post, { force = false } = {}) => {
    if (isReadOnly || !isOperator) return;
    showToast('Pushing to Sender…');
    try {
      const out = await pushToSender(post.id, { force });
      showToast(
        out.updated
          ? 'Sender template updated'
          : 'Pushed to Sender',
        'success',
        // Deep-link straight to the pushed template — "review it in Sender →
        // Templates" made the operator go hunting for what we already knew.
        out.builderUrl
          ? { label: 'Open in Sender', onClick: () => window.open(out.builderUrl, '_blank', 'noopener') }
          : null,
      );
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('sender_edited')) {
        // The template was edited in Sender's builder since the last push —
        // overwriting is a real decision, never a silent side effect.
        setConfirmModal({
          type: 'danger',
          title: 'Overwrite the Sender copy?',
          // "changed", not "edited" — the version token also moves on renames
          // and maintenance saves, and the dialog must not overclaim.
          message: `"${post.title || post.client || 'This template'}" was changed inside Sender after the last push (an edit, a rename, or a maintenance save). Pushing again replaces the Sender copy with this Spool draft.`,
          confirmLabel: 'Overwrite',
          onConfirm: () => {
            setConfirmModal(null);
            handlePushToSender(post, { force: true });
          },
        });
      }
      else if (msg.includes('no_tenant_for_slug')) showToast('This client doesn’t have a Sender workspace yet', 'error');
      else if (msg.includes('empty_content')) showToast('Nothing email-safe survived conversion — check the post content', 'error');
      else showToast(msg || 'Push to Sender failed', 'error');
    }
  }, [isReadOnly, isOperator, showToast]);

  // Stage an APPROVED blog draft for site publication (the deterministic publish lane). Nothing
  // goes live from here: the broker writes a spine ticket + a sha-pinned publish object, the
  // operator dispatches it from POM (agent PR), and a human merges. Idempotent — re-clicking the
  // unchanged draft replays the existing ticket.
  const handlePublishToSite = useCallback(async (post, repoOverride) => {
    if (isReadOnly || !isOperator) return;
    showToast('Staging for site publication…');
    try {
      const out = await publishToSite(post.id, repoOverride ? { repo: repoOverride } : {});
      showToast(out.alreadyStaged
        ? `Already staged — dispatch ticket ${out.ticketId} from POM to open the PR`
        : `Staged as ticket ${out.ticketId} → ${out.path}. Dispatch it from POM to open the PR.`);
    } catch (err) {
      const code = String(err?.code || '');
      const msg = String(err?.message || '');
      if (code === 'repo_required' && Array.isArray(err.repos) && err.repos.length) {
        // Multi-repo client: one native prompt beats a dead end (house dialogs are a POM
        // convention; Spool has no dialog system yet).
        const pick = window.prompt(`This client has several linked repos — publish to which?\n\n${err.repos.join('\n')}`, err.repos[0]);
        const chosen = (pick || '').trim().toLowerCase();
        if (chosen && err.repos.includes(chosen)) {
          handlePublishToSite(post, chosen);
        } else if (pick !== null) {
          showToast('That isn’t one of the linked repos — publish cancelled', 'error');
        }
        return;
      }
      if (code === 'no_repo_linked') showToast('This client has no GitHub repo linked in POM yet', 'error');
      else if (code === 'invalid_path') showToast('The file path was refused — rename the post (avoid special characters and the word “auth”) and retry', 'error');
      else showToast(msg || 'Could not stage the publish', 'error');
    }
  }, [isReadOnly, isOperator, showToast]);

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
      // Append to a feedback thread (history across review rounds) rather than overwriting.
      // `feedback` keeps the latest note for back-compat / card display. ATOMIC append (arrayUnion),
      // not a snapshot rebuild: POM's review verb (broker → worker PATCH) is a concurrent writer on
      // the same field, and a read-modify-write here could silently drop its entry (or vice versa).
      // Entries carry an ISO timestamp so the union-dedupe never merges two distinct notes. The old
      // 20-entry cap can't be enforced atomically — readers trim for display instead.
      const entry = { text: sanitizedFeedback, by: isReadOnly ? 'client' : 'you', at: new Date().toISOString() };

      await updateDoc(doc(db, 'posts', postId), {
        feedback: sanitizedFeedback,
        feedbackThread: arrayUnion(entry),
        approvalStatus: APPROVAL_STATUS.CHANGES_REQUESTED,
        updatedAt: new Date().toISOString()
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
    if (isReadOnly || !isOperator) return;
    // Blast writes LIVE drafts into every tenant's queue — unvetted suggestion content must
    // go through the explicit Promote first (the card hides the button too; this keeps the
    // handler safe for any future call site).
    if (post.source === 'suggestion') return showToast("Promote this suggestion first — Blast works from live drafts", "error");

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
              uid: OPERATOR_UID,
              clientId: clientIdFor(clientName),
              client: String(clientName).replace(/\//g, '').slice(0, 50),
              content: post.content || "",
              title: (post.title || '').slice(0, 200),
              altText: (post.altText || '').slice(0, 300),
              metaDescription: (post.metaDescription || '').slice(0, 200),
              slug: (post.slug || '').slice(0, 80),
              platform: post.platform || 'gmb',
              status: STATUS.DRAFT,
              approvalStatus: APPROVAL_STATUS.PENDING,
              // A blast fans one draft into every tenant at once — it lands in each
              // client's STAGING area so the operator tailors it before anyone sees it.
              reviewStage: REVIEW_STAGE.PRIVATE,
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
  }, [isReadOnly, isOperator, uniqueClients, showToast, clientIdFor]);

  // Stable identity matters: an inline arrow here handed memo(PostGrid) a new prop
  // on every single App render, so the memo never bailed and all N cards re-rendered.
  const handleCreateNew = useCallback(() => {
    setEditingPost(null);
    setView('editor');
  }, []);

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
    // and inherited client feedback wouldn't apply to it. A clone is never a
    // template (that's what "Use as draft" is for).
    handleSavePost({
      ...p,
      id: undefined,
      status: STATUS.DRAFT,
      approvalStatus: APPROVAL_STATUS.PENDING,
      // A clone is a fresh draft, so it starts in staging even when its source was
      // already approved and live on the client's link.
      reviewStage: REVIEW_STAGE.PRIVATE,
      feedback: '',
      isTemplate: false
    });
  }, [handleSavePost]);

  // "Use as draft": open the editor pre-filled from a template as a brand-new,
  // non-template draft. Nothing is written until the user saves — so they alter
  // + schedule this iteration before it lands in the queue.
  const handleUseTemplate = useCallback((tmpl) => {
    if (isReadOnly) return;
    setEditingPost({
      ...tmpl,
      id: undefined,
      isTemplate: false,
      status: STATUS.DRAFT,
      approvalStatus: APPROVAL_STATUS.PENDING,
      reviewStage: REVIEW_STAGE.PRIVATE,
      feedback: '',
      scheduledDate: null
    });
    setShowTemplates(false);
    setView('editor');
  }, [isReadOnly]);

  // Batch-create draft posts (used by "Repurpose blog → social"). Returns count.
  const handleCreateDrafts = useCallback(async (drafts) => {
    if (isReadOnly || !user) return 0;
    const valid = (drafts || []).filter(d => d && d.content && PLATFORMS[d.platform]);
    if (valid.length === 0) return 0;

    const batch = writeBatch(db);
    valid.forEach(d => {
      const platform = PLATFORMS[d.platform] || PLATFORMS.gmb;
      const ref = doc(collection(db, 'posts'));
      const cName = isClientMember ? (myClientName || myClientId) : (d.client || '').trim().replace(/\//g, '').slice(0, 50);
      batch.set(ref, {
        uid: OPERATOR_UID,
        clientId: isClientMember ? myClientId : clientIdFor(cName),
        client: cName,
        // X's limit is WEIGHTED (URLs=23) — a raw 280-char slice can cut a URL
        // in half on a tweet the editor would accept whole. Bound twitter with a
        // generous raw backstop instead; the editor enforces the weighted limit
        // before the draft can be saved onward.
        content: (d.content || '').trim().slice(0, d.platform === 'twitter' ? 1000 : platform.maxChars),
        title: '',
        platform: d.platform,
        status: STATUS.DRAFT,
        approvalStatus: APPROVAL_STATUS.PENDING,
        reviewStage: REVIEW_STAGE.PRIVATE,
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
  }, [isReadOnly, user, isClientMember, myClientName, myClientId, clientIdFor]);

  // ===========================================================================
  // THE QUEUE PIPELINE
  //
  // Rebuilt as three memo stages whose FINAL stage emits the visible list and
  // every facet count from the SAME walk. Two things this buys:
  //   • correctness — a count can never disagree with the grid it labels, and
  //     each axis is counted against every OTHER active filter ("all but self"),
  //     so clicking a chip that says 12 always yields 12 cards, never 0;
  //   • cost — the old cascade re-walked the snapshot ~8 times per keystroke.
  // ===========================================================================

  // Stage 1 — lane partition. ONE pass splits the three mutually-exclusive lanes.
  // Suggestion beats template: a doc carrying both flags belongs to the more
  // restrictive lane (the same precedence PostCard applies to its action rows).
  //
  // NOBODY BUT THE OPERATOR SEES STAGED POSTS. That is the entire point of staging,
  // and it is enforced here, before any other filter can be cleared. The gate is
  // "not the operator" rather than "is a review guest" on purpose: a client member
  // (client / client_admin with a real login) is just as much the audience staging
  // exists to hide unfinished work from as a share-link guest is. Their OWN posts
  // are never affected — a member's writes are stamped in_review (handleSavePost).
  const lanes = useMemo(() => {
    const queue = [], templates = [], suggestions = [];
    for (const p of posts) {
      if (p.source === 'suggestion') { suggestions.push(p); continue; }
      if (!isOperator && isStaged(p)) continue;
      if (p.isTemplate) { templates.push(p); continue; }
      queue.push(p);
    }
    return { queue, templates, suggestions };
  }, [posts, isOperator]);

  const searchLower = useMemo(() => deferredSearchQuery.trim().toLowerCase(), [deferredSearchQuery]);
  const matchesSearch = useCallback(
    (p) => !searchLower || p._searchContent?.includes(searchLower) || p._searchClient?.includes(searchLower),
    [searchLower]
  );

  // Stage 2 — client / archive / search scope. The platform + tag menus enumerate
  // from HERE, so every platform with content in the current context is offered
  // with a count that already respects client, search and archive.
  const scopedPosts = useMemo(() => lanes.queue.filter(p =>
    (filterClient ? p.client === filterClient : true) &&
    (showArchived ? p.status === STATUS.ARCHIVED : p.status !== STATUS.ARCHIVED) &&
    matchesSearch(p)
  ), [lanes.queue, filterClient, showArchived, matchesSearch]);

  const { platformCounts, tagCounts } = useMemo(() => {
    const platformCounts = {}, tagCounts = {};
    for (const p of scopedPosts) {
      platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
      for (const t of (p.tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    return { platformCounts, tagCounts };
  }, [scopedPosts]);

  // Stage 3 — the facet pass.
  const { visiblePosts, reviewCounts, statusCounts, mediaCounts, needsCounts } = useMemo(() => {
    const out = [];
    const reviewCounts = {
      all: 0,
      [REVIEW_STATE.NOT_SENT]: 0,
      [REVIEW_STATE.AWAITING]: 0,
      [REVIEW_STATE.CHANGES]: 0,
      [REVIEW_STATE.APPROVED]: 0,
    };
    const statusCounts = { [STATUS.DRAFT]: 0, [STATUS.SCHEDULED]: 0, [STATUS.POSTED]: 0 };
    const mediaCounts = { [MEDIA_FILTER.WITH]: 0, [MEDIA_FILTER.WITHOUT]: 0 };
    const needsCounts = {
      [NEEDS_FILTER.IMAGE]: 0,
      [NEEDS_FILTER.NOT_READY]: 0,
      [NEEDS_FILTER.FEEDBACK]: 0,
      [NEEDS_FILTER.OVERDUE]: 0,
      [NEEDS_FILTER.NO_DATE]: 0,
    };

    for (const p of scopedPosts) {
      // Platform + tag gate first: they scope the menus above, so nothing past this
      // point should count content the operator has already filtered away.
      if (filterPlatform && p.platform !== filterPlatform) continue;
      if (filterTag && !(p.tags || []).includes(filterTag)) continue;

      const state = reviewStateOf(p);
      const withMedia = !!p.imageUrl;
      // readinessOf is memoized on post identity (utils/readiness.js) — stable post
      // objects from usePosts mean this is a map lookup after the first evaluation.
      const flags = {
        [NEEDS_FILTER.IMAGE]: needsImage(p),
        [NEEDS_FILTER.NOT_READY]: hasBlockers(p),
        [NEEDS_FILTER.FEEDBACK]: hasFeedback(p),
        [NEEDS_FILTER.OVERDUE]: isOverdue(p, nowTick),
        // Calendar view silently drops undated posts (they have nowhere to sit), so
        // without this facet a draft with no date could sit unnoticed forever.
        [NEEDS_FILTER.NO_DATE]: !p.scheduledDate,
      };

      const okStatus = !filterStatus || p.status === filterStatus;
      const okReview = !filterReview || state === filterReview;
      const okMedia = !filterMedia || (filterMedia === MEDIA_FILTER.WITH) === withMedia;
      const okNeeds = !filterNeeds || flags[filterNeeds];

      // Each axis counts itself against all the OTHERS, never against itself.
      if (okStatus && okMedia && okNeeds) { reviewCounts.all++; reviewCounts[state]++; }
      if (okReview && okMedia && okNeeds && statusCounts[p.status] !== undefined) statusCounts[p.status]++;
      if (okStatus && okReview && okNeeds) mediaCounts[withMedia ? MEDIA_FILTER.WITH : MEDIA_FILTER.WITHOUT]++;
      if (okStatus && okReview && okMedia) for (const k in flags) if (flags[k]) needsCounts[k]++;

      if (okStatus && okReview && okMedia && okNeeds) out.push(p);
    }
    return { visiblePosts: out, reviewCounts, statusCounts, mediaCounts, needsCounts };
  }, [scopedPosts, filterPlatform, filterTag, filterStatus, filterReview, filterMedia, filterNeeds, nowTick]);

  // Distinct images already used on each client's posts (incl. templates) — so the
  // editor's media picker can offer "reuse an image from this client" without any
  // re-upload. The Compass import's hero photos live here immediately.
  const postImagesByClient = useMemo(() => {
    const sets = {};
    for (const p of posts) {
      if (!p.imageUrl || !p.client) continue;
      (sets[p.client] = sets[p.client] || new Set()).add(p.imageUrl);
    }
    const out = {};
    for (const k in sets) out[k] = Array.from(sets[k]);
    return out;
  }, [posts]);

  // Operator-only suggestions lane: automation runs in 'suggest' mode park here with NO clientId
  // (visibility is clientId-keyed in rules + subscriptions, so clients/guests can never receive
  // them — for non-operators this list is empty by construction). Client + search scoped like
  // the queue; surfaced via the Suggestions chip and promoted/dismissed from the card.
  const suggestionPosts = useMemo(() => {
    if (!isOperator) return EMPTY_POSTS;
    return lanes.suggestions.filter(p =>
      (filterClient ? p.client === filterClient : true) && matchesSearch(p)
    );
  }, [isOperator, lanes.suggestions, filterClient, matchesSearch]);

  // Evergreen templates (client/search scoped, newest first). Their own area.
  const templatesList = useMemo(() => lanes.templates.filter(p =>
    (filterClient ? p.client === filterClient : true) && matchesSearch(p)
  ), [lanes.templates, filterClient, matchesSearch]);

  // The Suggestions chip swaps in the parked lane wholesale (its verbs are
  // promote/dismiss, so the queue facets don't apply and the FilterBar hides them).
  const filteredPosts = useMemo(
    () => sortPosts(filterReview === SUGGESTIONS_LANE ? suggestionPosts : visiblePosts, sortBy),
    [filterReview, suggestionPosts, visiblePosts, sortBy]
  );

  const calendarPosts = useMemo(() => {
    if (view !== 'calendar') return EMPTY_POSTS;
    return filteredPosts.filter(p => p.scheduledDate instanceof Date);
  }, [filteredPosts, view]);

  // Guest review progress ("5 of 8 approved"). One pass, not three.
  const approvalProgress = useMemo(() => {
    if (!isReadOnly) return null;
    let approved = 0, changes = 0;
    for (const p of filteredPosts) {
      if (p.approvalStatus === APPROVAL_STATUS.APPROVED) approved++;
      else if (p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) changes++;
    }
    const total = filteredPosts.length;
    return { total, approved, changes, pending: Math.max(0, total - approved - changes) };
  }, [isReadOnly, filteredPosts]);

  // Any facet beyond the sidebar's client scope — drives the "Clear filters" affordance.
  const activeFilterCount =
    (filterReview ? 1 : 0) + (filterStatus ? 1 : 0) + (filterPlatform ? 1 : 0) +
    (filterTag ? 1 : 0) + (filterMedia ? 1 : 0) + (filterNeeds ? 1 : 0);

  const clearFilters = useCallback(() => {
    setFilterReview(null); setFilterStatus(null); setFilterPlatform(null);
    setFilterTag(null); setFilterMedia(null); setFilterNeeds(null);
  }, []);

  const setDensity = useCallback((v) => {
    if (!DENSITY_VALUES.includes(v)) return;
    setDensityState(v);
    try { localStorage.setItem(DENSITY_KEY, v); } catch { /* no storage — the choice just won't outlive the tab */ }
  }, []);

  const handleExport = useCallback((mode, format = 'csv') => {
    let exportPosts = [];
    if (mode === 'current') exportPosts = filteredPosts;
    else if (mode === 'archived') exportPosts = posts.filter(p => p.status === STATUS.ARCHIVED);
    else if (mode === 'selected') exportPosts = posts.filter(p => selectedIds.has(p.id));
    else exportPosts = posts;

    if (exportPosts.length === 0) return showToast("Nothing to export", "error");

    const date = new Date().toISOString().split('T')[0];
    if (format === 'json') {
      downloadFile(postsToJSON(exportPosts), `spool-backup-${mode}-${date}.json`, 'application/json');
    } else {
      downloadFile(convertToCSV(exportPosts), `spool-export-${mode}-${date}.csv`, 'text/csv;charset=utf-8;');
    }
    showToast(`Exported ${exportPosts.length} thread${exportPosts.length === 1 ? '' : 's'} 📥`);
  }, [posts, filteredPosts, selectedIds, showToast]);

  // --- Selection & bulk actions (owner only) ---
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Apply a per-post patch to the whole selection (skips unchanged posts).
  // `mutate(post)` returns a patch object or null to skip that post.
  const commitBulk = useCallback(async (mutate, successMsg, { clearAfter = false, emptyMsg } = {}) => {
    if (isReadOnly || !user) return;
    const byId = new Map(postsRef.current.map(p => [p.id, p]));
    const now = new Date().toISOString();
    const updates = [];
    selectedIds.forEach(id => {
      const post = byId.get(id);
      // Suggestions are never selectable, but skip them anyway so no future selection
      // path can bulk-stamp a clientId (= silent promote) onto a parked suggestion.
      if (!post || post.source === 'suggestion') return;
      const patch = mutate(post);
      if (patch) updates.push([id, { ...patch, updatedAt: now }]);
    });
    // `emptyMsg` exists so a bulk verb that SKIPPED work can say why, instead of
    // reporting the generic no-op and leaving the operator guessing.
    if (updates.length === 0) return showToast(emptyMsg ? emptyMsg() : "No changes to apply", emptyMsg ? "error" : "success");
    try {
      const CHUNK = 450;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const batch = writeBatch(db);
        updates.slice(i, i + CHUNK).forEach(([id, patch]) => batch.update(doc(db, 'posts', id), patch));
        await batch.commit();
      }
      showToast(successMsg(updates.length));
      if (clearAfter) clearSelection();
    } catch (err) {
      console.error("Bulk update error:", err);
      showToast("Bulk update failed", "error");
    }
  }, [isReadOnly, user, selectedIds, showToast, clearSelection]);

  const handleBulkReassignClient = useCallback((client) => {
    const c = String(client).trim().replace(/\//g, '').slice(0, 50);
    if (!c) return;
    // Posts may leave the current client filter — clear selection after.
    // Move the immutable clientId alongside the display name.
    //
    // 🔒 A reassignment crosses a TENANT boundary, so the review state cannot ride
    // along. Client A's approval says nothing about client B's content, and A's
    // private feedback ("our CEO hated this angle") would land verbatim on B's
    // review link — a real cross-client disclosure. The moved posts arrive in B's
    // staging area as fresh, unreviewed drafts, which is what they are.
    commitBulk(
      () => ({
        client: c,
        clientId: clientIdFor(c),
        approvalStatus: APPROVAL_STATUS.PENDING,
        reviewStage: REVIEW_STAGE.PRIVATE,
        feedback: '',
        feedbackThread: [],
      }),
      n => `Moved ${n} thread${n === 1 ? '' : 's'} to "${c}" — review state reset`,
      { clearAfter: true }
    );
  }, [commitBulk, clientIdFor]);

  const handleBulkAddTags = useCallback((tags) => {
    commitBulk(post => {
      const cur = Array.isArray(post.tags) ? post.tags : [];
      const merged = [...new Set([...cur, ...tags])].slice(0, 10);
      return merged.length === cur.length && merged.every((t, i) => t === cur[i]) ? null : { tags: merged };
    }, n => `Tagged ${n} thread${n === 1 ? '' : 's'}`);
  }, [commitBulk]);

  const handleBulkRemoveTags = useCallback((tags) => {
    const rm = new Set(tags);
    commitBulk(post => {
      const cur = Array.isArray(post.tags) ? post.tags : [];
      const next = cur.filter(t => !rm.has(t));
      return next.length === cur.length ? null : { tags: next };
    }, n => `Updated tags on ${n} thread${n === 1 ? '' : 's'}`);
  }, [commitBulk]);

  const handleBulkStatus = useCallback((status) => {
    if (!Object.values(STATUS).includes(status)) return;
    commitBulk(() => ({ status }), n => `Set ${n} thread${n === 1 ? '' : 's'} to ${status}`, { clearAfter: status === STATUS.ARCHIVED });
  }, [commitBulk]);

  // Bulk send: the verb that makes a whole batch visible to the client at once —
  // the realistic way to work a week of drafts. Posts with hard blockers are SKIPPED,
  // not silently included, and the toast names how many and why.
  const handleBulkSendForReview = useCallback(() => {
    let blocked = 0;
    const now = new Date().toISOString();
    commitBulk((post) => {
      if (post.isTemplate) return null;      // templates sit outside the review loop
      if (!isStaged(post)) return null;      // already with the client
      if (hasBlockers(post)) { blocked++; return null; }
      return {
        reviewStage: REVIEW_STAGE.IN_REVIEW,
        ...(post.approvalStatus === APPROVAL_STATUS.APPROVED ? {} : { approvalStatus: APPROVAL_STATUS.PENDING }),
        sentForReviewAt: now,
      };
    },
    n => `Sent ${n} for review${blocked ? ` · skipped ${blocked} that aren’t ready` : ''} ✓`,
    {
      clearAfter: true,
      emptyMsg: () => blocked
        ? `Nothing sent — ${blocked} ${blocked === 1 ? 'post isn’t' : 'posts aren’t'} ready (empty, over the limit, or missing a required image)`
        : 'Nothing to send — these are already with the client',
    });
  }, [commitBulk]);

  const handleBulkHold = useCallback(() => {
    commitBulk(
      (post) => (post.isTemplate || isStaged(post)) ? null : { reviewStage: REVIEW_STAGE.PRIVATE },
      n => `Moved ${n} thread${n === 1 ? '' : 's'} to staging`,
      { clearAfter: true, emptyMsg: () => 'Nothing to move — these are already in staging' }
    );
  }, [commitBulk]);

  const handleBulkArchive = useCallback(() => {
    commitBulk(() => ({ status: STATUS.ARCHIVED }), n => `Archived ${n} thread${n === 1 ? '' : 's'}`, { clearAfter: true });
  }, [commitBulk]);

  const handleBulkDelete = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setConfirmModal({
      title: `Delete ${ids.length} thread${ids.length === 1 ? '' : 's'}?`,
      message: "This permanently removes the selected threads. This can't be undone.",
      type: 'danger',
      onConfirm: async () => {
        try {
          const CHUNK = 450;
          for (let i = 0; i < ids.length; i += CHUNK) {
            const batch = writeBatch(db);
            ids.slice(i, i + CHUNK).forEach(id => batch.delete(doc(db, 'posts', id)));
            await batch.commit();
          }
          showToast(`Deleted ${ids.length} thread${ids.length === 1 ? '' : 's'}`);
          clearSelection();
        } catch (err) {
          console.error("Bulk delete error:", err);
          showToast("Bulk delete failed", "error");
        } finally {
          setConfirmModal(null);
        }
      }
    });
  }, [selectedIds, showToast, clearSelection]);

  // Rename or merge a client: reassign every post from `source` to `target`,
  // and migrate the brand-settings doc if the target has none.
  const handleMergeClient = useCallback(async (source, target) => {
    if (isReadOnly || !user || !isOperator) return;
    const from = String(source || '').trim();
    const to = String(target || '').trim().replace(/\//g, '').slice(0, 50);
    if (!from || !to || from === to) return showToast("Pick a different target name", "error");

    const affected = postsRef.current.filter(p => p.client === from);
    // RENAME and MERGE are different operations and must not share a tenant-key policy.
    //
    // A MERGE folds one client's threads into ANOTHER, existing client — re-stamping clientId to
    // the target's is the whole point. A RENAME is a display-name change for the SAME client, and
    // the tenant key must survive it untouched. Both used to run `clientIdFor(to)`, whose slugify
    // fallback MINTS a fresh slug for a name it hasn't seen — the very phantom-slug hazard
    // handleSavePost documents and guards against. So renaming "Lyf Fit" → "Lyf-Fit Studio"
    // silently re-tenanted every thread: live review links (bound to the old clientId) went dead,
    // client-member logins stopped matching their own posts, and the POM↔Spool join by slug broke.
    //
    // Computed BEFORE any write, since clientMap only refreshes on the next snapshot.
    //
    // "Does a client with this display name already exist?" must be asked of EVERY existing name,
    // not just the ones that happen to carry a clientId. clientIdByName is built only from posts
    // where `p.clientId` is truthy, so a target whose only content is parked suggestions (clientId
    // is '' for those BY DESIGN) looked like a fresh name — the operator picked "Merge into Acme"
    // in the UI and got a rename, silently stranding Acme's existing threads on a different tenant.
    const targetExists =
      Boolean(clientMap[to]) ||
      Boolean(clientIdByName[to]) ||
      postsRef.current.some((p) => p.client === to);
    const isMerge = targetExists;
    // The target's REAL tenant key, in the same precedence Editor.jsx uses. clientIdFor alone would
    // fall through to slugifyClientId for a target that exists only as a branding doc, minting the
    // phantom slug this whole change exists to prevent.
    const targetClientId = clientIdByName[to] || clientMap[to]?.clientId || clientIdFor(to);
    // The SOURCE's tenant key — what a pure rename must preserve.
    const sourceClientId = clientIdByName[from] || clientMap[from]?.clientId || '';
    try {
      const now = new Date().toISOString();
      const CHUNK = 450;
      for (let i = 0; i < affected.length; i += CHUNK) {
        const batch = writeBatch(db);
        // A rename/merge sweeps ALL of the client's posts — including parked suggestions,
        // whose tenant key must STAY '' (stamping clientId would silently promote them).
        // They follow the rename via display name + a re-derived forClientId instead.
        affected.slice(i, i + CHUNK).forEach(p => batch.update(doc(db, 'posts', p.id),
          isMerge
            ? (p.source === 'suggestion'
              ? { client: to, forClientId: targetClientId || '', updatedAt: now }
              // A MERGE moves content to a DIFFERENT tenant, so its review state must
              // not follow: the source client's approval doesn't bind the target, and
              // the source's private feedback would surface on the target's review
              // link. (A pure RENAME is the same client under a new label — nothing
              // below this line applies to it, and nothing there is touched.)
              : {
                client: to,
                clientId: targetClientId,
                approvalStatus: APPROVAL_STATUS.PENDING,
                reviewStage: REVIEW_STAGE.PRIVATE,
                feedback: '',
                feedbackThread: [],
                updatedAt: now,
              })
            // Pure rename: display name ONLY. Leaving clientId/forClientId alone keeps every
            // thread on the tenant it already belongs to — which is what a rename means.
            : { client: to, updatedAt: now }));
        await batch.commit();
      }

      // Brand settings: copy source → target if target has none, then drop source.
      const srcSettings = clientMap[from];
      if (srcSettings) {
        if (!clientMap[to]) {
          await setDoc(doc(db, 'clients', `${OPERATOR_UID}__${encodeURIComponent(to)}`), {
            // Carry the SOURCE's tenant key across a rename; only a real merge adopts the target's.
            // The rename fallback chain resolves from the SOURCE — falling back to the target name
            // would slugify a name no post carries and mint exactly the phantom slug this avoids,
            // leaving the branding doc pointing at a tenant none of its own posts belong to.
            ...srcSettings,
            uid: OPERATOR_UID,
            name: to,
            clientId: isMerge ? targetClientId : (srcSettings.clientId || sourceClientId || clientIdFor(from))
          }, { merge: true });
        }
        await deleteDoc(doc(db, 'clients', `${OPERATOR_UID}__${encodeURIComponent(from)}`)).catch(() => {});
      }

      if (filterClient === from) setFilterClient(to);
      showToast(
        isMerge
          ? `Merged "${from}" → "${to}" (${affected.length} thread${affected.length === 1 ? '' : 's'}) — review state reset, they're in staging`
          : `Renamed "${from}" → "${to}" (${affected.length} thread${affected.length === 1 ? '' : 's'})`
      );
    } catch (err) {
      console.error("Merge client error:", err);
      showToast("Couldn't rename/merge client", "error");
    }
  }, [isReadOnly, user, isOperator, clientMap, clientIdByName, filterClient, showToast, clientIdFor]);

  // --- Render ---

  // Expired / revoked / invalid share link.
  if (shareError && !user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mb-4">
          <ShieldCheck className="text-rose-400" size={32} />
        </div>
        <h1 className="text-xl font-bold text-slate-900">Review link unavailable</h1>
        <p className="text-slate-500 mt-2 max-w-sm">{shareError} Please ask your team for an updated review link.</p>
      </div>
    );
  }

  // Resolving a share token / initial auth — avoid a flash of the login screen.
  if (authLoading && !user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-white">
        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
        <p className="text-slate-400 font-medium animate-pulse">Loading…</p>
      </div>
    );
  }

  // Signed in to Firebase but not authorized for Spool (no users/{email} grant).
  if (authzError && !user && !sharedUid) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mb-4">
          <ShieldCheck className="text-rose-400" size={32} />
        </div>
        <h1 className="text-xl font-bold text-slate-900">Access not enabled</h1>
        <p className="text-slate-500 mt-2 max-w-sm">{authzError}</p>
        <button onClick={signOutAndExit} className="mt-5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800">Sign out</button>
      </div>
    );
  }

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
            uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
            clientIdByName={isOperator ? clientIdByName : (myClientName ? { [myClientName]: myClientId } : {})}
            /* Roster-aware resolver for genClientId's tail (same role-scoped pinning as
               MediaLibrary): a member's own name resolves straight to their pinned id. */
            clientIdFor={isOperator ? clientIdFor : ((name) => (name === myClientName ? myClientId : clientIdFor(name)))}
            showToast={showToast}
            onSave={handleSavePost}
            onCreateDrafts={handleCreateDrafts}
            postImagesByClient={postImagesByClient}
            /* New posts inherit the caller's client context (active filter, or a
               member's own client) so the media picker works before first save. */
            initialClient={isOperator ? (filterClient || '') : (myClientName || '')}
            clientLocked={isClientMember}
            canPreviewEmail={isOperator}
            onCancel={() => { setView('grid'); setEditingPost(null); }}
          />
        </Suspense>
        {toast && <Toast message={toast.message} type={toast.type} action={toast.action} onClose={hideToast}/>}
        {user && !isReadOnly && (
          <FeedbackWidget user={user} role={role} clientId={myClientId} view={view} showToast={showToast} />
        )}
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
            onShowArchived={(v) => { setShowArchived(v); setShowTemplates(false); clearFilters(); }}
            showTemplates={showTemplates}
            onShowTemplates={(v) => { setShowTemplates(v); if (v) { setShowArchived(false); clearFilters(); exitSelectionMode(); } }}
            filterClient={filterClient}
            onFilterClient={setFilterClient}
            uniqueClients={uniqueClients}
            onOpenClientSettings={() => setIsClientSettingsOpen(true)}
            onOpenMedia={() => setIsMediaOpen(true)}
            onOpenData={() => setIsDataOpen(true)}
            isOperator={isOperator}
            onOpenAdmin={() => setIsAdminOpen(true)}
            onOpenAutomations={() => setIsAutomationsOpen(true)}
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
            onShare={handleOpenShare}
            filterClient={filterClient}
            onNew={handleCreateNew}
            onSignOut={signOutAndExit}
            userEmail={user?.email || ''}
            role={role}
          />

          {/* Two DIFFERENT situations, and the banner used to claim the recoverable one
              for both: a transient blip that usePosts really is retrying, versus a
              terminated listener (revoked link, withdrawn grant, backoff exhausted)
              where nothing will change until the page reloads. */}
          {postsError && (
            postsStalled ? (
              <div className="bg-rose-50 border-b border-rose-100 px-4 sm:px-6 py-2 text-sm text-rose-700 font-medium text-center flex items-center justify-center gap-3" role="alert">
                <span>Live updates stopped — what you see may be out of date.</span>
                <button onClick={() => window.location.reload()} className="underline font-bold hover:text-rose-900">Reload</button>
              </div>
            ) : (
              <div className="bg-amber-50 border-b border-amber-100 px-4 sm:px-6 py-2 text-sm text-amber-800 font-medium text-center" role="alert">
                Connection issue — live updates may be delayed. Retrying automatically…
              </div>
            )
          )}

          {/* Wider than the old max-w-7xl (1280px): at the 1614px window this pass was
              reported from, the 1280px cap left ~80px of dead gutter AND held the grid to
              three columns. 1700px is where a fourth card column lands at the same card
              width the third one has today (see PostGrid's GRID_CLASS). */}
          <div className={`flex-1 p-4 sm:p-6 lg:p-8 max-w-[1700px] mx-auto w-full ${selectionMode && selectedIds.size > 0 ? 'pb-28' : ''}`}>
            <div className="flex items-center justify-between mb-6 gap-3">
              <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2 min-w-0">
                <span className="truncate">{view === 'calendar' ? 'Calendar' : (filterClient ? `${filterClient} Threads` : 'All Threads')}</span>
                {/* How big is this list, actually? The chip row answers it per review
                    state; nothing answered it for the list you are actually looking at. */}
                {view === 'grid' && !isLoading && (
                  <span className="shrink-0 text-sm font-bold text-slate-400 bg-slate-100 border border-slate-200 rounded-full px-2.5 py-0.5 tabular-nums">
                    {showTemplates ? templatesList.length : filteredPosts.length}
                  </span>
                )}
                {filterClient && isOperator && (
                  <button onClick={() => setFilterClient(null)} title="Clear Filter" aria-label="Clear Filter" className="text-slate-400 hover:text-rose-500 shrink-0"><X size={20}/></button>
                )}
              </h2>
              {/* Selection/bulk actions stay off the suggestions lane — bulk verbs (reassign,
                  status, archive) would side-step the explicit promote/dismiss flow. */}
              {isOperator && view === 'grid' && !showTemplates && filterReview !== SUGGESTIONS_LANE && filteredPosts.length > 0 && (
                <button
                  onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold border transition-colors ${selectionMode ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                >
                  <CheckSquare size={16} /> {selectionMode ? 'Done' : 'Select'}
                </button>
              )}
            </div>

            {isLoading ? (
              <div className="flex flex-col items-center justify-center h-64">
                <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
                <p className="text-slate-400 font-medium animate-pulse">Loading content...</p>
              </div>
            ) : (
              <>
                {isReadOnly && !shareClient ? (
                  <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
                    <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <ShieldCheck className="text-rose-400" size={32} />
                    </div>
                    <h3 className="text-slate-900 font-bold text-lg">Access Restricted</h3>
                    <p className="text-slate-500 mt-2">Please open the specific review link your team shared with you.</p>
                  </div>
                ) : view === 'calendar' ? (
                  <Suspense fallback={
                    <div className="flex items-center justify-center h-64" role="status" aria-label="Loading calendar">
                      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                    </div>
                  }>
                    <CalendarView
                      posts={calendarPosts}
                      currentDate={currentDate}
                      onDateChange={setCurrentDate}
                      onEdit={handleSelectPost}
                    />
                  </Suspense>
                ) : (
                  <>
                  {isReadOnly && approvalProgress && approvalProgress.total > 0 && (
                    <div className="mb-6 bg-white border border-slate-200 rounded-2xl p-4 sm:p-5">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-bold text-slate-800 text-sm">
                          {approvalProgress.approved} of {approvalProgress.total} approved
                        </h3>
                        <span className="text-xs font-medium text-slate-400">
                          {approvalProgress.pending > 0 ? `${approvalProgress.pending} awaiting your review` : approvalProgress.changes > 0 ? `${approvalProgress.changes} with requested changes` : 'All set 🎉'}
                        </span>
                      </div>
                      <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                          style={{ width: `${approvalProgress.total ? Math.round((approvalProgress.approved / approvalProgress.total) * 100) : 0}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {/* "N suggestions parked" nudge — the missing surfacing that made cron-parked
                      suggestions invisible unless the operator happened to notice the chip. Operator-
                      only (suggestionPosts is empty for everyone else), hidden on the lane itself and
                      on templates/archived, one click into the lane, session-dismissible. */}
                  {isOperator && !showTemplates && !showArchived && filterReview !== SUGGESTIONS_LANE && suggestionPosts.length > 0 && !suggestionsBannerDismissed && (
                    <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-3 sm:p-4">
                      <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                        <Lightbulb size={18} className="text-amber-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-amber-900">
                          {suggestionPosts.length} AI {suggestionPosts.length === 1 ? 'suggestion is' : 'suggestions are'} parked for your review
                        </p>
                        <p className="text-xs text-amber-700/80">From your automations — promote the good ones into a client&rsquo;s queue.</p>
                      </div>
                      <button
                        onClick={() => { setFilterReview(SUGGESTIONS_LANE); exitSelectionMode(); }}
                        className="shrink-0 flex items-center gap-1.5 bg-amber-500 text-white px-3 py-2 rounded-xl font-bold text-xs shadow-sm hover:bg-amber-600 transition-colors"
                      >
                        Review
                      </button>
                      <button
                        onClick={() => setSuggestionsBannerDismissed(true)}
                        aria-label="Dismiss suggestions notice"
                        title="Dismiss"
                        className="shrink-0 p-1.5 text-amber-500 hover:text-amber-700 rounded-full"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  {showTemplates ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                      <div>
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <Files size={18} className="text-indigo-500" /> Templates
                          <span className="text-xs font-semibold text-slate-400 tabular-nums">
                            {templatesList.length}{filterClient ? ` / ${TEMPLATE_LIMIT_PER_CLIENT}` : ''}
                          </span>
                        </h3>
                        <p className="text-xs text-slate-400 mt-0.5">Reusable evergreen content — “Use as draft” spins off a new post to tweak &amp; schedule.</p>
                      </div>
                      {/* The Templates view swaps out the FilterBar, so the density control
                          has to live here too — otherwise it disappears while still applying. */}
                      <div className="flex items-center gap-3">
                        {!isReadOnly && <DensityToggle value={density} onChange={setDensity} />}
                        {!isReadOnly && (() => {
                          const atLimit = !!filterClient && templatesList.length >= TEMPLATE_LIMIT_PER_CLIENT;
                          return (
                            <button
                              onClick={() => { setEditingPost({ isTemplate: true }); setView('editor'); }}
                              disabled={atLimit}
                              title={atLimit ? `Template limit reached (${TEMPLATE_LIMIT_PER_CLIENT}) for ${filterClient}` : 'New template'}
                              className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <Plus size={16} /> New template
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div className="mb-6">
                      <FilterBar
                        filterReview={filterReview}
                        /* Entering the suggestions lane drops any in-flight selection —
                           ids selected in the queue must not ride into a lane whose only
                           verbs are promote/dismiss. */
                        onReviewChange={(v) => { setFilterReview(v); if (v === SUGGESTIONS_LANE) exitSelectionMode(); }}
                        reviewCounts={reviewCounts}
                        /* Operator-only, and only once the lane has (or is showing) content —
                           no point advertising an empty lane to a chip row. */
                        showSuggestions={isOperator && (suggestionPosts.length > 0 || filterReview === SUGGESTIONS_LANE)}
                        suggestionCount={suggestionPosts.length}
                        filterStatus={filterStatus}
                        onStatusChange={setFilterStatus}
                        statusCounts={statusCounts}
                        filterMedia={filterMedia}
                        onMediaChange={setFilterMedia}
                        mediaCounts={mediaCounts}
                        filterNeeds={filterNeeds}
                        onNeedsChange={setFilterNeeds}
                        needsCounts={needsCounts}
                        filterPlatform={filterPlatform}
                        onPlatformChange={setFilterPlatform}
                        platformCounts={platformCounts}
                        filterTag={filterTag}
                        onTagChange={setFilterTag}
                        tagCounts={tagCounts}
                        sortBy={sortBy}
                        onSortChange={setSortBy}
                        showClientSort={isOperator}
                        density={density}
                        onDensityChange={setDensity}
                        /* Review guests stay on cards: their surface exists for READING the
                           copy before they sign off on it, and a one-line row invites
                           approving something you only skimmed. PostGrid pins it too. */
                        showDensity={!isReadOnly}
                        /* The queue facets don't apply on the Suggestions lane (filteredPosts
                           short-circuits before them) — hide the dead controls so their counts
                           can't mismatch the lane or silently carry a stale filter back out. */
                        showFacets={filterReview !== SUGGESTIONS_LANE}
                        activeFilterCount={activeFilterCount}
                        onClearFilters={clearFilters}
                      />
                    </div>
                  )}
                  <PostGrid
                    posts={showTemplates ? templatesList : filteredPosts}
                    clientMap={clientMap}
                    isReadOnly={isReadOnly}
                    onEdit={handleSelectPost}
                    onCloneToAll={handleCloneToAll}
                    onDuplicate={handleDuplicatePost}
                    onDelete={handleDeleteClick}
                    onStatusChange={handleStatusChange}
                    onArchive={handleArchivePost}
                    onRestore={handleRestorePost}
                    onUseTemplate={showTemplates ? handleUseTemplate : undefined}
                    onResubmit={handleResubmitForReview}
                    onSendForReview={!isReadOnly ? handleSendForReview : undefined}
                    onHoldFromReview={!isReadOnly ? handleHoldFromReview : undefined}
                    onPromoteSuggestion={isOperator ? handlePromoteSuggestion : undefined}
                    onDismissSuggestion={isOperator ? handleDismissSuggestion : undefined}
                    onPushToSender={isOperator ? handlePushToSender : undefined}
                    onPublishToSite={isOperator ? handlePublishToSite : undefined}
                    isSuggestionLane={filterReview === SUGGESTIONS_LANE}
                    /* Operators see machine-provenance badges (Auto/Suggested + source page);
                       clients & guests never do — matches the caution on machine-derived labels. */
                    showProvenance={isOperator}
                    onCreate={handleCreateNew}
                    density={density}
                    /* Only for the group headings — they have to follow the ordering or
                       their runs wouldn't be contiguous (see utils/grouping.js). */
                    sortBy={sortBy}
                    /* Collapses PostGrid's window back to page one whenever the CONTEXT
                       changes — but not on a mere data refresh, which would yank a
                       scrolled operator back to the top on every Firestore snapshot.
                       `density` is in here because each mode has its own page size: going
                       from 150 mounted rows straight to 150 mounted CARDS is precisely the
                       main-thread stall the window exists to prevent. */
                    resetKey={`${showTemplates}|${showArchived}|${filterClient}|${filterReview}|${filterStatus}|${filterPlatform}|${filterTag}|${filterMedia}|${filterNeeds}|${sortBy}|${density}|${searchLower}`}
                    selectable={!isReadOnly && !showTemplates && filterReview !== SUGGESTIONS_LANE && selectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                  />
                  </>
                )}
              </>
            )}
          </div>

          <BrandFooter />

        </main>
      </div>

      {confirmModal && (
        <ConfirmModal
          {...confirmModal}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {toast && <Toast message={toast.message} type={toast.type} action={toast.action} onClose={hideToast}/>}
      {user && !isReadOnly && (
        <FeedbackWidget user={user} role={role} clientId={myClientId} view={view} showToast={showToast} />
      )}
      {reviewingPost && (
        <ReviewModal
          post={reviewingPost}
          clientSettings={clientMap[reviewingPost.client] || DEFAULT_CLIENT_SETTINGS}
          onClose={() => setReviewingPost(null)}
          onApprove={() => { handleStatusChange(reviewingPost.id, STATUS.SCHEDULED); setReviewingPost(null); }}
          onRequestChanges={(fb) => handleRequestChanges(reviewingPost.id, fb)}
          /* The modal is the CLIENT's review surface today; the flag keeps the
             feedback attribution resolved against the viewer, not the author. */
          viewerIsClient={isReadOnly}
        />
      )}
      {isOperator && !showTemplates && filterReview !== SUGGESTIONS_LANE && selectionMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          totalFiltered={filteredPosts.length}
          uniqueClients={uniqueClients}
          onReassignClient={handleBulkReassignClient}
          onAddTags={handleBulkAddTags}
          onRemoveTags={handleBulkRemoveTags}
          onSetStatus={handleBulkStatus}
          onSendForReview={handleBulkSendForReview}
          onHold={handleBulkHold}
          onArchive={handleBulkArchive}
          onDelete={handleBulkDelete}
          onExport={() => handleExport('selected', 'csv')}
          onSelectAll={() => setSelectedIds(new Set(filteredPosts.map(p => p.id)))}
          onClear={clearSelection}
        />
      )}
      {isClientSettingsOpen && isOperator && (
        <Suspense fallback={<ModalFallback />}>
          <ClientSettingsModal onClose={() => setIsClientSettingsOpen(false)} uniqueClients={uniqueClients} clientMap={clientMap} uid={isOperator ? OPERATOR_UID : user?.uid} isReadOnly={isReadOnly} onMergeClient={handleMergeClient} clientIdFor={clientIdFor} />
        </Suspense>
      )}
      {isShareOpen && !isReadOnly && (
        <Suspense fallback={<ModalFallback />}>
          <ShareManager
            onClose={() => setIsShareOpen(false)}
            uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
            initialClient={isOperator ? (filterClient || '') : (myClientName || '')}
            /* The SAME roster-aware resolver drafts are stamped with (member names pin to their
               own clientId, as MediaLibrary does) — the review token must bind to the tenant key
               the drafts actually carry, or the review page comes up permanently empty. */
            clientIdFor={isOperator ? clientIdFor : ((name) => (name === myClientName ? myClientId : clientIdFor(name)))}
            showToast={showToast}
          />
        </Suspense>
      )}
      {isMediaOpen && (isOperator || isClientMember) && (
        <Suspense fallback={<ModalFallback />}>
          <MediaLibrary
            onClose={() => setIsMediaOpen(false)}
            /* Client members get the library too, pinned to their own client (the
               worker enforces the same tenant boundary server-side). */
            uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
            initialClient={isOperator ? (filterClient || '') : (myClientName || '')}
            /* A member's display name may drift from their hand-authored slug —
               resolve their own name straight to their pinned clientId. */
            clientIdFor={isOperator ? clientIdFor : ((name) => (name === myClientName ? myClientId : clientIdFor(name)))}
            postImagesByClient={postImagesByClient}
            showToast={showToast}
          />
        </Suspense>
      )}
      {isAdminOpen && isOperator && (
        <Suspense fallback={<ModalFallback />}>
          <AdminPanel
            onClose={() => setIsAdminOpen(false)}
            currentEmail={user?.email || ''}
            showToast={showToast}
            /* The App-level roster (single fetch — see useClients) drives the picker. */
            clients={rosterClients}
            clientsLoading={rosterLoading}
          />
        </Suspense>
      )}
      {isAutomationsOpen && isOperator && (
        <Suspense fallback={<ModalFallback />}>
          <AutomationsPanel
            onClose={() => setIsAutomationsOpen(false)}
            uniqueClients={uniqueClients}
            initialClient={filterClient || ''}
            clientIdByName={clientIdByName}
            showToast={showToast}
          />
        </Suspense>
      )}
      {isDataOpen && !isReadOnly && (isOperator || isClientMember) && (
        <Suspense fallback={<ModalFallback />}>
          <ImportExportModal
            posts={posts}
            uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
            isOperator={isOperator}
            scopeClient={isOperator ? null : (myClientName || myClientId)}
            onImport={handleImportRows}
            onClose={() => setIsDataOpen(false)}
            showToast={showToast}
          />
        </Suspense>
      )}
    </ErrorBoundary>
  );
};

export default App;
