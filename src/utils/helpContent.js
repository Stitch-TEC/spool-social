// Bundled instructions only: no account, client, draft, URL or provider data.
export const HELP_SEARCH_LIMIT = 120;
const WRITERS = ['operator', 'member'];
const EVERYONE = ['operator', 'member', 'guest'];

export const HELP_GUIDES = [
  {
    id: 'find-threads', title: 'Find a thread', category: 'Getting around', audiences: EVERYONE,
    summary: 'Search and narrow the threads already available to you.',
    keywords: 'navigation search filters missing threads review approval',
    steps: [
      'Use Search threads to find words in the content or client name.',
      'Choose a review filter, such as Awaiting client, Changes or Approved.',
      'Clear the search and any active filters if a thread seems missing.',
    ],
    note: 'Filters do not grant access or bring private drafts into a client view.',
  },
  {
    id: 'create-operator', title: 'Create and save a draft', category: 'Drafting', audiences: ['operator'],
    summary: 'Start a private draft, then decide when to share it.',
    keywords: 'new thread save editor content client AI recovery platform usual',
    steps: [
      'Choose a client, then select New. Confirm Client Name in the editor.',
      'Choose Platform and write the content. Schedule starts empty; tags allow 10 entries of 20 characters. AI draft is optional; review it before use.',
      'Add an image when needed. On a phone, use Preview to check the draft and Edit to return.',
      'Select Save and wait for confirmation. Close Editor returns to the threads.',
      'When ready, use Send for review on the saved thread.',
    ],
    warning: 'Saving your new draft does not share it with the client or publish it.',
    note: 'Usual marks the most-used platform in this client’s loaded threads; choose any platform you need.',
  },
  {
    id: 'create-member', title: 'Work on your client’s drafts', category: 'Drafting', audiences: ['member'],
    summary: 'Create or edit a thread within your own client workspace.',
    keywords: 'new thread save editor content approval review client AI recovery platform usual',
    steps: [
      'Select New or open an existing thread. Client Name stays with your workspace.',
      'Choose Platform and write or adjust the content. AI draft is optional.',
      'Schedule is optional. Published, archived or incompatible older threads open read-only; ask Stitch TEC for changes.',
      'Check the preview, then select Save and wait for confirmation.',
      'For approval or feedback, open the review link supplied by your team; the signed-in editor is a different view.',
    ],
    warning: 'Your saved new threads are available for client review. Saving an edit is not an approval; changes to approved content need another review.',
    note: 'Usual marks the most-used platform in this client’s loaded threads; choose any platform you need.',
  },
  {
    id: 'send-review', title: 'Share a draft for review', category: 'Review', audiences: ['operator'],
    summary: 'Move a private draft into review and share the client’s link.',
    keywords: 'approval share staging private not sent awaiting client review link email',
    steps: [
      'Open Not sent and read the saved draft. Resolve any readiness blockers.',
      'Select Send for review. The thread becomes available on the client’s review link.',
      'Open Share, confirm the client, then create or copy a review link and send it yourself.',
      'If changes are requested, edit and save the thread, then select Back for review.',
      'Use Move to staging to hide a thread from the client again without erasing its review history.',
    ],
    warning: 'Anyone with a review link can review that client’s shared content. Send for review does not send an email.',
  },
  {
    id: 'guest-review', title: 'Approve or request changes', category: 'Review', audiences: ['guest'],
    summary: 'Review the whole thread before recording your decision.',
    keywords: 'approval review approve feedback request changes video',
    steps: [
      'Open a thread and read its content, image and any other preview fields.',
      'Open video links separately when present. Ask your team for access if the file will not open.',
      'Select Approve Thread when it is ready, or Request Changes to leave feedback.',
      'For changes, enter a note or select a reason, then choose Submit Feedback.',
      'If Spool says the thread changed, reopen it and review the current version before deciding again.',
    ],
    warning: 'Approval is not publication. A linked file can change outside Spool; approval does not preserve a copy of that video.',
  },
  {
    id: 'video-links', title: 'Add a video link', category: 'Drafting', audiences: WRITERS,
    summary: 'Include a sharing link alongside the draft for review.',
    keywords: 'video drive onedrive sharepoint dropbox youtube vimeo storage file screenshot media library title label search filter images videos find',
    steps: [
      'Keep the video in its source service and give your reviewers permission to open it.',
      'In Media Library, add a YouTube, Vimeo or direct HTTPS video-file link. When adding a new link, Video title is optional, up to 120 characters. Search labels, video IDs or filenames and use All, Images or Videos to narrow the list.',
      'In the editor, open Add video link to draft text. Paste a supported HTTPS sharing link and choose Insert link into draft text.',
      'Choose from library also lists video links. Selecting a video fills the link tool; confirm Insert to put that URL in the caption.',
      'Review the text and select Save. Use the displayed video link to check the destination yourself.',
    ],
    warning: 'The URL is part of the draft text, not a private attachment. It travels with copied or published text and draft AI requests. Spool does not upload, store or check the video.',
    note: 'Video title changes only the library label; it does not rename the source video or change the post title. Existing library links cannot be renamed here. The draft-text link tool accepts Google Drive, OneDrive, SharePoint, Dropbox, YouTube, Vimeo and supported direct video-file links. A local file path is not a sharing link. Separate review-only link fields are not available.',
  },
  {
    id: 'workflow', title: 'Understand review and scheduling', category: 'Review', audiences: EVERYONE,
    summary: 'Review decisions and publishing progress are separate.',
    keywords: 'review approval status scheduled calendar draft posted not sent changes staging',
    steps: [
      'Use Not sent, Awaiting client, Changes and Approved to understand the review stage or decision.',
      'Read Draft, Scheduled and Posted as workflow labels, not proof of client approval.',
      'Treat a schedule date as a plan. Confirm publication in the destination before treating content as live.',
      'An empty Schedule means Not scheduled. Opening or saving an undated thread does not add a date.',
    ],
    note: 'Moving a thread back to staging does not erase a previous review decision. Only the operator can see private staged drafts.',
  },
  {
    id: 'handoff', title: 'Reuse content in other apps', category: 'Publishing', audiences: ['operator'],
    summary: 'Reuse a template or hand approved content to Sender or POM.',
    keywords: 'template use as draft publish website site POM Sender email copy',
    steps: [
      'In Templates, choose Use as draft to create a separate draft to edit and save.',
      'On an eligible template or approved blog thread, Push to Sender creates or updates the email template there.',
      'Open Sender to review that copy. A push does not send an email campaign.',
      'For an approved blog thread, Publish to site stages a POM ticket. Continue in POM to dispatch and review the proposed website change.',
    ],
    warning: 'Publishing to the site is not immediate. Replacing a changed Sender copy requires your confirmation; check its existing edits first.',
  },
  {
    id: 'save-recovery', title: 'Check an uncertain save', category: 'Troubleshooting', audiences: WRITERS,
    summary: 'Keep your work while checking what actually saved.',
    keywords: 'save recovery unsaved restore copy offline interrupted error missing duplicate',
    steps: [
      'Keep the editor open and use Copy text when available to preserve your current wording.',
      'If offered, choose Restore previous work before continuing the original new draft.',
      'An empty, never-prepared recovery copy continues under the same save reference without blocking new text. Authored or uncertain copies still need deliberate review.',
      'For an unconfirmed new-draft save, use Check previous save when the connection returns.',
      'If it remains unconfirmed, open Help with this save and share the save reference privately with Stitch TEC.',
    ],
    warning: 'Do not create another copy or clear browser storage to fix an uncertain save. Copy text does not include images or settings, and a device recovery copy is not proof of a server save.',
  },
  {
    id: 'existing-recovery', title: 'Recover existing thread work', category: 'Troubleshooting', audiences: WRITERS,
    summary: 'Inspect device copies without losing older work.',
    keywords: 'existing thread recovery older device copy restore dismiss autosave',
    steps: [
      'Restore brings back the current account-scoped device copy for this thread. Dismiss deletes that exact copy; typing or saving does not discard an unresolved copy.',
      'If Older device copy kept appears, Inspect older copy shows a manual reference. Select and copy the text you need; it has not been restored, uploaded or deleted.',
      'Copies containing newer review details are inspection-only until editing those details is enabled.',
      'If device recovery needs checking, keep the editor open or copy your current text before closing. You can still save the existing thread to Spool.',
    ],
    warning: 'Unscoped older copies cannot be safely attributed to an account and are not displayed. Device storage is not a backup; do not clear it to fix recovery.',
  },
  {
    id: 'import-operator', title: 'Import draft content', category: 'Drafting', audiences: ['operator'],
    summary: 'Preview a spreadsheet or JSON file before creating private drafts.',
    keywords: 'import CSV JSON spreadsheet template batch duplicate archive restore',
    steps: [
      'Open Import / Export, choose Import, then download a CSV or JSON template.',
      'Replace the example with your content. Use an existing client name and a supported platform key; leave Schedule blank when not planned.',
      'Choose the file and fix every listed error. Review warnings, the client/platform counts and duplicate choices before importing.',
      'Import creates new private drafts with new IDs and timestamps, pending review. It does not restore old approvals or history.',
      'Wait for confirmation. If Import needs checking appears, inspect the saved threads before trying again; keep the reference list available.',
    ],
    warning: 'A submitted batch may save even if its response is lost. Do not re-import an uncertain file or clear storage as a repair. Duplicate skipping only compares with the currently loaded threads.',
  },
  {
    id: 'import-member', title: 'Import workspace drafts', category: 'Drafting', audiences: ['member'],
    summary: 'Preview a spreadsheet or JSON file for your client workspace.',
    keywords: 'import CSV JSON spreadsheet template batch duplicate archive restore',
    steps: [
      'Open Import / Export, choose Import, then download a CSV or JSON template.',
      'Replace the example with your content and supported platform keys. Leave Schedule blank when not planned.',
      'Choose the file and fix every listed error. Review the preview; imported rows belong to your current workspace, not another client in the file.',
      'Import creates new drafts pending review, with new IDs and timestamps. It does not restore approvals, feedback history or reusable templates.',
      'Wait for confirmation. If Import needs checking appears, inspect the saved threads before trying again; keep the reference list available.',
    ],
    warning: 'Imported drafts are available for client review immediately. A submitted batch may save even if its response is lost; do not re-import an uncertain file. Duplicate skipping only compares with the currently loaded threads.',
  },
  {
    id: 'import-fields', title: 'Draft import field reference', category: 'Drafting', audiences: WRITERS,
    summary: 'Use the template fields without losing content or inventing review history.',
    keywords: 'import CSV JSON columns fields platform keys date format tags title caption limits template',
    steps: [
      'Required: client (up to 50 characters), content and platform. Keys: gmb, facebook, linkedin, twitter, instagram, blog, job. Content must fit the selected platform; it is never shortened to fit.',
      'Optional text: title (200), altText (300), metaDescription (200), slug (80, lowercase letters/numbers/single hyphens), imageUrl (500,000). A media URL is not uploaded or access-checked by import.',
      'tags: up to 10 distinct tags of 20 characters each. Use a JSON array or separate CSV tags with |. Outer tag spaces are trimmed with a warning.',
      'scheduledDate: blank/null means Not scheduled. Otherwise use an ISO timestamp with a timezone, such as 2026-10-15T09:00:00-07:00. Equivalent UTC formatting is shown as a warning.',
      'Keep status=draft, approvalStatus=pending and feedback empty. isTemplate accepts true/false; only operators can import reusable templates. Old IDs/timestamps are ignored with a warning; unknown fields, review details and history are refused.',
    ],
    note: 'Use at most 2,000 rows. JSON exports remain reference archives, not a backup-restore path; remove unsupported historical fields only when you deliberately want new draft content.',
  },
  {
    id: 'access', title: 'Check missing access or content', category: 'Troubleshooting', audiences: [...EVERYONE, 'unknown'],
    summary: 'Check the account, link and connection without changing access.',
    keywords: 'access sign in login account client missing navigation connection permission review link',
    steps: [
      'For a signed-in workspace, check that you used the intended Google account. For a review link, use the latest link from your team.',
      'Clear search and filters before deciding a thread is missing. A private draft will not appear in a client view.',
      'If live updates have stopped, preserve any unsaved text before reloading.',
      'If access is still unavailable, ask Stitch TEC to check your account or review link. Share the error message, not passwords or sign-in codes.',
    ],
    note: 'POM, Spool and Sender check access separately. A link from another app does not grant access.',
  },
];

export function guidesForAudience(audience) {
  const role = ['operator', 'member', 'guest'].includes(audience) ? audience : 'unknown';
  return HELP_GUIDES.filter(guide => guide.audiences.includes(role));
}

export function findHelpGuide(id, audience) {
  return guidesForAudience(audience).find(guide => guide.id === id) || null;
}

export function searchHelpGuides(query, audience) {
  const terms = (typeof query === 'string' ? query : '').slice(0, HELP_SEARCH_LIMIT).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return guidesForAudience(audience).filter(guide => {
    const text = [guide.title, guide.category, guide.summary, guide.keywords, ...guide.steps, guide.warning || '', guide.note || ''].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}
