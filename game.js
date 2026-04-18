// Minimal top-down game demonstrating two things at once:
//   1. The Portal Protocol (mandatory for the jam)
//   2. Optional realtime multiplayer via Trystero (Nostr strategy).
//      No backend, no accounts, no API keys — just browser-to-browser
//      WebRTC using public Nostr relays as signaling.
//
// The game renders and plays solo *immediately*. Multiplayer connects
// in the background; if it fails (CDN blocked, every relay down,
// restrictive network) the HUD flips to "multiplayer offline" and the
// game keeps running. Rip everything out and replace with your own
// game — just keep the Portal.* calls.

// ------------------------------------------------------------------
// Portal protocol + core game setup
// ------------------------------------------------------------------

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const incoming = Portal.readPortalParams();
document.getElementById('username').textContent = incoming.username;

const nextTarget = await Portal.pickPortalTarget();

const player = {
  x: W / 2,
  y: H / 2,
  r: 16,
  speed: incoming.speed || 5,
  color: '#' + incoming.color,
};

const exitPortal = {
  x: W - 120,
  y: H / 2,
  r: 44,
  color: '#c64bff',
  label: nextTarget ? `→ ${nextTarget.title}` : 'no destinations yet',
  target: nextTarget?.url || null,
  pulse: 0,
};

const returnPortal = incoming.ref ? {
  x: 120,
  y: H / 2,
  r: 44,
  color: '#4ff0ff',
  label: '← back',
  target: incoming.ref,
  pulse: 0,
} : null;

if (incoming.fromPortal && returnPortal) {
  player.x = returnPortal.x + returnPortal.r + 30;
  player.y = returnPortal.y;
}

// ------------------------------------------------------------------
// Multiplayer via Trystero (optional, non-blocking)
// ------------------------------------------------------------------
// To delete multiplayer entirely: remove everything between the dashed
// lines above and below this block, plus the <div id="peers"> in
// index.html. The game loop below doesn't depend on any of it.

const peers = new Map();
const peerCountEl = document.getElementById('peers');
let sendState = null;
let room = null;

function setPeerStatus(text, isError = false) {
  if (!peerCountEl) return;
  peerCountEl.textContent = text;
  peerCountEl.style.color = isError ? '#ff6b6b' : '';
}

function refreshPeerCount() {
  setPeerStatus(`${peers.size + 1} online`);
}

function broadcastSelf() {
  if (!sendState) return;
  sendState({
    x: player.x,
    y: player.y,
    color: player.color,
    username: incoming.username,
  });
}

async function loadTrystero() {
  // Try multiple CDN paths in order so a single CDN hiccup doesn't
  // kill multiplayer. trystero >= 0.23 defaults to the Nostr strategy
  // which has hundreds of public relays and is the most reliable
  // option for zero-config P2P.
  const urls = [
    'https://esm.run/trystero@0.23',
    'https://cdn.jsdelivr.net/npm/trystero@0.23/+esm',
    'https://esm.sh/trystero@0.23',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const mod = await import(url);
      if (mod && typeof mod.joinRoom === 'function') {
        console.log('[jam] loaded trystero from', url);
        return mod;
      }
      lastErr = new Error(`module from ${url} has no joinRoom export`);
    } catch (err) {
      console.warn('[jam] cdn failed:', url, err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not load trystero');
}

async function setupMultiplayer() {
  try {
    setPeerStatus('connecting…');
    const { joinRoom } = await loadTrystero();

    room = joinRoom(
      { appId: 'ordinary-game-jam-starter' },
      'demo-room'
    );
    const [send, getState] = room.makeAction('state');
    sendState = send;

    room.onPeerJoin(id => {
      console.log('[jam] peer joined:', id);
      peers.set(id, null);
      broadcastSelf();
      refreshPeerCount();
    });

    room.onPeerLeave(id => {
      console.log('[jam] peer left:', id);
      peers.delete(id);
      refreshPeerCount();
    });

    getState((data, peerId) => {
      const existing = peers.get(peerId);
      peers.set(peerId, {
        ...data,
        renderX: existing?.renderX ?? data.x,
        renderY: existing?.renderY ?? data.y,
      });
    });

    refreshPeerCount();
    broadcastSelf();
    console.log('[jam] multiplayer ready (nostr)');
  } catch (err) {
    console.error('[jam] multiplayer setup failed:', err);
    setPeerStatus('multiplayer offline', true);
  }
}

setPeerStatus('connecting…');
setupMultiplayer();

addEventListener('beforeunload', () => {
  if (room) {
    try { room.leave(); } catch {}
  }
});

// ------------------------------------------------------------------
// Game loop (runs regardless of multiplayer state)
// ------------------------------------------------------------------

const stars = Array.from({ length: 80 }, () => ({
  x: Math.random() * W,
  y: Math.random() * H,
  s: Math.random() * 1.5 + 0.3,
  t: Math.random() * Math.PI * 2,
}));

const keys = {};
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup',   e => { keys[e.key.toLowerCase()] = false; });

let redirecting = false;

function attemptPortal(portal) {
  if (redirecting || !portal || !portal.target) return;
  const dx = player.x - portal.x;
  const dy = player.y - portal.y;
  if (Math.hypot(dx, dy) < portal.r + player.r - 4) {
    redirecting = true;
    Portal.sendPlayerThroughPortal(portal.target, {
      username: incoming.username,
      color: incoming.color,
      speed: player.speed,
    });
  }
}

let lastBroadcast = 0;

function update(dt) {
  const v = player.speed;
  if (keys['w'] || keys['arrowup'])    player.y -= v;
  if (keys['s'] || keys['arrowdown'])  player.y += v;
  if (keys['a'] || keys['arrowleft'])  player.x -= v;
  if (keys['d'] || keys['arrowright']) player.x += v;
  player.x = Math.max(player.r, Math.min(W - player.r, player.x));
  player.y = Math.max(player.r, Math.min(H - player.r, player.y));

  exitPortal.pulse += dt * 3;
  if (returnPortal) returnPortal.pulse += dt * 3;

  attemptPortal(exitPortal);
  if (returnPortal) attemptPortal(returnPortal);

  const now = performance.now();
  if (now - lastBroadcast > 66) {
    lastBroadcast = now;
    broadcastSelf();
  }

  for (const peer of peers.values()) {
    if (!peer) continue;
    const k = Math.min(1, dt * 12);
    peer.renderX += (peer.x - peer.renderX) * k;
    peer.renderY += (peer.y - peer.renderY) * k;
  }
}

function drawStars(t) {
  for (const s of stars) {
    const a = 0.5 + 0.5 * Math.sin(t * 2 + s.t);
    ctx.fillStyle = `rgba(255,255,255,${a * 0.8})`;
    ctx.fillRect(s.x, s.y, s.s, s.s);
  }
}

function drawPortal(p) {
  const glow = 18 + Math.sin(p.pulse) * 6;
  ctx.save();
  ctx.shadowColor = p.color;
  ctx.shadowBlur = glow;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r - 10 + Math.sin(p.pulse) * 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#fff';
  ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.label, p.x, p.y - p.r - 12);
}

function drawAvatar(x, y, color, username, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, player.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (username) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(username, x, y - player.r - 8);
  }
}

function drawPeers() {
  for (const peer of peers.values()) {
    if (!peer) continue;
    drawAvatar(peer.renderX, peer.renderY, peer.color || '#888', peer.username || '?', 0.85);
  }
}

function render(t) {
  ctx.fillStyle = '#120826';
  ctx.fillRect(0, 0, W, H);
  drawStars(t);
  drawPortal(exitPortal);
  if (returnPortal) drawPortal(returnPortal);
  drawPeers();
  drawAvatar(player.x, player.y, player.color, '', 1);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render(now / 1000);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
