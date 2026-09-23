import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useDeferredValue } from 'react';
import {
  X, Save, Wand2, Smartphone, Image as ImageIcon, Eye, Sparkles,
  Trash2, UploadCloud, Calendar as CalendarIcon, Loader2, History
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import MobilePreview from './MobilePreview';
import MarkdownPreview from './MarkdownPreview';
import MarkdownToolbar from './MarkdownToolbar';
import RepurposeBlog from './RepurposeBlog';
import MediaPicker from './MediaPicker';
import SparkDeck from './SparkDeck';
import SenderEmailPreview from './SenderEmailPreview';
import AIGenerate from './AIGenerate';
import CharCountCircle from './CharCountCircle'; // ✅ NEW
import ConfirmModal from './ConfirmModal';
import SaveRecoveryHelp from './SaveRecoveryHelp';
import { PLATFORMS, STATUS, DEFAULT_CLIENT_SETTINGS } from '../constants';
import { processImageFile } from '../utils/helpers';
import { replaceRange, computeWrapToggle, WRAPS, twitterLength, looksLikeSocialMarkdown, containsRawHtml } from '../utils/markdownEditing';
import { describeImage, generateText, ensureHostedImage } from '../utils/generationApi';
import { slugifyClientId } from '../config/roles';
import { EDITOR_WORK_FIELDS as WORK_FIELDS, editorWorkSignature as workSignature, reconcileEditorSave } from '../utils/editorSaveState';
import { recoveryScope, readRecovery } from '../utils/editorRecovery';
import useAsyncRequest from '../hooks/useAsyncRequest';
import useCreateRecovery from '../hooks/useCreateRecovery';
import { createScope } from '../utils/createJournal';

// Converts a Date to a `datetime-local` input value in the user's local timezone.
// (Plain toISOString() is UTC, which shifts the default time by the tz offset.)
const toLocalISOString = (date) => {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

// Platform-aware modifier: on macOS the shortcuts bind to ⌘ ONLY — Ctrl+B/K in
// a Mac textarea are native Cocoa caret/kill bindings that must keep working.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|od|ad)/i.test(navigator.platform || '');

// Static class strings so Tailwind's JIT can detect them (dynamic `border-${x}` is purged).
const PLATFORM_ACTIVE_CLASSES = {
  gmb: 'border-blue-500 bg-blue-50',
  facebook: 'border-[#1877F2] bg-blue-50',
  linkedin: 'border-sky-500 bg-sky-50',
  twitter: 'border-slate-800 bg-slate-50',
  instagram: 'border-pink-500 bg-pink-50',
  blog: 'border-emerald-500 bg-emerald-50',
  job: 'border-violet-500 bg-violet-50',
};

const Editor = ({ post, onSave, onCancel, clientMap, uniqueClients, clientIdByName, clientIdFor, showToast, isReadOnly, onCreateDrafts, postImagesByClient = {}, initialClient = '', clientLocked = false, canPreviewEmail = false, recoveryPrincipalId = '', recoveryClientIdFor, createRecoveryEnabled = false, recoveryProjectId = '', getRecoveryUser }) => {
  const allClients = useMemo(() => {
    const set = new Set([...(uniqueClients || []), ...Object.keys(clientMap || {})]);
    return [...set].sort();
  }, [uniqueClients, clientMap]);

  // The selected client's suite SLUG — attributes AI generation to the client at the gateway meter.
  // Resolution order: the edited post's already-stamped id, then the posts-derived name→id map
  // (App.jsx passes it role-scoped), then the branding doc's stamped id, then App's roster-aware
  // clientIdFor (which matches the roster by normalized display name before falling back to
  // slugify — a drifted display name previously metered under a phantom slug). The bare slugify
  // tail survives only as a defensive default when the prop isn't wired (e.g. isolated renders).
  const genClientId = (name) => (
    (post?.client === name && post?.clientId)
      || clientIdByName?.[name]
      || clientMap?.[name]?.clientId
      || (name ? (clientIdFor ? clientIdFor(name) : slugifyClientId(name)) : '')
  );

  const [formData, setFormDataState] = useState({
    platform: 'gmb',
    content: '',
    title: '',
    altText: '',
    metaDescription: '',
    // New posts start with the caller's client context (the active sidebar filter,
    // or a client member's own client) so the media picker's per-client sections
    // work immediately — previously they only appeared when editing an existing post.
    client: initialClient,
    imageUrl: '',
    scheduledDate: toLocalISOString(new Date()),
    status: STATUS.DRAFT,
    tags: [],
    isTemplate: false
  });
  const [previewMode, setPreviewMode] = useState(false);
  // Preview pane tab: the channel preview, or the EMAIL this draft becomes if
  // pushed to Sender (operator-only, pushable posts only — blog or template).
  const [previewTab, setPreviewTab] = useState('channel');
  const [isSparkOpen, setIsSparkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // What the media picker fills: the cover image slot, or an inline markdown
  // image at the captured cursor position (toolbar image button, long-form).
  const [pickerMode, setPickerMode] = useState('cover');
  const inlineRangeRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCheckingPreviousSave, setIsCheckingPreviousSave] = useState(false);
  const savingRef = useRef(false);
  const lastSavedPost = useRef(null);
  const initializedForm = useRef(false);
  const newCreateSession = useRef(createRecoveryEnabled && !post?.id && post?.source !== 'suggestion').current;
  const [altLoading, setAltLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showDiscardUnsent, setShowDiscardUnsent] = useState(false);
  const [discardRecovery, setDiscardRecovery] = useState(null);
  // Locally-recovered unsaved work (see the autosave effects below).
  const [recovered, setRecovered] = useState(null);
  const textareaRef = useRef(null);

  // Last-saved (or loaded) snapshot — the unsaved-changes guard compares
  // against this. Seeded from the first render's defaults; the post-load
  // effect re-seeds it whenever a post is opened.
  const pristineRef = useRef(null);
  if (pristineRef.current === null) pristineRef.current = formData;

  // Mirror of the current content for callbacks that fire from child components
  // (AI results, Spark Deck) — reading state through a ref avoids acting on a
  // stale closure when the reply lands after further typing.
  const contentRef = useRef('');
  contentRef.current = formData.content;

  // Full form mirror for the flush paths (beforeunload, discard-confirm) whose
  // handlers are mounted once and must still snapshot CURRENT values.
  const formDataRef = useRef(formData);
  formDataRef.current = formData;
  // Async image/AI replies and a save acknowledgement can arrive in the same
  // React batch. Mirror updates synchronously so reconciliation includes work
  // already queued for rendering, not only the last painted form.
  const setFormData = (update) => {
    const next = typeof update === 'function' ? update(formDataRef.current) : update;
    formDataRef.current = next;
    scopeRef.current = scopeFor(next);
    contentRef.current = next.content;
    isDirtyRef.current = workSignature(next) !== workSignature(pristineRef.current);
    setFormDataState(next);
  };

  // The Restore toast outlives this editor (the Toast is App-owned) — its
  // action must know whether there is still an editor to restore into.
  const editorAliveRef = useRef(true);
  useEffect(() => {
    editorAliveRef.current = true;
    return () => {
      // An auth transition can unmount us before the debounce or pagehide.
      // Preserve latest work only under THIS editor's already-verified scope;
      // never save remotely or leave it for the incoming account to restore.
      writeAutosaveNow();
      editorAliveRef.current = false;
    };
    // The flush reads latest work/scope refs; it must run for the old session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openingPrincipal = useRef(recoveryPrincipalId);
  const scopeFor = (fd) => recoveryScope({
    principalId: openingPrincipal.current === recoveryPrincipalId ? recoveryPrincipalId : '',
    // Only authoritative IDs; unlike optional AI, recovery must not guess a
    // tenant from a display name when the roster is missing.
    clientId: (fd.client === lastSavedPost.current?.client && lastSavedPost.current?.clientId)
      || (fd.client === post?.client && (post?.clientId || post?.forClientId))
      || recoveryClientIdFor?.(fd.client) || '',
    postId: fd.id || post?.id,
    isTemplate: fd.isTemplate || post?.isTemplate,
  });
  const scopeRef = useRef(null);
  const readScopeKeyRef = useRef(null);
  scopeRef.current = scopeFor(formData);
  const scopeKey = scopeRef.current?.key || '';
  const intentScopeRef = useRef(null);
  const newScope = intentScopeRef.current || createScope({ principalId: recoveryPrincipalId, clientId: scopeRef.current?.clientId, projectId: recoveryProjectId, isTemplate: formData.isTemplate });
  const createRecovery = useCreateRecovery({
    enabled: newCreateSession && !isReadOnly,
    scope: newScope,
    getUser: getRecoveryUser,
    getWork: () => formDataRef.current,
    isAlive: () => editorAliveRef.current,
  });
  if (createRecovery.record && createRecovery.record.state !== 'draft') intentScopeRef.current = createRecovery.record.scope;
  const createRecoveryRef = useRef(createRecovery);
  createRecoveryRef.current = createRecovery;
  const createLocked = newCreateSession && (isSaving || (createRecovery.record && createRecovery.record.state !== 'draft'));
  useEffect(() => {
    if (newCreateSession && isDirtyRef.current) createRecovery.persist(formDataRef.current).catch(() => {});
    // Each edit is queued immediately, not only at pagehide (which Safari may
    // never finish). A completed browser transaction is not eviction immunity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData, newCreateSession, createRecovery.loading, createRecovery.restored]);
  const requestContext = JSON.stringify([recoveryPrincipalId, genClientId(formData.client), formData.platform]);
  const requests = useAsyncRequest(requestContext);
  useEffect(() => { setAltLoading(false); setMetaLoading(false); }, [requestContext]);
  // Bumped by clearAutosave so an in-flight debounced write can't resurrect a
  // snapshot that a successful save just removed.
  const autosaveGenRef = useRef(0);

  // --- Resizable preview panel (desktop) ---
  const PREVIEW_MIN = 320;
  const PREVIEW_MAX = 860;
  const [previewWidth, setPreviewWidth] = useState(() => {
    try {
      const saved = parseInt(window.localStorage?.getItem('spool:previewWidth'), 10);
      // Clamp to the CURRENT viewport too — a width persisted on a wide monitor
      // would otherwise squeeze the edit pane to a sliver on a smaller screen.
      const viewportMax = Math.max(PREVIEW_MIN, window.innerWidth - 360);
      return Number.isFinite(saved) ? Math.min(PREVIEW_MAX, viewportMax, Math.max(PREVIEW_MIN, saved)) : 420;
    } catch { return 420; }
  });
  const resizingRef = useRef(false);

  // Leave the edit pane at least ~360px; clamp to the configured bounds.
  const clampWidth = (w) =>
    Math.min(Math.min(PREVIEW_MAX, window.innerWidth - 360), Math.max(PREVIEW_MIN, w));

  useEffect(() => {
    const onMove = (e) => {
      if (!resizingRef.current) return;
      setPreviewWidth(clampWidth(window.innerWidth - e.clientX)); // panel is on the right
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  useEffect(() => {
    try { window.localStorage?.setItem('spool:previewWidth', String(previewWidth)); } catch { /* private mode */ }
  }, [previewWidth]);

  const startResize = (e) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const onHandleKey = (e) => {
    if (e.key === 'ArrowLeft') setPreviewWidth(w => clampWidth(w + 24));
    else if (e.key === 'ArrowRight') setPreviewWidth(w => clampWidth(w - 24));
    else return;
    e.preventDefault();
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  // Optimize the file, show it immediately, then swap the bulky data URL for a
  // hosted /media URL in the background (content-addressed, so the same photo
  // reused across posts keeps ONE URL). Falls back to the data URL on failure.
  const attachImageFile = async (file) => {
    try {
      const processedImage = await processImageFile(file);
      setFormData(prev => ({ ...prev, imageUrl: processedImage }));
      // Tag the pooled upload with the post's client so it stays scoped to that client in the picker.
      const hosted = await ensureHostedImage(processedImage, genClientId(formData.client));
      if (hosted !== processedImage) {
        // Only swap if the user hasn't replaced/removed the image meanwhile.
        setFormData(prev => (prev.imageUrl === processedImage ? { ...prev, imageUrl: hosted } : prev));
      }
    } catch {
      showToast("Error processing image", "error");
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) await attachImageFile(file);
  };

  useEffect(() => {
    // App opens a fresh Editor for each editing session. A roster/listener
    // refresh may change initialClient during that session; it must not reload
    // the original post over newer work or an acknowledged save baseline.
    if (initializedForm.current) return;
    initializedForm.current = true;
    if (post) {
      let safeDateString = toLocalISOString(new Date()); // Default to now (local time)
      
      if (post.scheduledDate) {
        // If it's a Date object
        if (post.scheduledDate instanceof Date && !isNaN(post.scheduledDate)) {
           safeDateString = toLocalISOString(post.scheduledDate);
        }
        // If it's a string
        else if (typeof post.scheduledDate === 'string') {
           const d = new Date(post.scheduledDate);
           if (!isNaN(d.getTime())) {
             safeDateString = toLocalISOString(d);
           }
        }
      }

      const defaultState = {
        platform: 'gmb',
        content: '',
        title: '',
        altText: '',
        metaDescription: '',
        client: initialClient,
        imageUrl: '',
        scheduledDate: safeDateString,
        status: STATUS.DRAFT,
        tags: [],
        isTemplate: false
      };
      const loaded = {
        ...defaultState,
        ...post,
        // A post with no client (e.g. "New template") still gets the caller's context.
        client: post.client || initialClient,
        scheduledDate: safeDateString
      };
      setFormData(loaded);
      // The loaded post IS the saved state — re-arm the unsaved-changes guard from it.
      pristineRef.current = loaded;
    }
    // This is deliberately mount-only initialization, not form synchronization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post, initialClient]);

  const isDirty = workSignature(formData) !== workSignature(pristineRef.current);
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  // Snapshot + write, shared by the debounced path and the synchronous flush
  // paths. Reads through refs so once-mounted handlers see current values.
  // Data-URL images are OMITTED (not blanked): a 500KB base64 blob would blow
  // the localStorage budget, and omitting means a restore leaves whatever image
  // the post currently has untouched.
  const writeAutosaveNow = () => {
    if (!editorAliveRef.current || isReadOnly || !isDirtyRef.current) return null;
    if (newCreateSession) {
      createRecoveryRef.current.persist(formDataRef.current).catch(() => {});
      // Do not promise a newly queued asynchronous write has already committed.
      return createRecoveryRef.current.stored(formDataRef.current) ? { imageOmitted: false } : null;
    }
    const scope = scopeRef.current;
    if (!scope) return null;
    const fd = formDataRef.current;
    const snap = {};
    for (const k of WORK_FIELDS) snap[k] = fd[k];
    const imageOmitted = typeof snap.imageUrl === 'string' && snap.imageUrl.startsWith('data:');
    if (imageOmitted) delete snap.imageUrl;
    snap.savedAt = Date.now();
    try {
      window.localStorage.setItem(scope.key, JSON.stringify({ scope, work: snap }));
      return { imageOmitted };
    } catch { return null; /* quota/private mode */ }
  };

  const clearAutosave = (scope = scopeRef.current) => {
    autosaveGenRef.current += 1; // invalidate any pending debounced write
    if (newCreateSession) return; // v2 copies have no create identity: never adopt/delete them.
    try { if (scope) window.localStorage?.removeItem(scope.key); } catch { /* private mode */ }
  };

  // Mobile Safari may suspend an installed app without firing beforeunload.
  // Flush when the page is hidden as well, including inside the debounce window.
  // This is device recovery only; it never saves or publishes the post remotely.
  useEffect(() => {
    const onBeforeUnload = (ev) => {
      if (isDirtyRef.current) {
        writeAutosaveNow();
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') writeAutosaveNow();
    };
    const onPageHide = () => writeAutosaveNow();
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // writeAutosaveNow reads the latest form and recovery-key refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Autosave: recover work lost to a crash, refresh, or stray click. ---
  // Offer recovery when a local snapshot differs from what the post actually
  // holds; silently clean up snapshots that match (i.e. the save went through).
  // The comparison is field-wise over EVERYTHING the snapshot captured — a
  // snapshot whose only divergence is schedule/status/tags/client must NOT be
  // treated as "already saved" and deleted. Declared AFTER the post-load effect
  // so pristineRef holds the loaded post when this runs.
  useEffect(() => {
    if (newCreateSession) return;
    scopeRef.current = scopeFor(formDataRef.current);
    if (readScopeKeyRef.current === scopeRef.current?.key) return;
    readScopeKeyRef.current = scopeRef.current?.key;
    let entry = null;
    try { if (scopeRef.current) entry = readRecovery(window.localStorage, scopeRef.current); } catch { /* storage unavailable */ }
    const saved = entry?.work;
    if (!saved) { setRecovered(null); return; }
    const pristine = pristineRef.current || {};
    const matchesLoaded = WORK_FIELDS.every((k) => {
      if (!(k in saved)) return true;
      // App trims content at save — don't let trailing whitespace alone summon a banner.
      if (k === 'content') return String(saved[k] ?? '').trim() === String(pristine[k] ?? '').trim();
      return JSON.stringify(saved[k] ?? null) === JSON.stringify(pristine[k] ?? null);
    });
    if (matchesLoaded) {
      clearAutosave();
      return;
    }
    setRecovered(entry);
    // Read recovery only on open. A newly acknowledged save changes the slot
    // directly; it must not reload an older recovery copy over current edits.
    // The client may be selected after opening a blank editor. Never read an
    // unscoped slot while waiting, and never show another client's banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Debounced write while dirty; the generation check keeps a timer that was
  // already queued when clearAutosave ran from resurrecting a stale snapshot.
  useEffect(() => {
    if (isReadOnly || !isDirty) return undefined;
    const gen = autosaveGenRef.current;
    const t = setTimeout(() => {
      if (gen !== autosaveGenRef.current) return;
      writeAutosaveNow();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData, isDirty, isReadOnly]);

  const restoreRecovered = () => {
    if (!recovered || recovered.scope.key !== scopeRef.current?.key) return;
    setFormData(prev => {
      const next = { ...prev };
      for (const k of WORK_FIELDS) {
        if (recovered.work[k] !== undefined) next[k] = recovered.work[k];
      }
      // A client member's posts stay pinned to their own client (save path
      // enforces it anyway — don't even show a recovered foreign name).
      // The immutable scope matched; preserve the current label across a rename.
      next.client = prev.client;
      return next;
    });
    setRecovered(null);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (file) await attachImageFile(file);
  };

  const currentPlatform = PLATFORMS[formData.platform] || PLATFORMS.gmb;
  const isLongForm = currentPlatform.longForm === true;
  // X/Twitter counts URLs as 23 (t.co) and emoji/CJK as 2 — raw .length lies in
  // both directions there. Everywhere else the raw length is the real limit.
  const charCount = formData.platform === 'twitter' ? twitterLength(formData.content) : formData.content.length;
  const isOverLimit = charCount > currentPlatform.maxChars;

  // ⚡ The live preview re-renders at DEFERRED priority: typing stays responsive
  // even while react-markdown re-parses a long blog post, and MobilePreview's memo
  // skips the urgent keystroke render entirely (its compared fields lag behind).
  const deferredContent = useDeferredValue(formData.content);
  const previewPost = useMemo(
    () => ({ ...formData, content: deferredContent }),
    [formData, deferredContent]
  );

  const handleSaveWrapper = async () => {
    if (isReadOnly || isOverLimit || !formData.content.trim() || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const submittedScope = scopeRef.current;
    const initiatingUser = newCreateSession ? getRecoveryUser?.() : null;
    let remoteConfirmed = false;
    try {
      // Keep the exact submitted snapshot while newer typing/AI/image work may
      // continue. Only the committed response can supply a new post's real ID.
      // Carry the value that was loaded into the editor separately from the
      // submitted value. The transactional save can then distinguish an
      // intentional workflow-status edit from a client approval that advanced
      // status concurrently while this editor was open.
      const result = await onSave(formData, {
        ...(newCreateSession && !formData.id ? {
          createPost: payload => createRecovery.submit(payload, formData, initiatingUser),
          isCurrentSession: () => !!initiatingUser && editorAliveRef.current && getRecoveryUser?.() === initiatingUser,
          createClientId: newScope?.clientId,
        } : {}),
        ...(lastSavedPost.current ? { savedPost: lastSavedPost.current } : {}),
        baselineStatus: pristineRef.current?.status,
        // Tenant intent needs the editor-open baseline just like workflow
        // status. postsRef may advance while the editor is open, so deriving
        // this at save time would mistake a concurrent reassignment for the
        // operator's request and could move the post back across tenants.
        baselineClientId: pristineRef.current?.clientId,
        baselineClient: pristineRef.current?.client,
      });
      if (!editorAliveRef.current) return;
      if (result?.ok === true) {
        remoteConfirmed = true;
        if (newCreateSession) {
          await createRecovery.persist(formDataRef.current);
          if (formData.id) await createRecovery.acknowledge(result.post);
          if (!editorAliveRef.current) return;
        }
        let next = reconcileEditorSave(result.submitted || formData, formDataRef.current, result.post);
        if (newCreateSession && !next.dirty) {
          await createRecovery.complete();
          // Retirement itself is asynchronous. An edit queued while it commits
          // must remain linked to this acknowledged ID, not close with old data.
          next = reconcileEditorSave(result.submitted || formData, formDataRef.current, result.post);
          if (next.dirty) await createRecovery.persist(formDataRef.current);
        }
        if (!editorAliveRef.current) return;
        next = reconcileEditorSave(result.submitted || formData, formDataRef.current, result.post);
        lastSavedPost.current = result.post;
        pristineRef.current = next.baseline;
        // Retire the old "new" slot only after the create is acknowledged.
        // Later saves now update that same ID even before the listener catches up.
        const previousScope = scopeRef.current;
        clearAutosave(submittedScope);
        scopeRef.current = scopeFor(next.form);
        readScopeKeyRef.current = scopeRef.current?.key;
        formDataRef.current = next.form;
        isDirtyRef.current = next.dirty;
        setFormData(next.form);
        setRecovered(null);
        if (next.dirty) {
          const stored = writeAutosaveNow();
          if (stored && previousScope?.key !== scopeRef.current?.key) clearAutosave(previousScope);
          showToast?.('Saved the earlier version. Your newer edits are still here — save again when ready.', 'success');
        } else {
          editorAliveRef.current = false;
          onCancel();
        }
      } else {
        writeAutosaveNow();
      }
    } catch (error) {
      if (!editorAliveRef.current) return;
      writeAutosaveNow();
      showToast?.(remoteConfirmed
        ? `Spool confirmed the save, but device recovery needs review. ${error.message || 'Keep this editor open and copy your text.'}`
        : newCreateSession
          ? 'Spool could not confirm this save. Keep your text and follow the recovery message below; use Check previous save if offered.'
          : 'Could not save this thread. Your edits are still here — please try again.', 'error');
    } finally {
      savingRef.current = false;
      if (editorAliveRef.current) setIsSaving(false);
    }
  };

  const checkPreviousSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setIsCheckingPreviousSave(true);
    try {
      const result = await createRecovery.check();
      if (!editorAliveRef.current) return;
      const next = reconcileEditorSave(result.submitted, formDataRef.current, result.post);
      lastSavedPost.current = result.post;
      pristineRef.current = next.baseline;
      setFormData(next.form);
      showToast?.('Previous save confirmed. Review your work here; Save will update that same thread.', 'success');
    } catch (error) { if (editorAliveRef.current) showToast?.(error.message, 'error'); }
    finally {
      savingRef.current = false;
      if (editorAliveRef.current) { setIsSaving(false); setIsCheckingPreviousSave(false); }
    }
  };

  const copyRecoveryText = async () => {
    const user = getRecoveryUser?.();
    const key = scopeRef.current?.key;
    const current = () => editorAliveRef.current && user && !user.isAnonymous
      && getRecoveryUser?.() === user && scopeRef.current?.key === key;
    const text = formDataRef.current.content;
    if (!current() || !text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      if (current()) showToast?.('Text copied. Images and settings are not included.', 'success');
    } catch {
      if (current()) showToast?.('Copy is unavailable here. Select the text in the editor and copy it manually.', 'error');
    }
  };

  // Wholesale content replacement (AI draft/improve, Spark Deck). One click
  // used to silently obliterate an hour of writing — now the previous version
  // rides along on the toast's Restore button. The toast is App-owned and can
  // outlive this editor (close right after replacing) — say so instead of
  // silently no-oping a setState on an unmounted component.
  const replaceContent = (txt) => {
    const prevContent = contentRef.current;
    setFormData(prev => ({ ...prev, content: txt }));
    if (prevContent.trim() && prevContent.trim() !== String(txt || '').trim()) {
      showToast?.('Content replaced', 'success', {
        label: 'Restore previous',
        onClick: () => {
          if (!editorAliveRef.current) {
            showToast?.('The editor was closed — reopen the draft to restore', 'error');
            return;
          }
          setFormData(p => ({ ...p, content: prevContent }));
        },
      });
    }
  };

  const requestCancel = () => {
    if (isDirty && !isReadOnly) {
      // Check storage before describing recovery. Safari can deny it, and a
      // data-URL image is deliberately too large to put in the local snapshot.
      setDiscardRecovery(writeAutosaveNow());
      setShowDiscardConfirm(true);
    }
    else { editorAliveRef.current = false; requests.cancel(); onCancel(); }
  };

  // Long-form drafts grow the textarea with the content (the surrounding pane
  // scrolls) instead of squeezing a 1,200-word post into a fixed 15-line box.
  // Social platforms keep the fixed height — their content is short by rule.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (!isLongForm) {
      ta.style.height = '';
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(384, ta.scrollHeight + 2)}px`;
  }, [formData.content, isLongForm, previewMode]);

  const handleAltText = async () => {
    if (altLoading || !formData.imageUrl) return;
    const request = requests.begin('alt');
    if (!request) return;
    setAltLoading(true);
    try {
      const alt = await describeImage(formData.imageUrl, {
        clientId: genClientId(formData.client),
        platform: formData.platform,
      });
      if (!requests.current(request)) return;
      setFormData(prev => ({ ...prev, altText: alt }));
      showToast?.('Alt text generated');
    } catch (err) {
      if (requests.current(request)) showToast?.(err.message || 'Alt text failed', 'error');
    } finally {
      if (requests.current(request)) setAltLoading(false);
      requests.finish(request);
    }
  };

  const handleMeta = async () => {
    if (metaLoading || !formData.content.trim()) return;
    const request = requests.begin('meta');
    if (!request) return;
    setMetaLoading(true);
    try {
      const meta = await generateText(
        `Write a compelling SEO meta description (max 155 characters, one sentence, no quotes) for the post below.\n\nTITLE: ${formData.title || ''}\n\nPOST:\n${formData.content}`,
        { maxTokens: 80, clientId: genClientId(formData.client), platform: formData.platform }
      );
      if (!requests.current(request)) return;
      setFormData(prev => ({ ...prev, metaDescription: meta.trim().slice(0, 200) }));
      showToast?.('Meta description generated');
    } catch (err) {
      if (requests.current(request)) showToast?.(err.message || 'Generation failed', 'error');
    } finally {
      if (requests.current(request)) setMetaLoading(false);
      requests.finish(request);
    }
  };

  return (
    <div className="h-full flex flex-col md:flex-row bg-white overflow-hidden animate-in slide-in-from-right duration-300">
      {/* Left Panel: Edit */}
      <div className={`flex-1 min-w-0 flex flex-col h-full border-r border-slate-200 ${previewMode ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-100 flex flex-wrap gap-3 justify-between items-center bg-white sticky top-0 z-10">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
             <button onClick={requestCancel} title="Close Editor" aria-label="Close Editor" className="p-2 hover:bg-slate-100 rounded-full text-slate-500"><X size={20}/></button>
             <h2 className="font-bold text-slate-800 text-lg">{formData.id ? 'Edit Thread' : 'New Thread'}</h2>
             {isDirty && !isReadOnly && (
               <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 uppercase tracking-wider" title="You have unsaved changes">
                 Unsaved
               </span>
             )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setPreviewMode(p => !p)}
              className="md:hidden flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-200 rounded-full px-3 py-2 hover:bg-slate-50"
            >
              <Eye size={14} /> {previewMode ? 'Edit' : 'Preview'}
            </button>
            <button
              onClick={handleSaveWrapper}
              disabled={isOverLimit || !formData.content.trim() || isReadOnly || isSaving || (newCreateSession && (createRecovery.loading || !createRecovery.restored || (!formData.id && ['submitted', 'confirmed'].includes(createRecovery.record?.state))))}
              className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2 rounded-full font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg min-w-[100px] justify-center"
            >
               {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
               <span>{isCheckingPreviousSave ? 'Checking…' : isSaving ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6">
          {newCreateSession && !isReadOnly && (!newScope || createRecovery.error || createRecovery.record || createRecovery.loading) && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2" aria-live="polite">
              <p className="text-sm font-bold text-amber-800">{createRecovery.loading ? 'Checking this device for previous work…' : !createRecovery.restored ? 'Previous work is available on this device' : createRecovery.record?.state === 'submitted' ? 'Spool has not confirmed this save' : createRecovery.record?.state === 'confirmed' ? 'Previous save confirmed' : 'New-draft recovery'}</p>
              <p className="text-xs text-amber-800">{createRecovery.error || (!newScope ? 'Select a known client before saving. Spool needs a verified account, client and project to keep this new draft recoverable.' : !createRecovery.restored ? 'Restore this copy before continuing. It stays with its original account and client.' : createRecovery.record?.state === 'submitted' ? 'Check the recorded thread when your connection returns. This check only reads; it will not send or create another copy.' : createRecovery.stored(formData) ? 'Your current work has a recovery copy on this device. Browser storage can still be cleared or unavailable.' : 'Your latest changes are not yet confirmed in device recovery. Keep this editor open or copy your text.')}</p>
              <div className="flex flex-wrap gap-2">
                {!createRecovery.restored && <button type="button" className="px-3 py-2 rounded-full bg-amber-700 text-white text-xs font-bold" onClick={() => {
                  if (formDataRef.current.content.trim()) { showToast?.('Copy or clear the text currently in this editor before restoring previous work.', 'error'); return; }
                  const work = createRecovery.restore();
                  if (work) setFormData(prev => ({ ...prev, ...work, client: prev.client }));
                }}>Restore previous work</button>}
                {createRecovery.restored && ['submitted', 'confirmed'].includes(createRecovery.record?.state) && <button type="button" disabled={isSaving} onClick={checkPreviousSave} className="px-3 py-2 rounded-full bg-amber-700 text-white text-xs font-bold disabled:opacity-50">{isCheckingPreviousSave ? 'Checking previous save…' : 'Check previous save'}</button>}
                {createRecovery.record?.state === 'draft' && <button type="button" disabled={isSaving} onClick={() => setShowDiscardUnsent(true)} className="px-3 py-2 rounded-full border border-amber-700 text-xs font-bold">Discard unsent recovery</button>}
                <button type="button" disabled={!formData.content.trim()} className="px-3 py-2 rounded-full border border-amber-700 text-xs font-bold disabled:opacity-50" onClick={copyRecoveryText}>Copy text</button>
              </div>
              <SaveRecoveryHelp record={createRecovery.record} scope={newScope} principalId={recoveryPrincipalId} projectId={recoveryProjectId} getUser={getRecoveryUser} />
            </div>
          )}
          {/* Recovered-work banner: a local snapshot exists that this post doesn't hold. */}
          {recovered && recovered.scope.key === scopeKey && !isReadOnly && (
            <div className="flex flex-wrap items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <History size={18} className="text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-[160px]">
                <p className="text-sm font-bold text-amber-800">Unsaved work recovered</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  A draft auto-saved {recovered.work.savedAt ? `on ${new Date(recovered.work.savedAt).toLocaleString()} ` : ''}for this account and client differs from what&apos;s shown. Restore it, or dismiss to keep what&apos;s here.
                </p>
              </div>
              <div className="flex gap-2 shrink-0 ml-auto">
                <button onClick={restoreRecovered} className="px-3 py-1.5 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-full">Restore</button>
                <button onClick={() => { setRecovered(null); clearAutosave(); }} className="px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100 rounded-full">Dismiss</button>
              </div>
            </div>
          )}

          {/* Platform Select */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Platform</label>
            <div className="grid grid-cols-2 sm:flex gap-2 sm:gap-4">
              {Object.values(PLATFORMS).map(p => (
                <button
                  key={p.id}
                  onClick={() => setFormData({ ...formData, platform: p.id })}
                  aria-pressed={formData.platform === p.id}
                  className={`flex-1 flex flex-row sm:flex-col items-center justify-center gap-2 p-2 sm:p-3 rounded-xl border-2 transition-all ${formData.platform === p.id ? (PLATFORM_ACTIVE_CLASSES[p.id] || 'border-indigo-500 bg-indigo-50') : 'border-slate-100 hover:border-slate-200'}`}
                >
                   <PlatformIcon platformId={p.id} size={20} className="sm:w-6 sm:h-6" />
                   <span className={`text-[10px] sm:text-xs font-bold ${formData.platform === p.id ? 'text-slate-800' : 'text-slate-400'}`}>{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {isLongForm && (
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Title</label>
              <input
                type="text"
                maxLength={200}
                placeholder="Post title…"
                value={formData.title || ''}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-base font-bold focus:border-indigo-500 focus:ring-0 transition-all"
              />
            </div>
          )}

          {isLongForm && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Meta description (SEO)</label>
                <button
                  type="button"
                  onClick={handleMeta}
                  disabled={metaLoading || !formData.content.trim()}
                  className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline disabled:opacity-50"
                >
                  {metaLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate
                </button>
              </div>
              <input
                type="text"
                maxLength={200}
                placeholder="One-sentence summary for search results…"
                value={formData.metaDescription || ''}
                onChange={(e) => setFormData({ ...formData, metaDescription: e.target.value })}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:border-indigo-500 focus:ring-0 transition-all"
              />
            </div>
          )}

          {/* Editor Area */}
          <div className="relative group">
            <div className="flex justify-between items-center mb-2 gap-3">
               <label className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">Content</label>
               <button onClick={() => setIsSparkOpen(true)} className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline shrink-0"><Wand2 size={12}/> <span>Spark Deck</span></button>
            </div>
            {!isReadOnly && (
              <div className="mb-2">
                <AIGenerate
                  kind="text"
                  platform={formData.platform}
                  clientName={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  currentText={formData.content}
                  showToast={showToast}
                  onResult={replaceContent}
                  onAppend={(tags) => setFormData(prev => ({ ...prev, content: (prev.content.trim() + '\n\n' + tags).trim() }))}
                />
              </div>
            )}
            {isLongForm && !isReadOnly && (
              <div className="mb-2">
                <RepurposeBlog
                  platform={formData.platform}
                  title={formData.title}
                  content={formData.content}
                  client={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  onCreateDrafts={onCreateDrafts}
                  showToast={showToast}
                />
              </div>
            )}
            {isLongForm && (
              <MarkdownToolbar
                textareaRef={textareaRef}
                onImageRequest={!isReadOnly ? () => {
                  // Capture where the cursor is NOW — opening the picker moves focus.
                  const ta = textareaRef.current;
                  inlineRangeRef.current = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
                  setPickerMode('inline');
                  setPickerOpen(true);
                } : undefined}
              />
            )}
            <textarea
               ref={textareaRef}
               className={`w-full ${isLongForm ? 'min-h-96 overflow-hidden' : 'h-64'} p-4 rounded-xl border-2 text-base leading-relaxed resize-none focus:ring-0 transition-all ${isOverLimit ? 'border-rose-300 focus:border-rose-500 bg-rose-50' : 'border-slate-200 focus:border-indigo-500 bg-white'}`}
               placeholder={currentPlatform.placeholder}
               value={formData.content}
               onChange={(e) => setFormData({ ...formData, content: e.target.value })}
               onKeyDown={(e) => {
                 if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                   e.preventDefault();
                   handleSaveWrapper();
                   return;
                 }
                 // Same bindings as Sender's builder (⌘B / ⌘I / ⌘K) so the two
                 // editors feel like one tool. Long-form markdown only — social
                 // channels are plain text where the markers would post literally.
                 if (isLongForm && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
                   const key = e.key.toLowerCase();
                   const cfg = key === 'b' ? WRAPS.bold : key === 'i' ? WRAPS.italic : key === 'k' ? WRAPS.link : null;
                   if (cfg) {
                     e.preventDefault();
                     const ta = e.currentTarget;
                     const r = computeWrapToggle(ta.value, ta.selectionStart, ta.selectionEnd, cfg);
                     replaceRange(ta, r.start, r.end, r.text, r.selStart, r.selEnd);
                   }
                 }
               }}
            />
            {/* Soft correctness hints — never block, just tell the truth about the target. */}
            {!isLongForm && looksLikeSocialMarkdown(formData.content) && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Markdown formatting (like **bold** or [links](…)) posts as literal characters on {currentPlatform.name} — write plain text here.
              </p>
            )}
            {isLongForm && containsRawHtml(formData.content) && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This draft contains raw HTML/JSX. The preview shows it as plain text, but the published site will interpret it — check the published result.
              </p>
            )}
            {/* ✅ RESTORED: Char Counter (hidden for long-form blog) */}
            {!isLongForm && (
              <div className="absolute bottom-16 right-4">
                 <CharCountCircle current={charCount} max={currentPlatform.maxChars} />
              </div>
            )}
          </div>

          {/* Evergreen: mark as a reusable template (kept out of the dated queue,
              lives in the Templates library — "Use as draft" clones it into a post).
              Hidden for parked suggestions: a suggestion-template hybrid would sit in two
              lanes at once (the save path forces the flag off for them regardless). */}
          {formData.source !== 'suggestion' && (
            <label className="flex items-center gap-2.5 mb-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!formData.isTemplate}
                disabled={createLocked}
                onChange={(e) => setFormData({ ...formData, isTemplate: e.target.checked })}
                className="accent-indigo-600 w-4 h-4 shrink-0"
              />
              <span className="text-sm font-semibold text-slate-700">Reusable template</span>
              <span className="text-xs text-slate-400 hidden sm:inline">— saved to your Templates library; no date needed</span>
            </label>
          )}

          {/* Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Schedule</label>
                <div className="relative">
                   <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                   <input type="datetime-local" value={formData.scheduledDate} onChange={(e) => setFormData({ ...formData, scheduledDate: e.target.value })} className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all" />
                </div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mt-4 mb-2">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all"
                >
                  <option value={STATUS.DRAFT}>Draft</option>
                  <option value={STATUS.SCHEDULED}>Scheduled</option>
                  <option value={STATUS.POSTED}>Posted</option>
                  {formData.status === STATUS.ARCHIVED && <option value={STATUS.ARCHIVED}>Archived</option>}
                </select>
             </div>
             <div className="flex flex-col gap-1">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Client Name</label>
                {/* 🔒 SECURITY: Input length limit. Client members are pinned to their own
                    client (the save path enforces it) — show the field locked instead of an
                    editable value that would silently be overridden. */}
                <input type="text" list="client-list" maxLength={50} placeholder="Select or type a new client..." value={formData.client} disabled={clientLocked || createLocked} title={createLocked ? 'Resolve the original save before changing its client' : clientLocked ? 'Posts are always saved to your own client' : undefined} onChange={(e) => setFormData({ ...formData, client: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all disabled:opacity-70 disabled:cursor-not-allowed" />
                <datalist id="client-list">
                    {allClients.map(c => <option key={c} value={c} />)}
                </datalist>
             </div>
             {/* Tag Management UI */}
             <div className="md:col-span-2">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Tags</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {formData.tags?.map((tag, i) => (
                      <span key={i} className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1">
                        #{tag}
                        <button
                          onClick={() => setFormData(prev => ({...prev, tags: prev.tags.filter((_, index) => index !== i)}))}
                          className="hover:text-rose-500 p-0.5 rounded-full hover:bg-rose-100 transition-colors"
                          title={`Remove tag #${tag}`}
                          aria-label={`Remove tag #${tag}`}
                        >
                          <X size={12}/>
                        </button>
                      </span>
                    ))}
                </div>
                <input 
                  type="text" 
                  placeholder={formData.tags?.length >= 10 ? "Limit reached (10 tags)" : "Type a tag and press Enter..."}
                  disabled={formData.tags?.length >= 10 || isReadOnly}
                  onKeyDown={(e) => {
                     if (e.key === 'Enter') {
                        e.preventDefault();
                        if (formData.tags?.length >= 10) return;

                        const val = e.target.value.trim().replace(/^#/, '').slice(0, 20);
                        if (val && !formData.tags?.includes(val)) {
                           setFormData(prev => ({...prev, tags: [...(prev.tags || []), val]}));
                        }
                        e.target.value = '';
                     }
                  }} 
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all disabled:opacity-50"
                />
             </div>
          </div>

          {/* Image Upload */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Visual Asset</label>
            {!isReadOnly && (
              <div className="mb-3 space-y-2">
                <AIGenerate
                  kind="image"
                  platform={formData.platform}
                  clientName={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  showToast={showToast}
                  onResult={(url) => setFormData(prev => ({ ...prev, imageUrl: url }))}
                />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline"
                >
                  <ImageIcon size={12} /> Choose from library
                </button>
              </div>
            )}
            {!formData.imageUrl ? (
              <label 
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-500 hover:bg-indigo-50/50'}`}
              >
                <div className="flex flex-col items-center pt-5 pb-6">
                  <UploadCloud className={`w-8 h-8 mb-2 transition-colors ${isDragging ? 'text-indigo-500' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                  <p className={`text-xs font-medium ${isDragging ? 'text-indigo-600' : 'text-slate-500'}`}>{isDragging ? 'Drop image here' : 'Click or drop to upload image'}</p>
                </div>
                <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
              </label>
            ) : (
              <div className="relative rounded-xl overflow-hidden border border-slate-200 group">
                <img src={formData.imageUrl} className="w-full h-48 object-cover" alt={formData.altText || 'Preview'} />
                <button onClick={() => setFormData({ ...formData, imageUrl: '' })} title="Remove Image" aria-label="Remove Image" className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full hover:bg-rose-600 transition-colors backdrop-blur-sm"><Trash2 size={16}/></button>
              </div>
            )}
            {formData.imageUrl && !isReadOnly && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Alt text</label>
                  <button type="button" onClick={handleAltText} disabled={altLoading} className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline disabled:opacity-50">
                    {altLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate
                  </button>
                </div>
                <input
                  type="text"
                  maxLength={300}
                  placeholder="Describe the image for accessibility / SEO…"
                  value={formData.altText || ''}
                  onChange={(e) => setFormData({ ...formData, altText: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:border-indigo-500 focus:ring-0 transition-all"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drag handle to resize the preview (desktop only) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onHandleKey}
        title="Drag to resize preview"
        className="hidden md:flex w-1.5 shrink-0 cursor-col-resize bg-slate-200 hover:bg-indigo-400 focus:bg-indigo-500 focus:outline-none transition-colors items-center justify-center group"
      >
        <div className="w-0.5 h-8 bg-slate-400 group-hover:bg-white rounded-full transition-colors" />
      </div>

      {/* Right Panel: Preview */}
      {(() => {
        // The Email tab exists only for pushable drafts (blog / reusable
        // template) and only for operators; hide it and fall back to the
        // channel view the moment either stops being true.
        const showEmailTab = canPreviewEmail && !isReadOnly && (formData.platform === 'blog' || formData.isTemplate);
        const activeTab = showEmailTab ? previewTab : 'channel';
        return (
      <div
        style={!previewMode ? { width: `${previewWidth}px` } : undefined}
        className={`bg-slate-100 border-l border-slate-200 flex-col ${previewMode ? 'flex fixed inset-0 z-20 w-full' : 'hidden md:flex shrink-0'}`}
      >
         <div className="p-4 border-b border-slate-200 bg-slate-100 flex justify-between items-center gap-3">
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider shrink-0">Live Preview</h3>
            {showEmailTab && (
              <div role="tablist" aria-label="Preview mode" className="flex items-center gap-1 bg-slate-200/70 rounded-full p-0.5">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'channel'}
                  onClick={() => setPreviewTab('channel')}
                  className={`px-3 py-1 text-xs font-bold rounded-full transition-colors ${activeTab === 'channel' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {isLongForm ? 'Blog' : 'Post'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'email'}
                  onClick={() => setPreviewTab('email')}
                  title="How this draft looks as a Sender email"
                  className={`px-3 py-1 text-xs font-bold rounded-full transition-colors ${activeTab === 'email' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Email
                </button>
              </div>
            )}
            <button onClick={() => setPreviewMode(!previewMode)} title="Close Preview" aria-label="Close Preview" className="md:hidden p-2 text-slate-500 hover:bg-slate-200 rounded-lg"><X size={20}/></button>
         </div>
         {/* No backdrop-blur here: the pane sits on a flat surface, so a 64px Gaussian
             blur produced no visible difference while forcing a full-pane GPU repaint on
             every keystroke. The translucent tint alone renders identically. */}
         <div className="flex-1 flex items-center justify-center p-6 bg-slate-100/50 overflow-hidden">
            {activeTab === 'email' ? (
              <SenderEmailPreview
                // Keyed by client: switching the client dropdown must re-render
                // with THAT client's tenant branding, not a stale snapshot.
                key={genClientId(formData.client) || formData.client}
                draft={{
                  content: formData.content,
                  title: formData.title,
                  imageUrl: formData.imageUrl,
                  altText: formData.altText,
                  metaDescription: formData.metaDescription,
                  client: formData.client,
                  clientId: genClientId(formData.client),
                }}
              />
            ) : isLongForm ? (
              <div className="w-full h-full overflow-y-auto bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
                <MarkdownPreview content={deferredContent} title={formData.title} imageUrl={formData.imageUrl} />
              </div>
            ) : (
              <MobilePreview
                post={previewPost}
                clientSettings={clientMap[formData.client] || DEFAULT_CLIENT_SETTINGS}
              />
            )}
         </div>
      </div>
        );
      })()}
      
      {/* Mobile preview FAB — hidden while the preview overlay is open (it has its own close). */}
      {!previewMode && (
        <button onClick={() => setPreviewMode(true)} title="Open Preview" aria-label="Open Preview" className="md:hidden fixed bottom-6 right-6 z-50 bg-slate-900 text-white p-4 rounded-full shadow-xl">
          {isLongForm ? <Eye size={24} /> : <Smartphone size={24} />}
        </button>
      )}

      {/* Spark Deck lives here (not in App) so picking a prompt only updates
          `content` and never resets unsaved client/platform/tags/image state. */}
      {isSparkOpen && (
        <SparkDeck
          onClose={() => setIsSparkOpen(false)}
          onSelect={(txt) => {
            replaceContent(txt);
            setIsSparkOpen(false);
          }}
        />
      )}

      {pickerOpen && (
        <MediaPicker
          onClose={() => { setPickerOpen(false); setPickerMode('cover'); }}
          onSelect={(url) => {
            if (pickerMode === 'inline') {
              // Insert a markdown image at the cursor position captured when the
              // picker opened; caret lands in the alt-text brackets. Deferred a
              // frame so the closing modal can't steal focus back.
              const ta = textareaRef.current;
              const r = inlineRangeRef.current;
              if (ta && r) {
                requestAnimationFrame(() => replaceRange(ta, r.start, r.end, `![](${url})`, r.start + 2, r.start + 2));
              } else {
                setFormData(prev => ({ ...prev, content: `${prev.content.replace(/\n+$/, '')}\n\n![](${url})` }));
              }
            } else {
              setFormData(prev => ({ ...prev, imageUrl: url }));
            }
          }}
          showToast={showToast}
          /* The post's client resolved to the canonical SLUG (same genClientId chain the AI calls
             use: stamped id → clientIdByName → branding doc → slugify fallback) so the picker can
             also offer the client's curated library — the slug-keyed folder POM's Assets card shares. */
          clientKey={genClientId(formData.client)}
          clientName={formData.client}
          clientImages={postImagesByClient[formData.client] || []}
        />
      )}

      {showDiscardUnsent && <ConfirmModal type="danger" title="Discard unsent recovery?" message="This draft has never been submitted to Spool. Discard its recovery copy and close this editor? Previously submitted or uncertain saves cannot be discarded this way." confirmLabel="Discard unsent copy" onCancel={() => setShowDiscardUnsent(false)} onConfirm={async () => {
        const before = workSignature(formDataRef.current);
        try {
          await createRecovery.discard();
          if (!editorAliveRef.current) return;
          setShowDiscardUnsent(false);
          if (workSignature(formDataRef.current) !== before) {
            await createRecovery.persist(formDataRef.current);
            showToast?.('The old unsent copy was discarded. Your newer edits are still here.', 'success');
          } else { editorAliveRef.current = false; onCancel(); }
        } catch (error) { if (editorAliveRef.current) showToast?.(error.message, 'error'); }
      }} />}

      {/* Discard confirm — the only way an in-app close loses dirty edits is
          through this explicit choice (the autosave still keeps a local copy). */}
      {showDiscardConfirm && (
        <ConfirmModal
          type="danger"
          title="Discard unsaved changes?"
          message={discardRecovery
            ? discardRecovery.imageOmitted
              ? "Your text and settings have a recovery copy on this device, but the new image is not included. Cancel and save the thread to keep every change."
              : "These changes are not saved to Spool. A recovery copy was stored on this device and can be restored when you reopen the editor."
            : "This device could not store your latest edits for recovery. Cancel and save the thread to keep your changes."}
          confirmLabel="Discard"
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={() => {
            // Flush again before unmounting in case an image upload finished
            // while the confirmation was open.
            const latestRecovery = writeAutosaveNow();
            if (Boolean(latestRecovery) !== Boolean(discardRecovery)
              || latestRecovery?.imageOmitted !== discardRecovery?.imageOmitted) {
              // Storage availability can change while the dialog is open.
              // Let the user read the updated recovery outcome before leaving.
              setDiscardRecovery(latestRecovery);
              return;
            }
            setShowDiscardConfirm(false);
            editorAliveRef.current = false;
            onCancel();
          }}
        />
      )}
    </div>
  );
};

export default Editor;
