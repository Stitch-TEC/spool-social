// stitch-apps — the canonical Stitch Suite registry.
// Kept BYTE-IDENTICAL across every repo's copy except CURRENT_APP_ID. (SUITE-ARCHITECTURE.md §2)
export const STITCH_APPS = [
  { id: 'site',   name: 'Stitch TEC', tagline: 'Main site',                  url: 'https://stitchtec.dev',          status: 'live' },
  { id: 'pom',    name: 'POM',        tagline: 'Monitoring, tickets & time', url: 'https://pom.stitchtec.dev', status: 'live' },
  { id: 'spool',  name: 'Spool',      tagline: 'Content drafting & review',  url: 'https://spool.stitchtec.dev',    status: 'live' },
  { id: 'sender', name: 'Sender',     tagline: 'Email & newsletters',        url: 'https://send.stitchtec.dev',     status: 'live' },
];
export const CURRENT_APP_ID = 'spool';
