// Ordinary Game Jam #1 — Portal Protocol helper
// Full spec: https://github.com/CallumHYoung/gamejam/blob/main/SPEC.md
//
// This tiny library is the only hard dependency for the jam.
// Drop it in any browser game and you get:
//   - Portal.readPortalParams()          — read incoming state from URL
//   - Portal.sendPlayerThroughPortal()   — redirect out to another game
//   - Portal.pickPortalTarget()          — async, fetches the registry
//   - Portal.fetchJamRegistry()          — raw registry access
//
// Everything is vanilla — no build step, no bundler, no framework.

const REGISTRY_URL = 'https://callumhyoung.github.io/gamejam/jam1.json';

// Hardcoded fallback used if the registry fetch fails (offline, CORS, rate-limited).
// Add a couple of known jam games here so your portals still work.
const FALLBACK_GAMES = [
  { title: 'Jam hub', url: 'https://callumhyoung.github.io/gamejam/' },
];

function randomHex() {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function readPortalParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    fromPortal: p.get('portal') === 'true',
    username:   p.get('username') || `guest-${Math.floor(Math.random() * 9999)}`,
    color:      (p.get('color') || randomHex()).replace('#', ''),
    speed:      parseFloat(p.get('speed') || '5'),
    ref:        p.get('ref') || null,
  };
}

function sendPlayerThroughPortal(targetUrl, state = {}) {
  const params = new URLSearchParams({
    portal: 'true',
    username: state.username || 'guest',
    color:    String(state.color || '').replace('#', ''),
    speed:    String(state.speed ?? 5),
    ref:      window.location.href.split('?')[0],
  });
  window.location.href = `${targetUrl}?${params.toString()}`;
}

async function fetchJamRegistry() {
  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.games || []).filter(g => g && g.url && g.id !== 'example');
  } catch (err) {
    console.warn('[portal] registry fetch failed, using fallback:', err.message);
    return FALLBACK_GAMES;
  }
}

function sameOrigin(a, b) {
  const norm = s => s.split('?')[0].replace(/\/$/, '');
  return norm(a) === norm(b);
}

async function pickPortalTarget() {
  const games = await fetchJamRegistry();
  const here = window.location.href;
  const others = games.filter(g => !sameOrigin(g.url, here));
  if (others.length === 0) return null;
  return others[Math.floor(Math.random() * others.length)];
}

window.Portal = {
  readPortalParams,
  sendPlayerThroughPortal,
  fetchJamRegistry,
  pickPortalTarget,
  REGISTRY_URL,
};
