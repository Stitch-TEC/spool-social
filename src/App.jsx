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
import { STATUS, PLATFORMS, APPROVAL_STATUS, DEFAULT_CLIENT_SETTINGS, TEMPLATE_LIMIT_PER_CLIENT } from './constants';
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
import StatusFilterChips from './components/StatusFilterChips';
import Toast from './components/Toast';
import FeedbackWidget from './components/FeedbackWidget';
import ConfirmModal from './components/ConfirmModal';
import ReviewModal from './components/ReviewModal';
import CalendarView from './components/CalendarView';
import ClientSettingsModal from './components/ClientSettingsModal';
import MediaLibrary from './components/MediaLibrary';
import ImportExportModal from './components/ImportExportModal';
import PostControls from './components/PostControls';
import { sortPosts, SORT_ORDERS } from './utils/helpers';
import { useClients } from './hooks/useClients';
import BulkActionBar from './components/BulkActionBar';
import ShareManager from './components/ShareManager';
import AdminPanel from './components/AdminPanel';
import AutomationsPanel from './components/AutomationsPanel';
import { OPERATOR_UID, slugifyClientId } from './config/roles';

const Editor = lazy(() => import('./components/Editor'));

// Case/whitespace-insensitive key for roster display-name lookups (rename drift is usually
// casing/spacing: "OMNI  nde" must still find "OMNI NDE"'s canonical slug).
const normClientName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const App = () => {
  // --- Session & data ---
  const { toast, showToast, hideToast } = useToast();
  const { user, authLoading, sharedUid, shareClient, shareClientId, isReadOnly, shareError, authzError, role, clientId: myClientId, isOperator, isClientMember, signIn, signOutAndExit } = useAuth(showToast);
  const { posts, clientMap, isLoading: postsLoading, error: postsError } = usePosts(user, sharedUid, myClientId, shareClientId, isOperator);
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
  const [filterStatus, setFilterStatus] = useState(null); // null | status | 'changes_requested'
  const [filterPlatform, setFilterPlatform] = useState(null); // null | platform id
  const [filterTag, setFilterTag] = useState(null); // null | tag string
  // Default: what's coming up soonest sits at the top (the next thing to handle).
  const [sortBy, setSortBy] = useState(SORT_ORDERS.SCHEDULED_ASC); // grid sort order
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
  // Roster display-name → slug map (normalized keys). Empty whenever the roster is
  // unavailable (client member, fetch failed, not loaded yet) — the ladder below then
  // degrades to exactly the pre-roster behavior, so drafting never blocks on the roster.
  const rosterSlugByName = useMemo(() => {
    const m = new Map();
    for (const c of rosterClients) {
      const key = normClientName(c?.name);
      if (key && c?.slug && !m.has(key)) m.set(key, c.slug);
    }
    return m;
  }, [rosterClients]);

  // Canonical clientId resolution ladder (roster-aware, fail-open):
  //   1. stamped posts-derived map — a name already seen on posts keeps its exact stamped id;
  //   2. ROSTER match by normalized display name — a first-time/drifted display name resolves
  //      to the client's canonical suite slug instead of minting a phantom (the old bug: the
  //      phantom stuck and the aiQuota 429 never fired for that client);
  //   3. slugifyClientId(name) — when this equals a roster slug it IS the roster match by slug
  //      equality (same string either way); otherwise it's the LAST-resort legacy mint, kept so
  //      resolution never blocks when the roster is empty/unavailable.
  const clientIdFor = useCallback(
    (name) => clientIdByName[name] || rosterSlugByName.get(normClientName(name)) || slugifyClientId(name),
    [clientIdByName, rosterSlugByName]
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
    if (isReadOnly) return;

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

    if (!client) return showToast("Client name is required", "error");
    if (!content) return showToast("Content cannot be empty", "error");
    if (content.length > platform.maxChars) {
      return showToast(`Content exceeds ${platform.name} limit (${platform.maxChars} chars)`, "error");
    }

    // Evergreen cap: block a NEW template (or flipping an existing post into one)
    // once this client is at the per-client limit. Editing a post that's ALREADY
    // a template is always fine — it's already counted.
    if (formData.isTemplate && !existingPost?.isTemplate) {
      const templateCount = postsRef.current.filter(p => p.isTemplate && p.client === client).length;
      if (templateCount >= TEMPLATE_LIMIT_PER_CLIENT) {
        return showToast(`Template limit reached (${TEMPLATE_LIMIT_PER_CLIENT}) for ${client}. Delete one to add another.`, "error");
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
      const approvalStatus = Object.values(APPROVAL_STATUS).includes(formData.approvalStatus) ? formData.approvalStatus : APPROVAL_STATUS.PENDING;

      // Saving a parked suggestion must NOT silently promote it: stamping a clientId is
      // exactly what makes a post client-visible, so keep it empty — promotion is the
      // explicit "Use this" action on the suggestion card. Checked on BOTH the stored doc
      // and the incoming form data, so an id-stripped copy (duplicate) of a suggestion
      // stays a suggestion instead of minting a live draft.
      const isSuggestion = (existingPost ?? formData)?.source === 'suggestion';

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
        title: (formData.title || "").trim().slice(0, 200),
        altText: (formData.altText || "").trim().slice(0, 300),
        metaDescription: (formData.metaDescription || "").trim().slice(0, 200),
        slug: (formData.title || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
        platform: platformId,
        status,
        approvalStatus,
        feedback: (formData.feedback || "").trim().slice(0, 500),
        imageUrl: imageUrl.slice(0, 500000),
        tags,
        // Evergreen flag: templates live in the posts collection but are excluded
        // from the dated queue + the drafts API — surfaced only in the Templates view.
        // Forced off for suggestions: a suggestion-template hybrid would sit in two lanes
        // with two conflicting action rows.
        isTemplate: isSuggestion ? false : !!formData.isTemplate,
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
    try {
      await updateDoc(doc(db, 'posts', postId), {
        status: newStatus,
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
    try {
      const now = new Date().toISOString();
      const CHUNK = 450; // Firestore writeBatch hard limit is 500 ops
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = writeBatch(db);
        rows.slice(i, i + CHUNK).forEach(item => {
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
            scheduledDate: item.scheduledDate || null,
            createdAt: now,
            updatedAt: now,
            source: 'import'
          });
        });
        await batch.commit();
      }
      showToast(`Imported ${rows.length} thread${rows.length === 1 ? '' : 's'}! 🚀`);
      return true;
    } catch (err) {
      console.error("Import error:", err);
      showToast("Import failed. Please try again.", "error");
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
        updatedAt: new Date().toISOString()
      });
      showToast("Sent back for review 🔁");
    } catch {
      showToast("Couldn't update — please try again", "error");
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
        tags: (post.tags || []).filter(t => t !== 'suggested'),
        // Promote always lands a LIVE pending draft — un-archive and clear any template
        // flag so the client actually sees what the success toast promises.
        ...(post.status === STATUS.ARCHIVED ? { status: STATUS.DRAFT } : {}),
        ...(post.isTemplate ? { isTemplate: false } : {}),
        updatedAt: new Date().toISOString()
      });
      showToast(`Added to ${post.client || 'the client'}'s review queue ✓`);
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
  const handlePushToSender = useCallback(async (post) => {
    if (isReadOnly || !isOperator) return;
    showToast('Pushing to Sender…');
    try {
      const out = await pushToSender(post.id);
      showToast(out.updated
        ? 'Sender template updated — review it in Sender → Templates'
        : 'Pushed to Sender — review it in Sender → Templates');
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('no_tenant_for_slug')) showToast('This client doesn’t have a Sender workspace yet', 'error');
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
  }, [isReadOnly, user, isClientMember, myClientName, myClientId, clientIdFor]);

  // Client/archive/search scope — the set BEFORE the platform + status filters.
  // Platform-filter counts derive from here so every platform with posts in the
  // current context is offered (and the count reflects client/search/archive).
  const scopedPosts = useMemo(() => {
    const searchLower = deferredSearchQuery.toLowerCase();

    return posts.filter(post => {
      if (post.isTemplate) return false; // templates live in their own view, not the queue
      if (post.source === 'suggestion') return false; // parked suggestions have their own lane below
      const matchesClient = filterClient ? post.client === filterClient : true;
      const matchesArchive = showArchived ? post.status === STATUS.ARCHIVED : post.status !== STATUS.ARCHIVED;
      const matchesSearch =
        !searchLower ||
        post._searchContent?.includes(searchLower) ||
        post._searchClient?.includes(searchLower);

      return matchesClient && matchesArchive && matchesSearch;
    });
  }, [posts, filterClient, showArchived, deferredSearchQuery]);

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
    if (!isOperator) return [];
    const searchLower = deferredSearchQuery.toLowerCase();
    return posts.filter(post =>
      post.source === 'suggestion' &&
      (filterClient ? post.client === filterClient : true) &&
      (!searchLower || post._searchContent?.includes(searchLower) || post._searchClient?.includes(searchLower))
    );
  }, [isOperator, posts, filterClient, deferredSearchQuery]);

  // Evergreen templates (client/search scoped, newest first). Their own area.
  const templatesList = useMemo(() => {
    const searchLower = deferredSearchQuery.toLowerCase();
    return posts.filter(post =>
      post.isTemplate &&
      post.source !== 'suggestion' && // a bad doc must never sit in two lanes at once
      (filterClient ? post.client === filterClient : true) &&
      (!searchLower || post._searchContent?.includes(searchLower) || post._searchClient?.includes(searchLower))
    );
  }, [posts, filterClient, deferredSearchQuery]);

  const platformCounts = useMemo(() => {
    const counts = {};
    for (const p of scopedPosts) counts[p.platform] = (counts[p.platform] || 0) + 1;
    return counts;
  }, [scopedPosts]);

  // Tag counts across the scope (a post carries several tags → counted once each).
  const tagCounts = useMemo(() => {
    const counts = {};
    for (const p of scopedPosts) for (const t of (p.tags || [])) counts[t] = (counts[t] || 0) + 1;
    return counts;
  }, [scopedPosts]);

  // Add the platform + tag filters. Status chips + their counts are applied on
  // top of this, so a chip count reflects the selected platform/tag too.
  const baseFilteredPosts = useMemo(
    () => scopedPosts.filter(p =>
      (!filterPlatform || p.platform === filterPlatform) &&
      (!filterTag || (p.tags || []).includes(filterTag))
    ),
    [scopedPosts, filterPlatform, filterTag]
  );

  const statusCounts = useMemo(() => {
    const counts = {
      all: baseFilteredPosts.length,
      [STATUS.DRAFT]: 0,
      [STATUS.SCHEDULED]: 0,
      [STATUS.POSTED]: 0,
      [APPROVAL_STATUS.CHANGES_REQUESTED]: 0,
      // Not a status — the parked-suggestions lane's count for its chip (excluded from `all`
      // above because suggestions are filtered out of the queue scope entirely).
      suggestions: suggestionPosts.length
    };
    baseFilteredPosts.forEach(p => {
      if (counts[p.status] !== undefined) counts[p.status]++;
      if (p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) counts[APPROVAL_STATUS.CHANGES_REQUESTED]++;
    });
    return counts;
  }, [baseFilteredPosts, suggestionPosts]);

  const filteredPosts = useMemo(() => {
    // The Suggestions chip swaps in the parked lane (operator-only; platform/tag filters don't
    // apply — their counts derive from the queue scope, which excludes suggestions).
    if (filterStatus === 'suggestions') return sortPosts(suggestionPosts, sortBy);
    let result = baseFilteredPosts;
    if (filterStatus === APPROVAL_STATUS.CHANGES_REQUESTED) {
      result = baseFilteredPosts.filter(p => p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED);
    } else if (filterStatus) {
      result = baseFilteredPosts.filter(p => p.status === filterStatus);
    }
    return sortPosts(result, sortBy);
  }, [baseFilteredPosts, suggestionPosts, filterStatus, sortBy]);

  const calendarPosts = useMemo(() => {
    if (view !== 'calendar') return [];
    return filteredPosts.filter(p => p.scheduledDate instanceof Date);
  }, [filteredPosts, view]);

  // Guest review progress ("5 of 8 approved").
  const approvalProgress = useMemo(() => {
    if (!isReadOnly) return null;
    const total = filteredPosts.length;
    const approved = filteredPosts.filter(p => p.approvalStatus === APPROVAL_STATUS.APPROVED).length;
    const changes = filteredPosts.filter(p => p.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED).length;
    return { total, approved, changes, pending: Math.max(0, total - approved - changes) };
  }, [isReadOnly, filteredPosts]);

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
  const commitBulk = useCallback(async (mutate, successMsg, { clearAfter = false } = {}) => {
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
    if (updates.length === 0) return showToast("No changes to apply");
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
    commitBulk(() => ({ client: c, clientId: clientIdFor(c) }), n => `Moved ${n} thread${n === 1 ? '' : 's'} to "${c}"`, { clearAfter: true });
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
              : { client: to, clientId: targetClientId, updatedAt: now })
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
      showToast(`${isMerge ? 'Merged' : 'Renamed'} "${from}" → "${to}" (${affected.length} thread${affected.length === 1 ? '' : 's'})`);
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
            onShowArchived={(v) => { setShowArchived(v); setShowTemplates(false); setFilterStatus(null); }}
            showTemplates={showTemplates}
            onShowTemplates={(v) => { setShowTemplates(v); if (v) { setShowArchived(false); setFilterStatus(null); exitSelectionMode(); } }}
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
            onNew={() => setView('editor')}
            onSignOut={signOutAndExit}
            userEmail={user?.email || ''}
            role={role}
          />

          {postsError && (
            <div className="bg-rose-50 border-b border-rose-100 px-4 sm:px-6 py-2 text-sm text-rose-700 font-medium text-center" role="alert">
              Connection issue — live updates may be delayed. Retrying automatically…
            </div>
          )}

          <div className={`flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full ${selectionMode && selectedIds.size > 0 ? 'pb-28' : ''}`}>
            <div className="flex items-center justify-between mb-6 gap-3">
              <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2 min-w-0">
                <span className="truncate">{view === 'calendar' ? 'Calendar' : (filterClient ? `${filterClient} Threads` : 'All Threads')}</span>
                {filterClient && isOperator && (
                  <button onClick={() => setFilterClient(null)} title="Clear Filter" aria-label="Clear Filter" className="text-slate-400 hover:text-rose-500 shrink-0"><X size={20}/></button>
                )}
              </h2>
              {/* Selection/bulk actions stay off the suggestions lane — bulk verbs (reassign,
                  status, archive) would side-step the explicit promote/dismiss flow. */}
              {isOperator && view === 'grid' && !showTemplates && filterStatus !== 'suggestions' && filteredPosts.length > 0 && (
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
                  <CalendarView
                    posts={calendarPosts}
                    currentDate={currentDate}
                    onDateChange={setCurrentDate}
                    onEdit={handleSelectPost}
                  />
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
                  {isOperator && !showTemplates && !showArchived && filterStatus !== 'suggestions' && statusCounts.suggestions > 0 && !suggestionsBannerDismissed && (
                    <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-3 sm:p-4">
                      <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                        <Lightbulb size={18} className="text-amber-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-amber-900">
                          {statusCounts.suggestions} AI {statusCounts.suggestions === 1 ? 'suggestion is' : 'suggestions are'} parked for your review
                        </p>
                        <p className="text-xs text-amber-700/80">From your automations — promote the good ones into a client&rsquo;s queue.</p>
                      </div>
                      <button
                        onClick={() => { setFilterStatus('suggestions'); exitSelectionMode(); }}
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
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                      {!showArchived
                        ? <StatusFilterChips
                            value={filterStatus}
                            /* Entering the suggestions lane drops any in-flight selection —
                               ids selected in the queue must not ride into a lane whose only
                               verbs are promote/dismiss. */
                            onChange={(v) => { setFilterStatus(v); if (v === 'suggestions') exitSelectionMode(); }}
                            counts={statusCounts}
                            /* Operator-only, and only once the lane has (or is showing) content —
                               no point advertising an empty lane to a chip row. */
                            showSuggestions={isOperator && (statusCounts.suggestions > 0 || filterStatus === 'suggestions')}
                          />
                        : <span />}
                      <PostControls
                        sortBy={sortBy}
                        onSortChange={setSortBy}
                        filterPlatform={filterPlatform}
                        onPlatformChange={setFilterPlatform}
                        platformCounts={platformCounts}
                        filterTag={filterTag}
                        onTagChange={setFilterTag}
                        tagCounts={tagCounts}
                        showClientSort={isOperator}
                        /* Platform/tag filters don't apply on the Suggestions lane (filteredPosts
                           short-circuits before them) — hide the dead controls so their counts
                           can't mismatch the lane or silently carry a stale filter back out. */
                        showFilters={filterStatus !== 'suggestions'}
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
                    onPromoteSuggestion={isOperator ? handlePromoteSuggestion : undefined}
                    onDismissSuggestion={isOperator ? handleDismissSuggestion : undefined}
                    onPushToSender={isOperator ? handlePushToSender : undefined}
                    onPublishToSite={isOperator ? handlePublishToSite : undefined}
                    isSuggestionLane={filterStatus === 'suggestions'}
                    /* Operators see machine-provenance badges (Auto/Suggested + source page);
                       clients & guests never do — matches the caution on machine-derived labels. */
                    showProvenance={isOperator}
                    onCreate={() => setView('editor')}
                    selectable={!isReadOnly && !showTemplates && filterStatus !== 'suggestions' && selectionMode}
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
        />
      )}
      {isOperator && !showTemplates && filterStatus !== 'suggestions' && selectionMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          totalFiltered={filteredPosts.length}
          uniqueClients={uniqueClients}
          onReassignClient={handleBulkReassignClient}
          onAddTags={handleBulkAddTags}
          onRemoveTags={handleBulkRemoveTags}
          onSetStatus={handleBulkStatus}
          onArchive={handleBulkArchive}
          onDelete={handleBulkDelete}
          onExport={() => handleExport('selected', 'csv')}
          onSelectAll={() => setSelectedIds(new Set(filteredPosts.map(p => p.id)))}
          onClear={clearSelection}
        />
      )}
      {isClientSettingsOpen && isOperator && (
        <ClientSettingsModal onClose={() => setIsClientSettingsOpen(false)} uniqueClients={uniqueClients} clientMap={clientMap} uid={isOperator ? OPERATOR_UID : user?.uid} isReadOnly={isReadOnly} onMergeClient={handleMergeClient} clientIdFor={clientIdFor} />
      )}
      {isShareOpen && !isReadOnly && (
        <ShareManager
          onClose={() => setIsShareOpen(false)}
          uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
          initialClient={isOperator ? (filterClient || '') : (myClientName || '')}
          clientIdByName={isOperator ? clientIdByName : (myClientName ? { [myClientName]: myClientId } : {})}
          showToast={showToast}
        />
      )}
      {isMediaOpen && (isOperator || isClientMember) && (
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
      )}
      {isAdminOpen && isOperator && (
        <AdminPanel
          onClose={() => setIsAdminOpen(false)}
          currentEmail={user?.email || ''}
          showToast={showToast}
          /* The App-level roster (single fetch — see useClients) drives the picker. */
          clients={rosterClients}
          clientsLoading={rosterLoading}
        />
      )}
      {isAutomationsOpen && isOperator && (
        <AutomationsPanel
          onClose={() => setIsAutomationsOpen(false)}
          uniqueClients={uniqueClients}
          initialClient={filterClient || ''}
          clientIdByName={clientIdByName}
          showToast={showToast}
        />
      )}
      {isDataOpen && !isReadOnly && (isOperator || isClientMember) && (
        <ImportExportModal
          posts={posts}
          uniqueClients={isOperator ? uniqueClients : (myClientName ? [myClientName] : [])}
          isOperator={isOperator}
          scopeClient={isOperator ? null : (myClientName || myClientId)}
          onImport={handleImportRows}
          onClose={() => setIsDataOpen(false)}
          showToast={showToast}
        />
      )}
    </ErrorBoundary>
  );
};

export default App;
