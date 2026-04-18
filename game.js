// ===================================================================
// TRAPPED — Labyrinth of Horrors
// First-person, roguelike, horror, multiplayer.
// ===================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'https://unpkg.com/three@0.160.0/examples/jsm/utils/SkeletonUtils.js';

// ------------------------------------------------------------------
// PORTAL PROTOCOL (kept compatible)
// ------------------------------------------------------------------
const incomingParams = Portal.readPortalParams();
const portalTarget = await Portal.pickPortalTarget().catch(() => null);

// ------------------------------------------------------------------
// SEEDED RNG (mulberry32)
// ------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261 >>> 0; for (let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; }

// ------------------------------------------------------------------
// GLOBAL STATE
// ------------------------------------------------------------------
const TILE = 4;              // world units per maze cell
const WALL_H = 4.2;

const STATE = {
  phase: 'menu',              // menu | lobby | playing | dead | end
  level: 1,
  seed: 0,
  isHost: false,
  hostId: null,
  myId: Math.random().toString(36).slice(2, 10),
  username: incomingParams.username || (localStorage.getItem('trapped.name') || ('guest-' + Math.floor(Math.random()*9999))),
  players: new Map(),   // id -> { name, pos, yaw, color, hp, stamina, flashOn, crouching, alive, selectedSlot, items:[], buffs:[], debuffs:[], finishedLevel, level }
  monsters: [],
  traps: [],
  pickups: [],          // key, batteries, medpacks, droppedItems
  levelMeta: null,      // { theme, size, keyPos, exitPos, safeRoomPos, cells }
  exitOpen: false,
  keyHolderId: null,
  deadPlayerIds: new Set(),
  chosenThisLevel: new Set(), // ids who've picked reward
  safeRoomOpen: false,
  tickCount: 0,
  corpses: [],
};

// ------------------------------------------------------------------
// DOM REFS
// ------------------------------------------------------------------
const $ = id => document.getElementById(id);
const menuEl = $('menu'), howtoEl = $('howto'), lbEl = $('leaderboard'),
      lobbyEl = $('lobby'), choiceEl = $('choice'), deathEl = $('death'),
      endEl = $('endscreen'), hudEl = $('hud'), settingsEl = $('settings'),
      pauseEl = $('pause');
const canvas = $('game');

// Menu wiring
$('nameInput').value = STATE.username;
$('nameInput').addEventListener('input', e => {
  STATE.username = e.target.value.trim() || ('guest-' + Math.floor(Math.random()*9999));
  localStorage.setItem('trapped.name', STATE.username);
});

// Track where Settings/Howto were opened from so Back returns there
let settingsReturnTo = 'menu';
let howtoReturnTo = 'menu';

function showScreen(name) {
  [menuEl, howtoEl, lbEl, lobbyEl, choiceEl, deathEl, endEl, settingsEl, pauseEl].forEach(e => e.classList.add('hidden'));
  hudEl.classList.add('hidden');
  if (name === 'menu') menuEl.classList.remove('hidden');
  else if (name === 'howto') howtoEl.classList.remove('hidden');
  else if (name === 'lb') { renderLeaderboard(); lbEl.classList.remove('hidden'); }
  else if (name === 'lobby') lobbyEl.classList.remove('hidden');
  else if (name === 'choice') choiceEl.classList.remove('hidden');
  else if (name === 'death') deathEl.classList.remove('hidden');
  else if (name === 'end') endEl.classList.remove('hidden');
  else if (name === 'settings') { renderSettings(); settingsEl.classList.remove('hidden'); }
  else if (name === 'pause') pauseEl.classList.remove('hidden');
  else if (name === 'hud') hudEl.classList.remove('hidden');
}

function renderSettings() {
  for (const g of ['master','ambient','sfx','footsteps','monsters']) {
    const el = $('vol-' + g);
    const val = $('val-' + g);
    el.value = audioVolumes[g];
    val.textContent = Math.round(audioVolumes[g] * 100) + '%';
  }
}
for (const g of ['master','ambient','sfx','footsteps','monsters']) {
  // Wire up once; guard in case element not yet present
  const el = document.getElementById('vol-' + g);
  if (el) {
    el.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      audio.setVolume(g, v);
      document.getElementById('val-' + g).textContent = Math.round(v * 100) + '%';
    });
  }
}

$('btn-howto').onclick = () => { howtoReturnTo = 'menu'; showScreen('howto'); };
$('btn-leaderboard').onclick = () => showScreen('lb');
$('btn-settings').onclick = () => { settingsReturnTo = 'menu'; showScreen('settings'); };
$('btn-settings-back').onclick = () => {
  if (settingsReturnTo === 'pause') showScreen('pause');
  else showScreen('menu');
};
$('btn-settings-reset').onclick = () => {
  audio.setVolume('master', 0.7);
  audio.setVolume('ambient', 0.6);
  audio.setVolume('sfx', 0.8);
  audio.setVolume('footsteps', 0.7);
  audio.setVolume('monsters', 0.9);
  renderSettings();
};
$('btn-back1').onclick = () => {
  if (howtoReturnTo === 'pause') showScreen('pause');
  else showScreen('menu');
};
$('btn-back2').onclick = () => showScreen('menu');

// Pause menu buttons
$('btn-resume').onclick = () => resumeGame();
$('btn-pause-settings').onclick = () => { settingsReturnTo = 'pause'; showScreen('settings'); };
$('btn-pause-howto').onclick = () => { howtoReturnTo = 'pause'; showScreen('howto'); };
$('btn-pause-leave').onclick = () => {
  STATE.phase = 'menu';
  audio.stopAmbient();
  showScreen('menu');
};

function openPause() {
  if (STATE.phase !== 'playing') return;
  document.exitPointerLock?.();
  // Clear movement keys so no momentum carries over
  for (const k of ['w','a','s','d','shift','c',' ','arrowup','arrowdown','arrowleft','arrowright']) keys[k] = false;
  showScreen('pause');
}

function resumeGame() {
  if (STATE.phase !== 'playing') return;
  showScreen('hud');
  canvas.requestPointerLock?.();
}
$('btn-queue').onclick = () => enterLobby();
$('btn-leave').onclick = () => leaveLobby();
$('btn-ready').onclick = () => toggleReady();
$('btn-endback').onclick = () => {
  endEl.classList.add('hidden');
  showScreen('menu');
};

function renderLeaderboard() {
  const raw = JSON.parse(localStorage.getItem('trapped.leaderboard') || '[]');
  raw.sort((a,b)=>b.level-a.level || a.time-b.time);
  const list = $('lbList');
  if (!raw.length) { list.innerHTML = '<li class="lb-empty">no runs yet</li>'; return; }
  list.innerHTML = raw.slice(0,20).map((r,i) =>
    `<li><span style="color:var(--mid)">#${i+1}</span> <b>${escapeHtml(r.name)}</b> — Level ${r.level} <span class="muted small">(${new Date(r.time).toLocaleDateString()})</span></li>`
  ).join('');
}
function recordLeaderboard(name, level) {
  const raw = JSON.parse(localStorage.getItem('trapped.leaderboard') || '[]');
  raw.push({ name, level, time: Date.now() });
  localStorage.setItem('trapped.leaderboard', JSON.stringify(raw));
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ------------------------------------------------------------------
// MULTIPLAYER (Trystero)
// ------------------------------------------------------------------
let room = null;
let sendLobby, getLobby;
let sendWorld, getWorld;    // host -> clients: monsters/traps/pickups state
let sendPlayer, getPlayer;  // each player -> others: their own pos/hp/etc
let sendEvent, getEvent;    // transient events (damage, pickups, choices)

const peers = new Map();    // peerId -> { lobbyReady, connected }
const lobbyPlayers = new Map(); // id -> { name, ready }

async function loadTrystero() {
  const urls = [
    'https://esm.run/trystero@0.23',
    'https://cdn.jsdelivr.net/npm/trystero@0.23/+esm',
    'https://esm.sh/trystero@0.23',
  ];
  for (const url of urls) {
    try {
      const mod = await import(url);
      if (mod?.joinRoom) return mod;
    } catch (e) { /* try next */ }
  }
  throw new Error('Trystero failed to load');
}

async function initRoom() {
  if (room) return;
  try {
    const { joinRoom } = await loadTrystero();
    room = joinRoom({ appId: 'trapped-labyrinth-v1' }, 'main-hall');

    [sendLobby, getLobby] = room.makeAction('lobby');
    [sendWorld, getWorld] = room.makeAction('world');
    [sendPlayer, getPlayer] = room.makeAction('player');
    [sendEvent, getEvent] = room.makeAction('event');

    room.onPeerJoin(id => {
      peers.set(id, { connected: true });
      // On join, send our lobby state so others know we exist
      broadcastLobbySelf();
      electHost();
      updatePeerStatus();
    });
    room.onPeerLeave(id => {
      peers.delete(id);
      lobbyPlayers.delete(id);
      STATE.players.delete(id);
      renderLobby();
      electHost();
      updatePeerStatus();
      if (STATE.phase === 'playing' && STATE.isHost) maybeAdvanceLevelCheck();
    });

    getLobby((data, peerId) => {
      lobbyPlayers.set(peerId, data);
      renderLobby();
      if (STATE.phase === 'lobby') checkAllReady();
    });

    getPlayer((data, peerId) => {
      let p = STATE.players.get(peerId);
      if (!p) p = STATE.players.set(peerId, newPlayerState(peerId, data.name)).get(peerId);
      Object.assign(p, data);
      // Render position interp
      if (!p.renderPos) p.renderPos = p.pos.slice();
    });

    getWorld((data, peerId) => {
      if (peerId !== STATE.hostId) return;
      applyWorldSnapshot(data);
    });

    getEvent((data, peerId) => {
      handleRemoteEvent(data, peerId);
    });

    updatePeerStatus();
    electHost();
    checkAllReady();
  } catch (err) {
    console.warn('[mp] offline:', err);
    $('peerStatus').textContent = 'multiplayer offline — solo';
    electHost();
    checkAllReady();
  }
}

function updatePeerStatus() {
  const n = peers.size + 1;
  const ps = $('peerStatus');
  ps.textContent = STATE.isHost
    ? `HOST · ${n} online`
    : `${n} online`;
}

function electHost() {
  // Host is lowest ID (lexicographic) among all connected peers + self
  const allIds = [STATE.myId, ...peers.keys()].sort();
  STATE.hostId = allIds[0];
  STATE.isHost = STATE.hostId === STATE.myId;
  updatePeerStatus();
}

function broadcastLobbySelf() {
  if (!sendLobby) return;
  const me = lobbyPlayers.get(STATE.myId) || { name: STATE.username, ready: false };
  me.name = STATE.username;
  lobbyPlayers.set(STATE.myId, me);
  sendLobby(me);
}

function renderLobby() {
  const list = $('lobbyList');
  const rows = [];
  const all = new Map(lobbyPlayers);
  if (!all.has(STATE.myId)) all.set(STATE.myId, { name: STATE.username, ready: false });
  for (const [id, pl] of all) {
    const you = id === STATE.myId ? ' (you)' : '';
    const readyTxt = pl.ready ? '<span class="ready">READY</span>' : '<span class="notready">waiting</span>';
    rows.push(`<li><span>${escapeHtml(pl.name)}${you}</span> ${readyTxt}</li>`);
  }
  list.innerHTML = rows.join('');
  $('lobbyStatus').textContent = all.size === 1
    ? 'you can start solo when ready'
    : `${all.size} players — game starts when all ready`;
}

function toggleReady() {
  const me = lobbyPlayers.get(STATE.myId) || { name: STATE.username, ready: false };
  me.name = STATE.username;
  me.ready = !me.ready;
  lobbyPlayers.set(STATE.myId, me);
  broadcastLobbySelf();
  renderLobby();
  $('btn-ready').textContent = me.ready ? 'Not Ready' : "I'm Ready";
  checkAllReady();
}

function checkAllReady() {
  const all = [...lobbyPlayers.values()];
  if (!all.length) return;
  if (!lobbyPlayers.has(STATE.myId)) return;
  const everyoneReady = all.every(p => p.ready) && lobbyPlayers.get(STATE.myId).ready;
  if (everyoneReady) {
    // only host decides the start (to avoid multi-starts)
    if (STATE.isHost) {
      const startSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
      sendEvent && sendEvent({ type: 'start', seed: startSeed });
      startGame(startSeed);
    }
  }
}

function enterLobby() {
  STATE.phase = 'lobby';
  lobbyPlayers.clear();
  lobbyPlayers.set(STATE.myId, { name: STATE.username, ready: false });
  electHost();
  initRoom();
  setTimeout(()=>{ broadcastLobbySelf(); renderLobby(); }, 500);
  showScreen('lobby');
  $('btn-ready').textContent = "I'm Ready";
}

function leaveLobby() {
  STATE.phase = 'menu';
  showScreen('menu');
  lobbyPlayers.delete(STATE.myId);
  broadcastLobbySelf();
}

// ------------------------------------------------------------------
// WEB AUDIO — procedurally synthesized horror SFX
// ------------------------------------------------------------------
const AUDIO_GROUPS = ['master', 'ambient', 'sfx', 'footsteps', 'monsters'];
const SAVED_VOL = (() => {
  try { return JSON.parse(localStorage.getItem('trapped.volumes') || '{}'); } catch { return {}; }
})();
const audioVolumes = {
  master:    SAVED_VOL.master    ?? 0.7,
  ambient:   SAVED_VOL.ambient   ?? 0.6,
  sfx:       SAVED_VOL.sfx       ?? 0.8,
  footsteps: SAVED_VOL.footsteps ?? 0.7,
  monsters:  SAVED_VOL.monsters  ?? 0.9,
};
function saveVolumes() {
  localStorage.setItem('trapped.volumes', JSON.stringify(audioVolumes));
}

const audio = (() => {
  let ctx = null;
  let gains = null;       // { master, ambient, sfx, footsteps, monsters }
  let ambientNode = null;
  let lastStepT = 0;

  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      gains = {};
      gains.master = ctx.createGain();
      gains.master.gain.value = audioVolumes.master;
      gains.master.connect(ctx.destination);
      for (const grp of ['ambient','sfx','footsteps','monsters']) {
        const g = ctx.createGain();
        g.gain.value = audioVolumes[grp];
        g.connect(gains.master);
        gains[grp] = g;
      }
    } catch (e) { console.warn('no audio', e); }
  }

  function setVolume(group, v) {
    audioVolumes[group] = v;
    saveVolumes();
    if (!gains) return;
    if (gains[group]) gains[group].gain.value = v;
  }

  function routeFor(group) {
    return (gains && gains[group]) || (gains && gains.sfx);
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  function envGain(startT, attack, hold, release, peak=1, base=0) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(base, startT);
    g.gain.linearRampToValueAtTime(peak, startT + attack);
    g.gain.setValueAtTime(peak, startT + attack + hold);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, base), startT + attack + hold + release);
    return g;
  }

  // Sound effects currently disabled — all audio.XX() calls resolve to no-ops.
  // To re-enable: remove the early `return` from each helper and audio will flow
  // through the volume groups again.
  function playTone(_opts) { return; }
  function playNoise(_opts) { return; }

  function startAmbient(themeId) {
    ensure(); if (!ctx) return;
    stopAmbient();
    // Low drone + occasional flutter — theme-tinted frequencies
    const baseFreq = ({
      hospital: 70, dungeon: 55, asylum: 60, mine: 50, meat: 45, library: 75,
      sewer: 40, factory: 48, cave: 42, cathedral: 65, prison: 52, crypt: 48,
      mansion: 62, lab: 110, subway: 55, attic: 68,
    })[themeId] || 55;
    const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = baseFreq;
    const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = baseFreq * 1.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.value = 0.15;
    osc1.connect(lp); osc2.connect(lp); lp.connect(g); g.connect(routeFor('ambient'));
    osc1.start(); osc2.start();
    ambientNode = { osc1, osc2, g };
  }
  function stopAmbient() {
    if (!ambientNode) return;
    try { ambientNode.osc1.stop(); ambientNode.osc2.stop(); } catch {}
    ambientNode = null;
  }

  return {
    ensure,
    // Combat
    hit:    () => playNoise({ duration: 0.18, volume: 0.2, filterFreq: 400, fType: 'lowpass' }),
    heal:   () => playTone({ freq: 420, freq2: 780, type: 'sine', duration: 0.35, volume: 0.15 }),
    flashlight: () => playTone({ freq: 900, type: 'square', duration: 0.05, volume: 0.07 }),
    pickup: () => playTone({ freq: 660, freq2: 1100, type: 'triangle', duration: 0.18, volume: 0.15 }),
    keyPickup: () => { playTone({ freq: 660, type: 'sine', duration: 0.15, volume: 0.18 }); setTimeout(() => playTone({ freq: 990, type: 'sine', duration: 0.2, volume: 0.18 }), 120); },
    doorOpen: () => { playNoise({ duration: 0.6, volume: 0.2, filterFreq: 400, fType: 'lowpass' }); playTone({ freq: 80, freq2: 120, type: 'sawtooth', duration: 0.6, volume: 0.12 }); },
    monsterRoar: () => { playTone({ freq: 180, freq2: 70, type: 'sawtooth', duration: 0.7, volume: 0.25, group: 'monsters' }); playNoise({ duration: 0.7, volume: 0.12, filterFreq: 500, fType: 'bandpass', group: 'monsters' }); },
    monsterScream: () => { playTone({ freq: 900, freq2: 300, type: 'sawtooth', duration: 0.8, volume: 0.2, group: 'monsters' }); playNoise({ duration: 0.8, volume: 0.15, filterFreq: 2000, fType: 'bandpass', group: 'monsters' }); },
    death: () => { playTone({ freq: 150, freq2: 40, type: 'sawtooth', duration: 1.2, volume: 0.3 }); playNoise({ duration: 1.2, volume: 0.2, filterFreq: 300, fType: 'lowpass' }); },
    footstep: (mode) => {
      const t = performance.now();
      const interval = mode === 'crouch' ? 520 : mode === 'sprint' ? 240 : 340;
      if (t - lastStepT < interval) return;
      lastStepT = t;
      const vol = mode === 'crouch' ? 0.025 : mode === 'sprint' ? 0.09 : 0.055;
      const freq = mode === 'crouch' ? 350 : mode === 'sprint' ? 1000 : 750;
      playNoise({ duration: 0.09, volume: vol, filterFreq: freq, fType: 'bandpass', group: 'footsteps' });
      if (mode === 'sprint' && Math.random() < 0.35) {
        playNoise({ duration: 0.25, volume: 0.04, filterFreq: 1200, sweepTo: 400, fType: 'bandpass', group: 'footsteps' });
      }
    },
    breathing: (winded) => {
      const t = performance.now();
      if (t - (audio._lastBreath||0) < (winded ? 950 : 2200)) return;
      audio._lastBreath = t;
      playNoise({ duration: winded ? 0.35 : 0.25, volume: winded ? 0.06 : 0.03, filterFreq: winded ? 500 : 800, sweepTo: winded ? 200 : 400, fType: 'lowpass', group: 'footsteps' });
    },
    heartbeatTick: (intensity) => {
      playTone({ freq: 55, type: 'sine', duration: 0.1, attack: 0.005, release: 0.09, volume: intensity * 0.25, group: 'monsters' });
      setTimeout(() => playTone({ freq: 45, type: 'sine', duration: 0.1, attack: 0.005, release: 0.09, volume: intensity * 0.18, group: 'monsters' }), 110);
    },
    flare: () => { playNoise({ duration: 0.5, volume: 0.2, filterFreq: 1200, sweepTo: 400, fType: 'bandpass' }); },
    teleport: () => { playTone({ freq: 200, freq2: 2200, type: 'sine', duration: 0.5, volume: 0.15, sweepT: 0.4 }); },
    smoke: () => { playNoise({ duration: 0.6, volume: 0.12, filterFreq: 300, fType: 'lowpass' }); },
    dagger: () => { playNoise({ duration: 0.1, volume: 0.12, filterFreq: 3000, fType: 'bandpass' }); },
    trapSpring: () => { playNoise({ duration: 0.2, volume: 0.18, filterFreq: 1800, fType: 'bandpass' }); },
    electric: () => { playTone({ freq: 60, type: 'square', duration: 0.12, volume: 0.12 }); },
    bump:     () => { playNoise({ duration: 0.12, volume: 0.05, filterFreq: 280, fType: 'lowpass', group: 'footsteps' }); },
    fanfare:  () => {
      // Three ascending tones + a boom
      const notes = [440, 660, 880];
      notes.forEach((f, i) => setTimeout(() => playTone({ freq: f, type: 'sine', duration: 0.22, volume: 0.15 }), i*130));
      setTimeout(() => playTone({ freq: 120, freq2: 50, type: 'sine', duration: 0.6, volume: 0.2 }), 400);
    },
    sting: () => {
      playTone({ freq: 900, freq2: 300, type: 'sawtooth', duration: 0.3, volume: 0.15 });
      playNoise({ duration: 0.3, volume: 0.08, filterFreq: 1600, fType: 'bandpass' });
    },
    startAmbient, stopAmbient,
    now, ensure, setVolume,
  };
})();

// Unlock audio on first user gesture (browsers require it)
function unlockAudio() {
  audio.ensure();
  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('keydown', unlockAudio);
}
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// ------------------------------------------------------------------
// THREE.JS SCENE
// ------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.05, 300);
camera.position.y = 1.55;

// Flashlight (parented to camera)
const flashlight = new THREE.SpotLight(0xfff4d6, 0, 24, Math.PI/7, 0.45, 1.2);
flashlight.position.set(0, 0, 0);
flashlight.target.position.set(0, 0, -1);
camera.add(flashlight);
camera.add(flashlight.target);
scene.add(camera);

// TESTING: lights cranked up so the whole maze is visible. To restore the dim
// horror baseline later, set ambient intensity back to ~0.06 and hemi to ~0.05.
const ambient = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xffeedd, 0x333333, 0.8);
scene.add(hemi);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------------
// THEME
// ------------------------------------------------------------------

function buildTheme() {
  const mat = (color, roughness = 0.95) => new THREE.MeshStandardMaterial({ color, roughness });
  return {
    id: 'labyrinth', name: 'The Labyrinth',
    accentColor: 0xff4010, fogColor: 0x060406, lightColor: 0xffb060,
    wallMat: mat(0x3a2e28),
    floorMat: mat(0x1e1a14),
    ceilMat:  mat(0x141210),
  };
}

function _deadCodeTheme_UNUSED(themeId) {
  if (themeId === 'hospital') {
    themeName = 'Modern Hospital';
    accentColor = 0xd0e8ff; fogColor = 0x1a2632; lightColor = 0xcfe6ff;
    // Tile walls — light grey grout pattern
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const gx = x % 32, gy = y % 32;
      const isGrout = gx < 2 || gy < 2;
      const noise = rng()*18;
      const base = isGrout ? 140 : 220 - noise;
      const bloodSplat = (x>180 && x<230 && y>60 && y<100) ? 60 : 0;
      return [base - bloodSplat, base - bloodSplat*1.2, base - bloodSplat*1.4, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const gx = x%64, gy = y%64;
      const isGrout = gx<2||gy<2;
      const n = rng()*10;
      const v = isGrout? 90 : 200 - n;
      return [v, v, v+5, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 230 - rng()*20;
      return [v, v, v, 255];
    });
  }
  else if (themeId === 'dungeon') {
    themeName = 'Medieval Dungeon';
    accentColor = 0xffb968; fogColor = 0x120a08; lightColor = 0xffa050;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const row = Math.floor(y / 40);
      const off = (row%2)*40;
      const xm = (x + off) % 80;
      const ym = y % 40;
      const isMortar = xm < 3 || ym < 3 || xm > 77;
      const n = rng()*30;
      const base = isMortar ? 40 : 90 - n;
      const moss = rng()<0.01 ? 20 : 0;
      return [base, base + moss, base - 10, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*25;
      const wet = rng()<0.02 ? 30 : 0;
      return [v, v + wet*0.3, v - 5, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 30 - rng()*15;
      return [v, v-2, v-4, 255];
    });
  }
  else if (themeId === 'asylum') {
    themeName = 'Abandoned Asylum';
    accentColor = 0xa8c490; fogColor = 0x161a15; lightColor = 0xaac090;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const peel = (rng() < 0.005) ? 60 : 0;
      const grime = (Math.sin(x*0.05)+1)*10;
      const v = 130 - rng()*25 - grime - peel;
      return [v + 20, v + 15, v, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const crack = (x%70 < 2 && y%60 > 20) ? 40 : 0;
      const v = 75 - rng()*15 - crack;
      return [v+5, v, v-3, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*15;
      return [v+8, v+4, v, 255];
    });
  }
  else if (themeId === 'mine') {
    themeName = 'Abandoned Mine';
    accentColor = 0xffc070; fogColor = 0x0d0806; lightColor = 0xffa860;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 60 - rng()*30;
      const ore = rng()<0.01 ? 80 : 0;
      return [v + 15 + ore*0.4, v + 5 + ore*0.2, v, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 45 - rng()*20;
      return [v+10, v+5, v-3, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 20 - rng()*10;
      return [v, v-2, v-4, 255];
    });
  }
  else if (themeId === 'meat') {
    themeName = 'Slaughterhouse';
    accentColor = 0xff6060; fogColor = 0x1a0606; lightColor = 0xffa0a0;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const tileX = Math.floor(x/32), tileY = Math.floor(y/32);
      const isGrout = x%32<2 || y%32<2;
      const blood = (rng()<0.008) ? 120 : 0;
      const v = isGrout ? 50 : 190 - rng()*20;
      return [v + blood*0.6, Math.max(0, v - blood), Math.max(0, v - blood), 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const pool = (Math.sin(x*0.05)+Math.cos(y*0.05) > 1.5) ? 80 : 0;
      const v = 100 - rng()*20;
      return [v + pool*0.7, Math.max(0, v - pool*0.6), Math.max(0, v - pool*0.6), 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 80 - rng()*20;
      return [v, v-5, v-5, 255];
    });
  }
  else if (themeId === 'library') {
    themeName = 'Forgotten Library';
    accentColor = 0xffd090; fogColor = 0x14100a; lightColor = 0xffc080;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const row = Math.floor(y/16);
      const panel = y%16;
      const isLine = panel<1;
      const n = rng()*15;
      const v = isLine ? 30 : 75 - n;
      return [v + 18, v + 10, v - 5, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const plank = Math.floor(x/48);
      const isSeam = x%48 < 2;
      const n = rng()*15;
      const v = isSeam ? 25 : 85 - n - plank%2*8;
      return [v+15, v+8, v-3, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*15;
      return [v+10, v+5, v, 255];
    });
  }
  else if (themeId === 'sewer') {
    themeName = 'Putrid Sewer';
    accentColor = 0x80c090; fogColor = 0x0a1410; lightColor = 0x90c0a0;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const tx = x%24, ty = y%24;
      const isGrout = tx<1 || ty<1;
      const slime = (rng()<0.015) ? 40 : 0;
      const v = isGrout ? 30 : 75 - rng()*20;
      return [v, v + slime*0.8, v + slime*0.2, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*25;
      return [v-5, v + 10, v - 8, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 35 - rng()*15;
      return [v, v+3, v, 255];
    });
  }
  else if (themeId === 'factory') {
    themeName = 'Rusted Factory';
    accentColor = 0xffae70; fogColor = 0x14100a; lightColor = 0xffb070;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const rust = (rng()<0.03) ? 60 : 0;
      const v = 100 - rng()*30;
      return [v + rust*0.8, v - rust*0.2, v - rust*0.5, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const grid = (x%40<2 || y%40<2);
      const v = grid ? 50 : 90 - rng()*25;
      return [v, v-5, v-10, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const beam = y%60 < 4;
      const v = beam ? 30 : 45 - rng()*15;
      return [v, v-4, v-6, 255];
    });
  }
  else if (themeId === 'cave') {
    themeName = 'Dripping Cave';
    accentColor = 0xa0e0ff; fogColor = 0x080a0c; lightColor = 0xc0d8ff;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const b = (Math.sin(x*0.07)+Math.cos(y*0.06))*10;
      const damp = rng()<0.02 ? 30 : 0;
      const v = 55 - rng()*20 + b;
      return [v - damp*0.2, v - damp*0.1, v + damp*0.4, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const wet = rng()<0.03 ? 25 : 0;
      const v = 40 - rng()*20;
      return [v, v, v + wet, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const stal = rng()<0.008 ? 50 : 0;
      const v = 25 - rng()*10;
      return [v + stal*0.3, v + stal*0.4, v + stal*0.6, 255];
    });
  }
  else if (themeId === 'cathedral') {
    themeName = 'Forsaken Cathedral';
    accentColor = 0xffe0b0; fogColor = 0x0c0a14; lightColor = 0xffd090;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const col = x%32, row = y%64;
      const isSeam = col<2 || row<2;
      const stain = rng()<0.005 ? 30 : 0;
      const v = isSeam ? 45 : 120 - rng()*30;
      return [v + stain*0.3, v, v - stain*0.1, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const tile = (Math.floor(x/32)+Math.floor(y/32))%2;
      const v = 80 - rng()*20 - tile*25;
      return [v + 10, v + 5, v - 5, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 50 - rng()*15;
      return [v, v - 3, v - 8, 255];
    });
  }
  else if (themeId === 'prison') {
    themeName = 'Iron Prison';
    accentColor = 0xffb070; fogColor = 0x0a0c0f; lightColor = 0xffa860;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const bar = x%48 < 4 && y > 60 && y < 200;
      const v = bar ? 35 : 95 - rng()*25;
      return [v - (bar?10:0), v - (bar?15:0), v - (bar?20:0), 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 60 - rng()*18;
      return [v, v-3, v-6, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 35 - rng()*10;
      return [v, v-2, v-5, 255];
    });
  }
  else if (themeId === 'crypt') {
    themeName = 'Bone Crypt';
    accentColor = 0xffe8a0; fogColor = 0x0f0c08; lightColor = 0xffd080;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const skull = (Math.sin(x*0.2)*Math.cos(y*0.2) > 0.85) ? 40 : 0;
      const v = 70 - rng()*25 + skull;
      return [v + 15, v + 8, v - 5, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const crack = (rng()<0.01) ? 20 : 0;
      const v = 50 - rng()*20 - crack;
      return [v + 10, v + 5, v - 3, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 30 - rng()*10;
      return [v + 5, v, v - 3, 255];
    });
  }
  else if (themeId === 'mansion') {
    themeName = 'Haunted Mansion';
    accentColor = 0xffd090; fogColor = 0x120a14; lightColor = 0xffc078;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const stripe = Math.floor(x/12) % 2;
      const damask = (Math.sin(x*0.2)+Math.sin(y*0.2)) > 1.3 ? 20 : 0;
      const v = 70 - stripe*15 - rng()*15 + damask;
      return [v + 15, v + 5, v + 20, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const plank = Math.floor(y/64) % 2;
      const seam = y%64 < 2;
      const v = seam ? 25 : 75 - plank*15 - rng()*12;
      return [v + 18, v + 8, v, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*12;
      return [v + 8, v + 3, v - 3, 255];
    });
  }
  else if (themeId === 'lab') {
    themeName = 'Bio Lab';
    accentColor = 0x80ffa0; fogColor = 0x081210; lightColor = 0xa0ffc0;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const panel = x%64 < 2 || y%64 < 2;
      const slime = rng()<0.008 ? 40 : 0;
      const v = panel ? 140 : 200 - rng()*15;
      return [v - slime*0.5, v + slime*0.2, v - slime*0.3, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 170 - rng()*20;
      return [v, v+5, v+3, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 220 - rng()*15;
      return [v, v, v+5, 255];
    });
  }
  else if (themeId === 'subway') {
    themeName = 'Abandoned Subway';
    accentColor = 0xffe080; fogColor = 0x0c0c10; lightColor = 0xffcc60;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const gx = x%40, gy = y%30;
      const grout = gx<1 || gy<1;
      const graffiti = rng()<0.005 ? 40 : 0;
      const v = grout ? 40 : 170 - rng()*20;
      return [v + graffiti*0.3, v - graffiti*0.2, v - graffiti*0.4, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 55 - rng()*15;
      return [v, v-3, v-5, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const v = 40 - rng()*12;
      return [v, v-2, v-4, 255];
    });
  }
  else if (themeId === 'attic') {
    themeName = 'Dusty Attic';
    accentColor = 0xffcc80; fogColor = 0x15100a; lightColor = 0xffb060;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const plank = Math.floor(y/24)%2;
      const seam = y%24 < 2;
      const v = seam ? 25 : 90 - plank*12 - rng()*18;
      return [v + 20, v + 10, v - 3, 255];
    });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const plank = Math.floor(y/40)%2;
      const seam = y%40 < 2;
      const v = seam ? 22 : 75 - plank*10 - rng()*15;
      return [v + 15, v + 5, v - 5, 255];
    });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => {
      const beam = x%80 < 4;
      const v = beam ? 28 : 55 - rng()*12;
      return [v + 8, v + 3, v - 2, 255];
    });
  }
  else if (themeId === 'horror_hall') {
    themeName = 'Horror Corridor';
    accentColor = 0xffb050; fogColor = 0x0a0a10; lightColor = 0xffc070;
    // Materials are unused at render time for this theme — the kit supplies
    // its own baked materials. We still return valid placeholders so code
    // paths that reference theme.wallMat/floorMat/ceilMat don't crash.
    wallCanvas = makeNoiseCanvas(4, 4, () => [100, 100, 100, 255]);
    floorCanvas = makeNoiseCanvas(4, 4, () => [60, 60, 60, 255]);
    ceilCanvas = makeNoiseCanvas(4, 4, () => [40, 40, 40, 255]);
  }
  else { // fallback: stone
    themeName = 'Ancient Stone';
    accentColor = 0xccccff; fogColor = 0x0a0a14; lightColor = 0xccccff;
    wallCanvas = makeNoiseCanvas(size, size, (x,y) => { const v=90-rng()*25; return [v,v,v+5,255]; });
    floorCanvas = makeNoiseCanvas(size, size, (x,y) => { const v=60-rng()*25; return [v,v,v+3,255]; });
    ceilCanvas = makeNoiseCanvas(size, size, (x,y) => { const v=40-rng()*15; return [v,v,v+2,255]; });
  }

  const makeTex = (canvas, rep=1) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const wallTex = makeTex(wallCanvas, 1);
  const floorTex = makeTex(floorCanvas, 1);
  const ceilTex = makeTex(ceilCanvas, 1);

  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85, metalness: 0.05 });
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0.02 });
  const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 1.0, metalness: 0.0 });

  // For dungeon/mine/library/meat, make walls warmer under lighting
  if (themeId === 'dungeon' || themeId === 'mine' || themeId === 'library' || themeId === 'meat') {
    wallMat.color = new THREE.Color(1.1, 1.0, 0.95);
  }
}

// ------------------------------------------------------------------
// MAZE GENERATION (recursive backtracker, seeded)
// ------------------------------------------------------------------
function generateMaze(rng, w, h) {
  // Cells: each cell has walls {N,E,S,W} = true means wall present.
  const cells = [];
  for (let y=0;y<h;y++){
    const row=[];
    for (let x=0;x<w;x++) row.push({ x, y, walls:{N:true,E:true,S:true,W:true}, visited:false });
    cells.push(row);
  }
  const stack = [];
  const start = cells[0][0];
  start.visited = true;
  stack.push(start);
  const dirs = [['N',0,-1],['E',1,0],['S',0,1],['W',-1,0]];
  const opp = { N:'S', S:'N', E:'W', W:'E' };
  while (stack.length) {
    const c = stack[stack.length-1];
    const neigh = [];
    for (const [d,dx,dy] of dirs) {
      const nx=c.x+dx, ny=c.y+dy;
      if (nx>=0&&ny>=0&&nx<w&&ny<h && !cells[ny][nx].visited) neigh.push([d,cells[ny][nx]]);
    }
    if (!neigh.length) { stack.pop(); continue; }
    const [d, n] = neigh[Math.floor(rng()*neigh.length)];
    c.walls[d] = false;
    n.walls[opp[d]] = false;
    n.visited = true;
    stack.push(n);
  }

  // Knock out some extra walls for loops (makes it less dead-end-y, more labyrinthine)
  const loopCount = Math.floor(w*h*0.08);
  for (let i=0;i<loopCount;i++){
    const x = Math.floor(rng()*w), y = Math.floor(rng()*h);
    const c = cells[y][x];
    const opts = [];
    if (y>0 && c.walls.N) opts.push(['N', cells[y-1][x], 'S']);
    if (x<w-1 && c.walls.E) opts.push(['E', cells[y][x+1], 'W']);
    if (y<h-1 && c.walls.S) opts.push(['S', cells[y+1][x], 'N']);
    if (x>0 && c.walls.W) opts.push(['W', cells[y][x-1], 'E']);
    if (opts.length) {
      const [d, n, o] = opts[Math.floor(rng()*opts.length)];
      c.walls[d] = false;
      n.walls[o] = false;
    }
  }
  return cells;
}

// Carve open rooms in the maze by knocking out interior walls of random rectangles.
// Mutates cells. Returns a list of rooms: { x, y, w, h } in cell coordinates.
function carveRooms(cells, rng, size) {
  const rooms = [];
  const attempts = Math.min(30, size * 2);
  // Room count scales with maze size
  const maxRooms = Math.max(2, Math.floor(size * size / 28));
  for (let i = 0; i < attempts && rooms.length < maxRooms; i++) {
    // 60% chance of 2x2, 30% of 2x3/3x2, 10% of 3x3
    const r = rng();
    let w, h;
    if (r < 0.6) { w = 2; h = 2; }
    else if (r < 0.9) { w = rng() < 0.5 ? 2 : 3; h = w === 2 ? 3 : 2; }
    else { w = 3; h = 3; }
    // Keep 1-cell buffer from edges so outer walls stay intact
    const rx = 1 + Math.floor(rng() * (size - w - 1));
    const ry = 1 + Math.floor(rng() * (size - h - 1));
    // Don't overlap the player spawn cell or existing rooms
    if (rx === 0 && ry === 0) continue;
    if (rx <= 0 && ry <= 0) continue;
    let overlap = false;
    for (const rm of rooms) {
      if (rx < rm.x + rm.w && rx + w > rm.x && ry < rm.y + rm.h && ry + h > rm.y) {
        overlap = true; break;
      }
    }
    if (overlap) continue;
    // Knock out interior walls within the rectangle
    for (let y = ry; y < ry + h; y++) {
      for (let x = rx; x < rx + w; x++) {
        if (x < rx + w - 1) { cells[y][x].walls.E = false; cells[y][x + 1].walls.W = false; }
        if (y < ry + h - 1) { cells[y][x].walls.S = false; cells[y + 1][x].walls.N = false; }
      }
    }
    rooms.push({ x: rx, y: ry, w, h });
  }
  return rooms;
}

function bfsDistance(cells, sx, sy) {
  const w = cells[0].length, h = cells.length;
  const dist = Array.from({length:h},()=>new Array(w).fill(-1));
  const q = [[sx,sy]]; dist[sy][sx] = 0;
  while (q.length) {
    const [x,y] = q.shift();
    const c = cells[y][x];
    const neighbors = [
      [!c.walls.N, x, y-1],
      [!c.walls.E, x+1, y],
      [!c.walls.S, x, y+1],
      [!c.walls.W, x-1, y],
    ];
    for (const [open, nx, ny] of neighbors) {
      if (open && nx>=0&&ny>=0&&nx<w&&ny<h && dist[ny][nx]===-1) {
        dist[ny][nx] = dist[y][x]+1;
        q.push([nx,ny]);
      }
    }
  }
  return dist;
}

// ------------------------------------------------------------------
// LEVEL BUILDING
// ------------------------------------------------------------------
const levelGroup = new THREE.Group();
scene.add(levelGroup);

// Geometry reused
const wallGeom = new THREE.BoxGeometry(TILE, WALL_H, 0.2);
const floorGeomCell = new THREE.PlaneGeometry(TILE, TILE);
const ceilGeomCell = new THREE.PlaneGeometry(TILE, TILE);

function clearLevel() {
  while (levelGroup.children.length) {
    const c = levelGroup.children.pop();
    if (c.geometry) c.geometry.dispose?.();
  }
  STATE.monsters = [];
  STATE.traps = [];
  STATE.pickups = [];
  STATE.corpses = [];
}

function buildLevel() {
  clearLevel();
  const level = STATE.level;
  const rng = mulberry32(STATE.seed + level*7919);
  const theme = buildTheme();
  const themeId = theme.id;
  const size = Math.min(40, 8 + Math.floor(level*1.6));
  const cells = generateMaze(rng, size, size);
  // Carve out open rooms — breaks the long-corridor monotony.
  const rooms = carveRooms(cells, rng, size);

  scene.fog = new THREE.FogExp2(theme.fogColor, 0.05);
  scene.background = new THREE.Color(theme.fogColor);

  // Floor & ceiling
  const span = size * TILE + 2 * TILE;
  const cx0  = size * TILE / 2 - TILE / 2;
  const bigFloor = new THREE.Mesh(new THREE.PlaneGeometry(span, span), theme.floorMat);
  bigFloor.rotation.x = -Math.PI / 2;
  bigFloor.position.set(cx0, 0, cx0);
  bigFloor.receiveShadow = true;
  levelGroup.add(bigFloor);

  const bigCeil = new THREE.Mesh(new THREE.PlaneGeometry(span, span), theme.ceilMat);
  bigCeil.rotation.x = Math.PI / 2;
  bigCeil.position.set(cx0, WALL_H, cx0);
  levelGroup.add(bigCeil);

  // Walls — BoxGeometry segments, AABBs for collision
  const wallAABBs = [];
  const wallGeom = new THREE.BoxGeometry(TILE, WALL_H, 0.3);

  function addWallAABB(x1, z1, x2, z2) {
    wallAABBs.push({
      minX: Math.min(x1, x2) - 0.15, maxX: Math.max(x1, x2) + 0.15,
      minZ: Math.min(z1, z2) - 0.15, maxZ: Math.max(z1, z2) + 0.15,
    });
  }
  function addWall(x1, z1, x2, z2) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const geom = len === TILE ? wallGeom : new THREE.BoxGeometry(len, WALL_H, 0.3);
    const m = new THREE.Mesh(geom, theme.wallMat);
    m.position.set((x1 + x2) / 2, WALL_H / 2, (z1 + z2) / 2);
    m.rotation.y = Math.atan2(z2 - z1, x2 - x1);
    m.castShadow = true;
    m.receiveShadow = true;
    levelGroup.add(m);
    addWallAABB(x1, z1, x2, z2);
  }

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = cells[y][x];
    const cx = x * TILE, cz = y * TILE, h = TILE / 2;
    if (c.walls.N) addWall(cx - h, cz - h, cx + h, cz - h);
    if (c.walls.W) addWall(cx - h, cz - h, cx - h, cz + h);
    if (y === size - 1 && c.walls.S) addWall(cx - h, cz + h, cx + h, cz + h);
    if (x === size - 1 && c.walls.E) addWall(cx + h, cz - h, cx + h, cz + h);
  }

  // Pick start (for spawn), key location (far from start), exit (further)
  const dist = bfsDistance(cells, 0, 0);
  let maxD = 0, exitCell = [0,0];
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    if (dist[y][x] > maxD) { maxD = dist[y][x]; exitCell = [x,y]; }
  }
  // Key: pick a cell that is far from both start and exit (so players explore)
  const distFromExit = bfsDistance(cells, exitCell[0], exitCell[1]);
  let bestKey = [0,0], bestScore = -1;
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const s = Math.min(dist[y][x], distFromExit[y][x]);
    if (s > bestScore && !(x===0&&y===0) && !(x===exitCell[0]&&y===exitCell[1])) {
      bestScore = s; bestKey = [x,y];
    }
  }

  // Scatter theme-appropriate props inside carved rooms. Skip cells that hold
  // the player spawn, exit door, or key so movement to them is never blocked.
  const forbidden = [[0, 0], [exitCell[0], exitCell[1]], [bestKey[0], bestKey[1]]];
  spawnPropsInRooms(themeId, rooms, rng, wallAABBs, forbidden);

  // Any room that didn't get props becomes a boring empty box — restore its
  // interior walls so it blends back into the regular maze.
  for (const room of rooms) {
    if ((room.propCount || 0) > 0) continue;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (x < room.x + room.w - 1) {
          cells[y][x].walls.E = true;
          cells[y][x+1].walls.W = true;
          const wx = x*TILE + TILE/2;
          addWall(wx, y*TILE - TILE/2, wx, y*TILE + TILE/2);
        }
        if (y < room.y + room.h - 1) {
          cells[y][x].walls.S = true;
          cells[y+1][x].walls.N = true;
          const wz = y*TILE + TILE/2;
          addWall(x*TILE - TILE/2, wz, x*TILE + TILE/2, wz);
        }
      }
    }
  }

  // Exit door object (interactable)
  const exitPos = cellToWorld(exitCell[0], exitCell[1]);
  const doorGeom = new THREE.BoxGeometry(2.2, 3.2, 0.25);
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x4a2820, roughness: 0.7, metalness: 0.3,
    emissive: new THREE.Color(theme.accentColor), emissiveIntensity: 0.18,
  });
  const door = new THREE.Mesh(doorGeom, doorMat);
  door.position.set(exitPos.x, 1.6, exitPos.z);
  door.userData = { type: 'exitdoor', cell: exitCell };
  levelGroup.add(door);

  // Pointlight on exit (flickering accent)
  const exitLight = new THREE.PointLight(theme.accentColor, 1.5, 7, 2);
  exitLight.position.set(exitPos.x, 2.8, exitPos.z);
  exitLight.userData = { type: 'flicker', base: 1.5, flicker: 0.5 };
  levelGroup.add(exitLight);

  // Key as pickup
  const keyPos = cellToWorld(bestKey[0], bestKey[1]);
  STATE.pickups.push({
    id: 'key_' + level,
    type: 'key',
    pos: [keyPos.x, 1.0, keyPos.z],
    mesh: spawnKeyMesh(keyPos.x, keyPos.z),
    taken: false,
  });

  // Scatter batteries & med packs & buff items along BFS distances
  const scatterCount = Math.min(12, 3 + Math.floor(size/2));
  const candidates = [];
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    if (x===0&&y===0) continue;
    if (x===exitCell[0]&&y===exitCell[1]) continue;
    if (x===bestKey[0]&&y===bestKey[1]) continue;
    candidates.push([x,y]);
  }
  shuffleInPlace(candidates, rng);
  // Monster-spawn candidates: must be at least 4 cells away from the player start
  // (measured by maze BFS distance, so it counts corners/walls correctly).
  const MONSTER_MIN_START_DIST = 4;
  const monsterCandidates = candidates.filter(([x, y]) =>
    (dist[y]?.[x] ?? 0) >= MONSTER_MIN_START_DIST
  );
  for (let i=0;i<scatterCount && i<candidates.length; i++) {
    const [cx,cy] = candidates[i];
    const wp = cellToWorld(cx, cy);
    const r = rng();
    let itemType;
    if (r < 0.4) itemType = 'battery';
    else if (r < 0.7) itemType = 'medpack';
    else {
      // random world item
      const items = ['flare','teltx','mirror','smoke','repellent','dagger'];
      itemType = items[Math.floor(rng()*items.length)];
    }
    STATE.pickups.push({
      id: `pk_${level}_${i}`,
      type: itemType,
      pos: [wp.x + (rng()-0.5)*1.2, 0.5, wp.z + (rng()-0.5)*1.2],
      mesh: spawnPickupMesh(itemType, wp.x, wp.z),
      taken: false,
    });
  }

  // Traps disabled for now. To re-enable: set trapCount back to
  // Math.min(20, Math.floor(1 + level*1.2)) and uncomment the spawn loop
  // below. spawnTrapMesh() and updateTrapsHost() are still intact.
  const trapCount = 0;
  // const trapCandidates = [...candidates];
  // shuffleInPlace(trapCandidates, rng);
  // for (let i=0;i<trapCount && i<trapCandidates.length; i++) {
  //   const [cx,cy] = trapCandidates[i];
  //   const wp = cellToWorld(cx, cy);
  //   const trapTypes = ['pit','bear','spike','gas','dart','crusher','electric','trip'];
  //   const trapType = trapTypes[Math.floor(rng()*trapTypes.length)];
  //   const trapMesh = spawnTrapMesh(trapType, wp.x, wp.z);
  //   STATE.traps.push({
  //     id: `trap_${level}_${i}`, type: trapType,
  //     pos: [wp.x, 0.02, wp.z], mesh: trapMesh,
  //     triggered: false, armed: true, cooldown: 0,
  //   });
  // }

  // Scattered torches
  const lightCount = Math.floor(size * size * 0.05);
  for (let i = 0; i < lightCount; i++) {
    const lcx = Math.floor(rng() * size), lcy = Math.floor(rng() * size);
    const wp = cellToWorld(lcx, lcy);
    spawnTorch(wp.x, wp.z, theme.lightColor, rng);
  }

  // Monsters (host decides). Skipped silently if MONSTER_DEFS is empty.
  if (STATE.isHost && Object.keys(MONSTER_DEFS).length) {
    const monsterBase = 3 + Math.floor(rng()*3);
    const monsterScale = Math.floor(level*0.8);
    const monsterCount = Math.min(16, monsterBase + monsterScale);
    shuffleInPlace(monsterCandidates, rng);
    for (let i=0;i<monsterCount && i<monsterCandidates.length;i++) {
      const [cx,cy] = monsterCandidates[i];
      const mtype = pickMonsterType(level, rng);
      if (!mtype) break;
      const wp = cellToWorld(cx, cy);
      spawnMonster(mtype, wp.x, wp.z);
    }
    // Dead players → deadplayer monsters (only if deadplayer type exists)
    if (level > 1 && MONSTER_DEFS.deadplayer) {
      for (const pid of STATE.deadPlayerIds) {
        const spawnCell = monsterCandidates[Math.floor(rng()*monsterCandidates.length)] || [size-1, size-1];
        const wp = cellToWorld(spawnCell[0], spawnCell[1]);
        spawnMonster('deadplayer', wp.x, wp.z, { ownerId: pid });
      }
    }
  }

  STATE.levelMeta = {
    theme, themeId, size, cells, keyCell: bestKey, exitCell, startCell: [0,0],
    wallAABBs, door, exitLight, distFromStart: dist,
  };
  STATE.exitOpen = false;
  STATE.keyHolderId = null;
  STATE.chosenThisLevel.clear();

  // (Ambient music hook — add your own loader in audio.startAmbient)
  // audio.startAmbient(themeId);

  // Fake exits (only visible to players with seesFakeExits debuff) — mark positions now
  STATE.fakeExitPositions = [];
  for (let i=0;i<4;i++) {
    const [cx,cy] = candidates[Math.floor(rng()*candidates.length)] || [0,0];
    const wp = cellToWorld(cx, cy);
    STATE.fakeExitPositions.push([wp.x, wp.z]);
  }
  STATE.fakeExitMeshes = [];

  // Announce the new level
  popup(`Level ${level} — ${theme.name}`, 3500);
  $('levelIndicator').textContent = `Level ${level} — ${theme.name}`;
}

// Show/hide fake exit meshes based on whether local player has the debuff
function updateFakeExits() {
  const wants = !!me.seesFakeExits;
  if (wants && STATE.fakeExitMeshes.length === 0 && STATE.fakeExitPositions) {
    for (const [x,z] of STATE.fakeExitPositions) {
      const doorGeom = new THREE.BoxGeometry(2.2, 3.2, 0.25);
      const doorMat = new THREE.MeshStandardMaterial({
        color: 0x4a2820, roughness: 0.7, metalness: 0.3,
        emissive: 0xaa00aa, emissiveIntensity: 0.15,
      });
      const d = new THREE.Mesh(doorGeom, doorMat);
      d.position.set(x, 1.6, z);
      d.userData.fakeExit = true;
      levelGroup.add(d);
      STATE.fakeExitMeshes.push(d);
    }
  } else if (!wants && STATE.fakeExitMeshes.length > 0) {
    for (const m of STATE.fakeExitMeshes) levelGroup.remove(m);
    STATE.fakeExitMeshes = [];
  }
}

function cellToWorld(cx, cy) {
  return { x: cx*TILE, z: cy*TILE };
}
function worldToCell(x, z) {
  return [Math.round(x/TILE), Math.round(z/TILE)];
}
function shuffleInPlace(arr, rng) {
  for (let i=arr.length-1;i>0;i--) {
    const j = Math.floor(rng()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// --- Item / key / trap / light meshes ---
const sharedGeoms = {
  key: new THREE.TorusGeometry(0.15, 0.05, 8, 16),
  battery: new THREE.BoxGeometry(0.25, 0.15, 0.15),
  medpack: new THREE.BoxGeometry(0.3, 0.2, 0.2),
  flare: new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8),
  teltx: new THREE.OctahedronGeometry(0.2, 0),
  mirror: new THREE.PlaneGeometry(0.3, 0.4),
  smoke: new THREE.SphereGeometry(0.18, 8, 8),
  repellent: new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8),
  dagger: new THREE.ConeGeometry(0.08, 0.4, 8),
  pit: new THREE.PlaneGeometry(TILE*0.9, TILE*0.9),
  bear: new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12),
  spike: new THREE.ConeGeometry(0.1, 0.3, 4),
  gas: new THREE.SphereGeometry(0.6, 8, 8),
  dart: new THREE.BoxGeometry(0.2, 0.2, 0.3),
  crusher: new THREE.BoxGeometry(TILE*0.8, 0.5, TILE*0.8),
  electric: new THREE.PlaneGeometry(TILE*0.8, TILE*0.8),
  trip: new THREE.CylinderGeometry(0.01, 0.01, TILE, 4),
};

// GLTF/GLB loader — models live under /models/ in the repo
const gltfLoader = new GLTFLoader();
const gltfCache = new Map();   // url -> Promise<gltf>

// ------------------------------------------------------------------
// PROPS — GLB assets loaded from models/props/
// ------------------------------------------------------------------
// Each builder returns { mesh: THREE.Group, footprint: { w, d, h }, nocollide? }.
// Footprint w/d are XZ collision extents. nocollide props are passable.

// GLB prop cache: populated at startup by loadPropGLBs()
const propGLBs = {};

(function loadPropGLBs() {
  const defs = [
    ['box1',       'models/props/box_01.glb'],
    ['box2',       'models/props/box_02.glb'],
    ['box3',       'models/props/box_03.glb'],
    ['box4',       'models/props/box_04.glb'],
    ['rack',       'models/props/metal_rack.glb'],
    ['pallet',     'models/props/wood_pallet.glb'],
    ['pipe',       'models/props/pvc_pipe.glb'],
    ['bag',        'models/props/garbage_bag.glb'],
    ['papers',     'models/props/papers.glb'],
    ['sign',       'models/props/sign_rusty.glb'],
    ['shovel',     'models/props/shovel.glb'],
    ['rock1',      'models/props/rock1.glb'],
    ['rock2',      'models/props/rock2.glb'],
    ['rock3',      'models/props/rock3.glb'],
    ['extinguisher','models/props/fire_extinguisher.glb'],
    ['pump',       'models/props/pump_station.glb'],
    ['wardrobe',   'models/props/wardrobe.glb'],
    ['bench',      'models/props/bench.glb'],
  ];
  for (const [key, path] of defs) {
    loadGLTF(path).then(gltf => {
      gltf.scene.updateMatrixWorld(true);
      propGLBs[key] = gltf.scene;
    }).catch(() => {});
  }
})();

function _glbProp(key, footprint, nocollide = false) {
  const src = propGLBs[key];
  if (!src) return { mesh: new THREE.Group(), footprint: { w: 0.01, d: 0.01, h: 0.01 }, nocollide: true };
  const mesh = src.clone(true);
  mesh.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });
  return { mesh, footprint, nocollide };
}

function propBox1()        { return _glbProp('box1',        { w: 0.65, d: 0.65, h: 0.60 }); }
function propBox2()        { return _glbProp('box2',        { w: 0.60, d: 0.50, h: 0.55 }); }
function propBox3()        { return _glbProp('box3',        { w: 0.45, d: 0.45, h: 0.50 }); }
function propBox4()        { return _glbProp('box4',        { w: 0.55, d: 0.55, h: 0.55 }); }
function propRack()        { return _glbProp('rack',        { w: 1.10, d: 0.50, h: 2.00 }); }
function propPallet()      { return _glbProp('pallet',      { w: 1.10, d: 1.10, h: 0.15 }); }
function propPipe()        { return _glbProp('pipe',        { w: 1.50, d: 0.20, h: 0.20 }, true); }
function propBag()         { return _glbProp('bag',         { w: 0.55, d: 0.55, h: 0.50 }, true); }
function propPapers()      { return _glbProp('papers',      { w: 0.40, d: 0.30, h: 0.05 }, true); }
function propSign()        { return _glbProp('sign',        { w: 0.40, d: 0.10, h: 0.60 }, true); }
function propShovel()      { return _glbProp('shovel',      { w: 0.15, d: 0.15, h: 1.20 }, true); }
function propRock1()       { return _glbProp('rock1',       { w: 0.70, d: 0.60, h: 0.50 }); }
function propRock2()       { return _glbProp('rock2',       { w: 0.50, d: 0.50, h: 0.40 }); }
function propRock3()       { return _glbProp('rock3',       { w: 0.55, d: 0.50, h: 0.45 }); }
function propExtinguisher(){ return _glbProp('extinguisher',{ w: 0.30, d: 0.30, h: 1.00 }); }
function propPump()        { return _glbProp('pump',        { w: 0.70, d: 0.50, h: 1.20 }); }
function propWardrobe()    { return _glbProp('wardrobe',    { w: 0.90, d: 0.50, h: 2.00 }); }
function propBench()       { return _glbProp('bench',       { w: 1.50, d: 0.50, h: 0.90 }); }

const PROP_POOL = {
  labyrinth: [
    propBox1, propBox2, propBox3, propBox4,
    propRack, propPallet, propPipe, propBag,
    propPapers, propSign, propShovel,
    propRock1, propRock2, propRock3,
    propExtinguisher, propPump,
    propWardrobe, propBench,
  ],
};


// Spawn props in carved rooms. Adds visible meshes to levelGroup and (for
// collidable props) pushes AABBs into wallAABBs for movement/line-of-sight.
function spawnPropsInRooms(themeId, rooms, rng, wallAABBs, forbidden=[]) {
  const pool = PROP_POOL[themeId] || PROP_POOL.labyrinth;
  const allProps = pool;
  const isForbidden = (cx, cy) => forbidden.some(([fx, fy]) => fx === cx && fy === cy);
  for (const room of rooms) {
    const cellCount = room.w * room.h;
    const target = 2 + Math.floor(rng() * Math.min(4, cellCount - 1));
    const placed = [];
    let tries = 0;
    while (placed.length < target && tries < target * 6) {
      tries++;
      const builder = allProps[Math.floor(rng() * allProps.length)];
      const result = builder();
      const fw = result.footprint.w, fd = result.footprint.d;
      // Pick a random cell in the room, then a random offset within that cell
      const cx = room.x + Math.floor(rng() * room.w);
      const cy = room.y + Math.floor(rng() * room.h);
      if (isForbidden(cx, cy)) continue;
      const center = cellToWorld(cx, cy);
      const jx = (rng() - 0.5) * (TILE - fw - 0.3);
      const jz = (rng() - 0.5) * (TILE - fd - 0.3);
      const wx = center.x + jx;
      const wz = center.z + jz;
      // Rotate 0 or 90 degrees
      const rotY = (rng() < 0.5) ? 0 : Math.PI/2;
      const isRot = Math.abs(rotY) > 0.01;
      const halfW = (isRot ? fd : fw) / 2;
      const halfD = (isRot ? fw : fd) / 2;
      const aabb = { minX: wx - halfW, maxX: wx + halfW, minZ: wz - halfD, maxZ: wz + halfD };
      // Don't overlap already-placed props
      let overlap = false;
      for (const p of placed) {
        if (aabb.minX < p.maxX && aabb.maxX > p.minX && aabb.minZ < p.maxZ && aabb.maxZ > p.minZ) {
          overlap = true; break;
        }
      }
      if (overlap) continue;
      // Don't overlap existing walls
      for (const w of wallAABBs) {
        // Small padding so we don't touch walls
        if (aabb.minX - 0.15 < w.maxX && aabb.maxX + 0.15 > w.minX && aabb.minZ - 0.15 < w.maxZ && aabb.maxZ + 0.15 > w.minZ) {
          overlap = true; break;
        }
      }
      if (overlap) continue;
      result.mesh.position.set(wx, 0, wz);
      result.mesh.rotation.y = rotY;
      result.mesh.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      levelGroup.add(result.mesh);
      placed.push(aabb);
      if (!result.nocollide) wallAABBs.push(aabb);
    }
    room.propCount = placed.length;
  }
}

function spawnKeyMesh(x, z) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(sharedGeoms.key, new THREE.MeshStandardMaterial({ color: 0xffd050, emissive: 0xffa020, emissiveIntensity: 0.7, metalness: 0.9, roughness: 0.2 }));
  m.castShadow = true;
  g.add(m);
  const bit = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.04), m.material);
  bit.position.set(0.18, -0.08, 0);
  g.add(bit);
  const glow = new THREE.PointLight(0xffc050, 0.8, 4);
  g.add(glow);
  g.position.set(x, 1.0, z);
  g.userData = { type: 'key', spin: true };
  levelGroup.add(g);
  return g;
}

function spawnPickupMesh(type, x, z) {
  const g = new THREE.Group();
  const colors = {
    battery: 0x80ff40, medpack: 0xff5050, flare: 0xff6040,
    teltx: 0x60a0ff, mirror: 0xcccccc, smoke: 0x808080,
    repellent: 0xa0ff80, dagger: 0xd0d0d0,
  };
  const m = new THREE.Mesh(
    sharedGeoms[type] || sharedGeoms.battery,
    new THREE.MeshStandardMaterial({
      color: colors[type] || 0xffffff,
      emissive: colors[type] || 0x444444,
      emissiveIntensity: 0.3,
      metalness: 0.4, roughness: 0.4,
    })
  );
  m.castShadow = true;
  g.add(m);
  g.position.set(x + (Math.random()-0.5), 0.5, z + (Math.random()-0.5));
  g.userData = { type, spin: true, itemType: type };
  levelGroup.add(g);
  return g;
}

function spawnTrapMesh(type, x, z) {
  const g = new THREE.Group();
  if (type === 'pit') {
    const m = new THREE.Mesh(sharedGeoms.pit, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    m.rotation.x = -Math.PI/2;
    m.position.y = 0.01;
    g.add(m);
    // Slight rim
    const rim = new THREE.Mesh(new THREE.RingGeometry(TILE*0.42, TILE*0.48, 16), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    rim.rotation.x = -Math.PI/2;
    rim.position.y = 0.02;
    g.add(rim);
  } else if (type === 'bear') {
    const m = new THREE.Mesh(sharedGeoms.bear, new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.8, roughness: 0.4 }));
    m.position.y = 0.05;
    g.add(m);
    // Teeth ring
    for (let i=0;i<12;i++) {
      const t = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 4), m.material);
      const ang = (i/12)*Math.PI*2;
      t.position.set(Math.cos(ang)*0.35, 0.2, Math.sin(ang)*0.35);
      t.rotation.x = Math.PI;
      g.add(t);
    }
  } else if (type === 'spike') {
    const mat = new THREE.MeshStandardMaterial({ color: 0x606060, metalness: 0.6, roughness: 0.5 });
    for (let i=0;i<9;i++) {
      const s = new THREE.Mesh(sharedGeoms.spike, mat);
      s.position.set((i%3-1)*0.4, 0.15, Math.floor(i/3-1)*0.4);
      g.add(s);
    }
  } else if (type === 'gas') {
    const m = new THREE.Mesh(sharedGeoms.gas, new THREE.MeshBasicMaterial({ color: 0x80c080, transparent: true, opacity: 0.15 }));
    m.position.y = 0.6;
    g.add(m);
  } else if (type === 'dart') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.3), new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.7 }));
    base.position.set(TILE*0.4, 1.2, 0);
    g.add(base);
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.15, 8), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    hole.rotation.z = Math.PI/2;
    hole.position.set(TILE*0.3, 1.2, 0);
    g.add(hole);
  } else if (type === 'crusher') {
    const plate = new THREE.Mesh(sharedGeoms.crusher, new THREE.MeshStandardMaterial({ color: 0x505050, metalness: 0.8, roughness: 0.3 }));
    plate.position.y = WALL_H - 0.25;
    g.add(plate);
    g.userData.crusherPlate = plate;
  } else if (type === 'electric') {
    const plate = new THREE.Mesh(sharedGeoms.electric, new THREE.MeshBasicMaterial({ color: 0x6080ff, transparent: true, opacity: 0.35 }));
    plate.rotation.x = -Math.PI/2;
    plate.position.y = 0.05;
    g.add(plate);
    const light = new THREE.PointLight(0x80a0ff, 0.5, 4);
    light.position.y = 0.3;
    g.add(light);
    g.userData.elecLight = light;
  } else if (type === 'trip') {
    const wire = new THREE.Mesh(sharedGeoms.trip, new THREE.MeshBasicMaterial({ color: 0x704020 }));
    wire.rotation.x = Math.PI/2;
    wire.position.y = 0.2;
    g.add(wire);
  }
  g.position.set(x, 0.02, z);
  g.userData = { type: 'trap', trapType: type };
  levelGroup.add(g);
  return g;
}

function spawnTorch(x, z, color, rng) {
  const g = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,0.5,6), new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 0.9 }));
  stick.position.y = WALL_H - 1.3;
  g.add(stick);
  const flameMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), flameMat);
  flame.position.y = WALL_H - 1.0;
  g.add(flame);
  const light = new THREE.PointLight(color, 1.2, 8, 2);
  light.position.y = WALL_H - 1.0;
  light.castShadow = false;
  g.add(light);
  g.position.set(x + (rng()-0.5)*TILE*0.4, 0, z + (rng()-0.5)*TILE*0.4);
  g.userData = { type: 'torch', flicker: rng()*Math.PI*2, light };
  levelGroup.add(g);
}

function spawnFluorescent(x, z, color, rng) {
  const g = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.15), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.2 }));
  bar.position.y = WALL_H - 0.1;
  g.add(bar);
  const light = new THREE.PointLight(color, 1.0, 7, 2);
  light.position.y = WALL_H - 0.3;
  g.add(light);
  g.position.set(x + (rng()-0.5)*TILE*0.4, 0, z + (rng()-0.5)*TILE*0.4);
  g.userData = { type: 'fluor', flicker: rng()*Math.PI*2, light, base: 1.0 };
  levelGroup.add(g);
}

// ------------------------------------------------------------------
// ITEM DEFINITIONS
// ------------------------------------------------------------------
const ITEM_DEFS = {
  flashlight: { name: 'Flashlight', icon: '🔦', color: 0xffffaa, description: 'Limited battery. [F] toggles, or left-click to toggle.' },
  battery:    { name: 'Battery', icon: '🔋', color: 0x80ff40, description: 'Recharges flashlight on use.' },
  medpack:    { name: 'Med Pack', icon: '✚', color: 0xff5050, description: 'Heals 60 HP.' },
  flare:      { name: 'Flare Gun', icon: '🧨', color: 0xff6040, description: 'Bright flare that scares monsters for 30s.' },
  teltx:      { name: 'Teleporter', icon: '◈', color: 0x60a0ff, description: 'Teleport to a random location.' },
  mirror:     { name: 'Mirror', icon: '▨', color: 0xcccccc, description: 'Stuns statue monsters and bounces gaze.' },
  smoke:      { name: 'Smoke Bomb', icon: '●', color: 0x808080, description: 'Blinds monsters in area for 10s.' },
  repellent:  { name: 'Repellent', icon: '♁', color: 0xa0ff80, description: 'Monsters avoid you for 20s.' },
  dagger:     { name: 'Dagger', icon: '🗡', color: 0xd0d0d0, description: 'Melee. Kill weaker monsters.' },
  key:        { name: 'Key', icon: '🔑', color: 0xffc050, description: 'Opens the exit door.' },
};

function itemMeta(type) { return ITEM_DEFS[type] || { name: type, icon: '?', color: 0xffffff, description: '' }; }

// ------------------------------------------------------------------
// BUFF / DEBUFF DEFINITIONS
// ------------------------------------------------------------------
// Rewards are: buffs, items, cure (removes a debuff). Lesser rewards may attach a debuff.
const BUFFS = [
  { id: 'hpmax',      name: '+25 Max HP',           apply: p => { p.maxHp += 25; p.hp = Math.min(p.hp + 25, p.maxHp); } },
  { id: 'hpmaxbig',   name: '+50 Max HP',           apply: p => { p.maxHp += 50; p.hp = Math.min(p.hp + 50, p.maxHp); } },
  { id: 'stammax',    name: '+30 Max Stamina',      apply: p => { p.maxStam += 30; p.stam = p.maxStam; } },
  { id: 'stammaxbig', name: '+60 Max Stamina',      apply: p => { p.maxStam += 60; p.stam = p.maxStam; } },
  { id: 'regen',      name: 'HP Regen (2/s)',       apply: p => { p.regen = (p.regen||0) + 2; } },
  { id: 'regenfast',  name: 'Fast Regen (4/s)',     apply: p => { p.regen = (p.regen||0) + 4; } },
  { id: 'speedup',    name: 'Swift Feet (+15%)',    apply: p => { p.speedMul = (p.speedMul||1) + 0.15; } },
  { id: 'speedup2',   name: 'Racing Feet (+30%)',   apply: p => { p.speedMul = (p.speedMul||1) + 0.30; } },
  { id: 'silent',     name: 'Silent Steps',         apply: p => { p.silent = true; } },
  { id: 'seewalls',   name: 'X-Ray: Monsters',      apply: p => { p.xrayMonsters = true; } },
  { id: 'nightvis',   name: 'Night Vision',         apply: p => { p.nightVision = true; } },
  { id: 'crouchfast', name: 'Crouch = Full Speed',  apply: p => { p.crouchFull = true; } },
  { id: 'slot6',      name: 'Extra Slot (6th)',     apply: p => { p.maxSlots = 6; } },
  { id: 'heavy',      name: 'Heavy Armor (-35% dmg)', apply: p => { p.armor = (p.armor||0) + 0.35; } },
  { id: 'ironskin',   name: 'Iron Skin (+20% armor)', apply: p => { p.armor = (p.armor||0) + 0.20; } },
  { id: 'battfree',   name: 'Infinite Battery',     apply: p => { p.infBattery = true; } },
  { id: 'flareaura',  name: 'Flare Aura',           apply: p => { p.flareAura = true; } },
  { id: 'lifesteal',  name: 'Lifesteal (+10 HP/kill)', apply: p => { p.lifesteal = (p.lifesteal||0) + 10; } },
  { id: 'thorns',     name: 'Thorns (reflect 5 dmg)', apply: p => { p.thorns = (p.thorns||0) + 5; } },
  { id: 'dodge',      name: 'Nimble (20% dodge)',   apply: p => { p.dodge = (p.dodge||0) + 0.2; } },
  { id: 'trapsense',  name: 'Trap Sense',           apply: p => { p.trapSense = true; } },
  { id: 'keysense',   name: 'Key Sense (compass)',  apply: p => { p.keySense = true; } },
  { id: 'exitsense',  name: 'Exit Sense (compass)', apply: p => { p.exitSense = true; } },
  { id: 'deathsave',  name: 'Second Chance',        apply: p => { p.deathSave = true; } },
  { id: 'flashpower', name: 'Brighter Flashlight',  apply: p => { p.flashPower = true; } },
  { id: 'adrenaline', name: 'Adrenaline (LowHP = +speed)', apply: p => { p.adrenaline = true; } },
  { id: 'secondwind', name: 'Second Wind (stam regen 3x)', apply: p => { p.stamRegenMul = (p.stamRegenMul||1) * 3; } },
  { id: 'quiet',      name: 'Unremarkable',         apply: p => { p.quiet = true; } },
  { id: 'medbonus',   name: 'Field Medic (+40 heal)', apply: p => { p.medBonus = (p.medBonus||0) + 40; } },
  { id: 'battbonus',  name: 'Efficient Batteries',  apply: p => { p.battBonus = true; } },
  { id: 'reveal',     name: 'Predator Sense',       apply: p => { p.reveal = true; } },
  { id: 'pocket',     name: 'Deep Pockets (+4 res)', apply: p => { p.maxReserve = (p.maxReserve||3) + 4; } },
  { id: 'echo',       name: 'Echo Sense',           apply: p => { p.echo = true; } },
  { id: 'dashboost',  name: 'Efficient Sprint',     apply: p => { p.sprintEff = (p.sprintEff||1) * 0.5; } },
  { id: 'scavenger',  name: 'Scavenger (range+)',   apply: p => { p.scavenger = true; } },
  { id: 'sturdy',     name: 'Sturdy (no bleed)',    apply: p => { p.noBleed = true; } },
];

const DEBUFFS = [
  { id: 'slow',          name: 'Sluggish Legs',           apply: p => { p.speedMul = (p.speedMul||1) * 0.8; } },
  { id: 'hpdown',        name: '-20 Max HP',              apply: p => { p.maxHp = Math.max(40, p.maxHp - 20); p.hp = Math.min(p.hp, p.maxHp); } },
  { id: 'stamdown',      name: '-20 Max Stamina',         apply: p => { p.maxStam = Math.max(30, p.maxStam - 20); p.stam = Math.min(p.stam, p.maxStam); } },
  { id: 'fakeexits',     name: 'Fake Exits',              apply: p => { p.seesFakeExits = true; } },
  { id: 'battdrain',     name: 'Battery Leak',            apply: p => { p.battDrainMul = (p.battDrainMul||1) * 2; } },
  { id: 'bleed',         name: 'Bleeding',                apply: p => { p.bleed = (p.bleed||0) + 1; } },
  { id: 'curseddig',     name: 'Cursed (-40 Max HP)',     apply: p => { p.maxHp = Math.max(30, p.maxHp - 40); p.hp = Math.min(p.hp, p.maxHp); } },
  { id: 'loud',          name: 'Loud Footsteps',          apply: p => { p.loud = true; } },
  { id: 'trembling',     name: 'Trembling Hands',         apply: p => { p.trembling = true; } },
  { id: 'phobia',        name: 'Phobia',                  apply: p => { p.phobia = true; } },
  { id: 'dysfunction',   name: 'Flashlight Dysfunction',  apply: p => { p.flashGlitch = true; } },
  { id: 'butterfingers', name: 'Butterfingers',           apply: p => { p.butterfingers = true; } },
  { id: 'heavyfeet',     name: 'Heavy Feet (no sprint)',  apply: p => { p.noSprint = true; } },
  { id: 'sickness',      name: 'Sickness (HP drain)',     apply: p => { p.bleed = (p.bleed||0) + 0.5; } },
  { id: 'crooked',       name: 'Crooked Neck',            apply: p => { p.crooked = true; } },
  { id: 'confusion',     name: 'Confusion',               apply: p => { p.confusion = true; } },
  { id: 'gasping',       name: 'Gasping (stam 2x drain)', apply: p => { p.stamDrainMul = (p.stamDrainMul||1) * 2; } },
  { id: 'weakgrip',      name: 'Weak Grip',               apply: p => { p.weakGrip = true; } },
];

function removeDebuff(player, debuffId) {
  player.debuffs = (player.debuffs||[]).filter(d => d !== debuffId);
  // Recompute stats cleanly by replaying buffs only
  recomputeStats(player);
}

function recomputeStats(player) {
  const wasHp = player.hp;
  // Reset baseline
  player.maxHp = 100;
  player.maxStam = 100;
  player.speedMul = 1;
  player.regen = 0;
  player.armor = 0;
  player.silent = false;
  player.xrayMonsters = false;
  player.nightVision = false;
  player.crouchFull = false;
  player.maxSlots = 5;
  player.infBattery = false;
  player.flareAura = false;
  player.seesFakeExits = false;
  player.battDrainMul = 1;
  player.stamDrainMul = 1;
  player.stamRegenMul = 1;
  player.bleed = 0;
  player.lifesteal = 0;
  player.thorns = 0;
  player.dodge = 0;
  player.trapSense = false;
  player.keySense = false;
  player.exitSense = false;
  player.deathSave = false;
  player.flashPower = false;
  player.adrenaline = false;
  player.quiet = false;
  player.medBonus = 0;
  player.battBonus = false;
  player.reveal = false;
  player.maxReserve = 3;
  player.echo = false;
  player.sprintEff = 1;
  player.scavenger = false;
  player.noBleed = false;
  player.loud = false;
  player.trembling = false;
  player.phobia = false;
  player.flashGlitch = false;
  player.butterfingers = false;
  player.noSprint = false;
  player.crooked = false;
  player.confusion = false;
  player.weakGrip = false;
  for (const bid of (player.buffs||[])) {
    const b = BUFFS.find(x => x.id === bid);
    if (b) b.apply(player);
  }
  for (const did of (player.debuffs||[])) {
    const d = DEBUFFS.find(x => x.id === did);
    if (d) d.apply(player);
  }
  if (player.noBleed) player.bleed = 0;
  player.hp = Math.min(wasHp || player.maxHp, player.maxHp);
}

// ------------------------------------------------------------------
// MONSTER DEFINITIONS
// ------------------------------------------------------------------
// MONSTER_DEFS is intentionally empty — add new monster definitions here.
// Template (copy + edit):
//   myMonster: {
//     name: 'My Monster', color: 0xff0000, hp: 50, speed: 2.2,
//     sightRange: 12, sightAngle: 80, damage: 12, attackRange: 1.6,
//     attackCooldown: 1.4, size: 1.0,
//     build: () => monsterBodyBasic(0x602020, 1.8),
//     // Optional: special: 'stalker' | 'mimic' | 'statue' | 'shadow' | 'hunter' |
//     //                    'wailer' | 'phantom' | 'deadplayer' | 'stretcher' |
//     //                    'spider' | 'doppelganger' | 'leech' | 'wraith' |
//     //                    'siren' | 'bloater' | 'hivemind' | 'gazer' | 'carrier'
//   },
const MONSTER_DEFS = {
  huggy: {
    name: 'Huggy Wuggy', color: 0x2c4fa8, hp: 80, speed: 3.0,
    sightRange: 18, sightAngle: 120, damage: 22, attackRange: 2.2,
    attackCooldown: 1.3, size: 1.2,
    build: () => monsterBodyGLB('models/huggy.glb', null, { scale: 0.65, yOffset: -0.1 }),
    // special: left unset → uses default stalker chase/attack AI
  },
};

// --- Removed monster archive (uncomment or reintroduce as needed) ---
const _REMOVED_MONSTER_DEFS_REFERENCE = {
  stalker: {
    name: 'Stalker', color: 0x802020, hp: 50, speed: 2.2, sightRange: 12, sightAngle: 80, damage: 12, attackRange: 1.6, attackCooldown: 1.4,
    size: 1.0,
    build: () => monsterBodyBasic(0x402020, 1.8),
  },
  mimic: {
    name: 'Mimic', color: 0x301020, hp: 55, speed: 2.5, sightRange: 14, sightAngle: 100, damage: 15, attackRange: 1.8, attackCooldown: 1.2,
    size: 1.0,
    build: () => monsterBodyBasic(0x203030, 1.8),
    special: 'mimic',
  },
  statue: {
    name: 'Stalker Statue', color: 0x444444, hp: 120, speed: 6.0, sightRange: 40, sightAngle: 360, damage: 25, attackRange: 1.6, attackCooldown: 1.8,
    size: 1.0,
    build: () => monsterBodyBasic(0x666666, 1.9),
    special: 'statue', // moves only when not observed
  },
  shadow: {
    name: 'Shadow', color: 0x000000, hp: 30, speed: 2.6, sightRange: 15, sightAngle: 120, damage: 18, attackRange: 1.4, attackCooldown: 1.5,
    size: 0.9,
    build: () => monsterBodyBasic(0x050505, 1.6),
    special: 'shadow', // invisible in dark, revealed+stunned by flashlight
  },
  hunter: {
    name: 'Hunter', color: 0x603010, hp: 40, speed: 3.4, sightRange: 18, sightAngle: 70, damage: 14, attackRange: 1.6, attackCooldown: 1.0,
    size: 1.0,
    build: () => monsterBodyBasic(0x503010, 2.0),
    special: 'hunter', // hears sprinting
  },
  crawler: {
    name: 'Crawler', color: 0x205020, hp: 25, speed: 2.8, sightRange: 10, sightAngle: 180, damage: 8, attackRange: 1.3, attackCooldown: 0.7,
    size: 0.6,
    build: () => monsterBodyBasic(0x204020, 0.9),
  },
  wailer: {
    name: 'Wailer', color: 0x303050, hp: 40, speed: 1.5, sightRange: 16, sightAngle: 100, damage: 6, attackRange: 6.0, attackCooldown: 2.5,
    size: 1.1,
    build: () => monsterBodyBasic(0x20203a, 2.0),
    special: 'wailer', // ranged scream
  },
  hulker: {
    name: 'Hulker', color: 0x401010, hp: 150, speed: 1.2, sightRange: 14, sightAngle: 90, damage: 45, attackRange: 2.5, attackCooldown: 2.2,
    size: 1.6,
    build: () => monsterBodyBasic(0x301010, 2.8),
  },
  phantom: {
    name: 'Phantom', color: 0x506080, hp: 35, speed: 2.3, sightRange: 20, sightAngle: 360, damage: 14, attackRange: 1.4, attackCooldown: 1.3,
    size: 1.0,
    build: () => monsterBodyBasic(0x304050, 1.8, true),
    special: 'phantom', // ignores walls
  },
  deadplayer: {
    name: 'Risen Dead', color: 0x502020, hp: 45, speed: 2.8, sightRange: 15, sightAngle: 100, damage: 16, attackRange: 1.5, attackCooldown: 1.2,
    size: 1.0,
    build: () => monsterBodyBasic(0x601818, 1.8),
    special: 'deadplayer',
  },
  stretcher: {
    name: 'Stretcher', color: 0x302030, hp: 80, speed: 1.4, sightRange: 25, sightAngle: 140, damage: 22, attackRange: 3.5, attackCooldown: 1.8,
    size: 1.2,
    build: () => monsterBodyBasic(0x241828, 3.6),
    special: 'stretcher', // very tall — attack range large, reaches over walls
  },
  spider: {
    name: 'Spider', color: 0x101510, hp: 30, speed: 3.2, sightRange: 10, sightAngle: 360, damage: 10, attackRange: 1.3, attackCooldown: 0.8,
    size: 0.5,
    build: () => monsterBodyBasic(0x101518, 0.8),
    special: 'spider', // scuttles on ceiling mostly, drops when below
  },
  doppelganger: {
    name: 'Doppelgänger', color: 0x503030, hp: 40, speed: 2.4, sightRange: 14, sightAngle: 120, damage: 17, attackRange: 1.5, attackCooldown: 1.1,
    size: 1.0,
    build: () => monsterBodyBasic(0x301020, 1.8),
    special: 'doppelganger', // takes random player's color at spawn
  },
  leech: {
    name: 'Leech', color: 0x204050, hp: 20, speed: 3.4, sightRange: 12, sightAngle: 200, damage: 6, attackRange: 1.2, attackCooldown: 0.6,
    size: 0.4,
    build: () => monsterBodyBasic(0x103040, 0.6),
    special: 'leech', // slows on hit
  },
  wraith: {
    name: 'Wraith', color: 0x4060a0, hp: 40, speed: 2.6, sightRange: 18, sightAngle: 360, damage: 14, attackRange: 1.4, attackCooldown: 1.3,
    size: 1.0,
    build: () => monsterBodyBasic(0x3050a0, 1.9, true),
    special: 'wraith', // damaged by flashlight, heals in dark
  },
  siren: {
    name: 'Siren', color: 0x4030a0, hp: 35, speed: 0, sightRange: 0, sightAngle: 0, damage: 10, attackRange: 0, attackCooldown: 0,
    size: 1.1,
    build: () => monsterBodyBasic(0x2020a0, 2.1),
    special: 'siren', // stationary; plays crying audio, damages when close
  },
  bloater: {
    name: 'Bloater', color: 0x603050, hp: 60, speed: 1.1, sightRange: 12, sightAngle: 120, damage: 18, attackRange: 1.8, attackCooldown: 1.8,
    size: 1.3,
    build: () => monsterBodyBasic(0x603050, 2.2),
    special: 'bloater', // on death, explosion AoE
  },
  hivemind: {
    name: 'Hivemind', color: 0x285020, hp: 90, speed: 1.8, sightRange: 14, sightAngle: 180, damage: 12, attackRange: 1.6, attackCooldown: 1.4,
    size: 1.1,
    build: () => monsterBodyBasic(0x205020, 2.1),
    special: 'hivemind', // when hit, spawns crawler
  },
  gazer: {
    name: 'Gazer', color: 0x400080, hp: 50, speed: 1.8, sightRange: 16, sightAngle: 360, damage: 8, attackRange: 10, attackCooldown: 0.5,
    size: 1.0,
    build: () => monsterBodyBasic(0x400080, 1.9),
    special: 'gazer', // damages players looking at it
  },
  carrier: {
    name: 'Carrier', color: 0x606060, hp: 45, speed: 2.0, sightRange: 14, sightAngle: 120, damage: 12, attackRange: 1.5, attackCooldown: 1.3,
    size: 1.0,
    build: () => monsterBodyBasic(0x606060, 1.8),
    special: 'carrier', // drops medpack on death
  },
};

function pickMonsterType(level, rng) {
  // Picks dynamically from whatever's defined in MONSTER_DEFS.
  // When re-adding monsters, you can reintroduce a level-tier pool here.
  const keys = Object.keys(MONSTER_DEFS);
  if (!keys.length) return null;
  return keys[Math.floor(rng()*keys.length)];
}

function loadGLTF(url) {
  if (gltfCache.has(url)) return gltfCache.get(url);
  const p = new Promise((resolve, reject) => {
    gltfLoader.load(url, gltf => resolve(gltf), undefined, err => reject(err));
  });
  gltfCache.set(url, p);
  return p;
}

// Build a monster body from a GLB file. Returns a Group immediately; populates
// the real mesh asynchronously, normalizing size to `desiredHeight` (in meters).
function monsterBodyGLB(url, desiredHeight=2.0, opts={}) {
  const g = new THREE.Group();
  g.userData.height = desiredHeight;
  // Temporary placeholder so collisions/AI don't see a blank spot
  const ph = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.35, desiredHeight*0.9, 6),
    new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.35 })
  );
  ph.position.y = desiredHeight*0.45;
  g.add(ph);
  g.userData.placeholder = ph;

  loadGLTF(url).then(gltf => {
    const model = skeletonClone(gltf.scene);
    // SkinnedMesh ignores its own scene-graph transform during skinning, so use
    // the raw geometry bounding boxes in their native space — that's the space
    // the GPU actually draws them in.
    const bbox = new THREE.Box3();
    model.traverse(o => {
      if ((o.isMesh || o.isSkinnedMesh) && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        bbox.union(o.geometry.boundingBox);
      }
    });
    const size = new THREE.Vector3();
    bbox.getSize(size);
    // Scale: explicit override wins, else derive from bbox
    const scale = (opts.scale != null)
      ? opts.scale
      : (size.y > 0 ? desiredHeight / size.y : 1);
    // Floor offset: explicit override wins, else bottom-align the raw bbox
    const yOffset = (opts.yOffset != null)
      ? opts.yOffset
      : -bbox.min.y * scale;
    // Wrap in a group so we can scale without breaking SkinnedMesh skeleton bindings.
    const wrapper = new THREE.Group();
    wrapper.scale.setScalar(scale);
    wrapper.position.y = yOffset;
    if (opts.yawOffset) wrapper.rotation.y = opts.yawOffset;
    wrapper.add(model);
    model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
    g.remove(ph);
    g.add(wrapper);
    g.userData.model = model;
    g.userData.wrapper = wrapper;
    if (gltf.animations && gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(model);
      const actions = {};
      const findClip = rx => gltf.animations.find(c => rx.test(c.name));
      const findAllClips = rx => gltf.animations.filter(c => rx.test(c.name));
      const idle = findClip(/idle/i);
      const run  = findClip(/run/i);
      const walk = findClip(/walk/i);
      const attackClips = findAllClips(/punch|attack/i);
      if (idle) actions.idle = mixer.clipAction(idle);
      if (run)  actions.run  = mixer.clipAction(run);
      if (walk) actions.walk = mixer.clipAction(walk);
      // Attack animations play once; array lets the AI pick one at random so
      // multi-punch models don't always swing the same way.
      actions.attacks = attackClips.map(c => {
        const a = mixer.clipAction(c);
        a.setLoop(THREE.LoopOnce);
        a.clampWhenFinished = false;
        return a;
      });
      actions.attackDuration = attackClips.length
        ? attackClips.reduce((s, c) => s + c.duration, 0) / attackClips.length
        : 0;
      // Keep `attack` key pointing at the first one for the state picker below.
      if (actions.attacks.length) actions.attack = actions.attacks[0];
      if (!actions.idle) actions.idle = mixer.clipAction(gltf.animations[0]);
      actions.idle.play();
      g.userData.mixer = mixer;
      g.userData.actions = actions;
      g.userData.currentAction = 'idle';
      g.userData.clips = gltf.animations;
    }
  }).catch(err => {
    console.warn('[trapped] GLB load failed:', url, err);
  });

  // Proxy userData entries used by the walking animation code paths (armL/armR).
  // For GLB monsters we animate via the AnimationMixer, not by rotating limbs.
  g.userData.noProcWalkAnim = true;
  return g;
}

// ------------------------------------------------------------------
// HORROR MODULAR KIT — loaded once, pieces cloned per-level
// ------------------------------------------------------------------
const kitPieces = {};        // canonical name -> source Object3D (clone with .clone(true))
let kitLoadPromise = null;

function loadHorrorKit() {
  if (kitLoadPromise) return kitLoadPromise;
  kitLoadPromise = loadGLTF('models/horror_floor_kit.glb').then(gltf => {
    gltf.scene.updateMatrixWorld(true);
    const AGGREGATES = new Set(['Sketchfab_Scene', 'Sketchfab_model', 'RootNode']);
    const found = [];
    gltf.scene.traverse(o => {
      if (!o.name) return;
      if (AGGREGATES.has(o.name)) return;
      // three.js strips the dot from Blender names: "Wall_02.037" -> "Wall_02037"
      // and ".fbx" -> "fbx" at end
      if (/fbx$/i.test(o.name)) return;
      // Skip if any ancestor is already a collected piece (children of a cached
      // piece are its sub-meshes, not separate pieces).
      let skip = false;
      let p = o.parent;
      while (p) {
        if (found.some(f => f.node === p)) { skip = true; break; }
        p = p.parent;
      }
      if (skip) return;
      // Only nodes that actually contain geometry
      let hasMesh = false;
      o.traverse(c => { if (c.isMesh) hasMesh = true; });
      if (!hasMesh) return;
      // Strip trailing 3-digit Blender version suffix ("Wall_02037" -> "Wall_02")
      const canonical = o.name.replace(/\d{3}$/, '');
      found.push({ node: o, canonical });
    });
    for (const { node, canonical } of found) {
      if (kitPieces[canonical]) continue;
      // Bake the world matrix from the original hierarchy into the local
      // transform so each piece is self-contained when cloned.
      node.matrix.copy(node.matrixWorld);
      node.matrix.decompose(node.position, node.quaternion, node.scale);
      node.matrixAutoUpdate = true;
      kitPieces[canonical] = node;
    }
    console.log('[trapped] horror kit pieces:', Object.keys(kitPieces));
    return kitPieces;
  }).catch(err => {
    console.warn('[trapped] horror kit load failed:', err);
    return null;
  });
  return kitLoadPromise;
}

// Return a fresh wrapper-group around a cloned kit piece. The inner clone keeps
// the baked orientation (e.g., the kit's Y-up conversion); the wrapper is what
// the caller positions and rotates around world Y. Returns null if the piece
// isn't loaded.
function kitPiece(name) {
  const src = kitPieces[name];
  if (!src) return null;
  const inner = src.clone(true);
  inner.position.set(0, 0, 0);
  inner.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });
  const wrapper = new THREE.Group();
  wrapper.add(inner);
  return wrapper;
}

// Preload in the background so when a horror_hall level rolls, the kit is ready.
// loadHorrorKit(); // disabled — GLB kit not in use

function monsterBodyBasic(color, height, transparent=false) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0.05,
    transparent, opacity: transparent ? 0.5 : 1.0,
    emissive: color, emissiveIntensity: 0.05,
  });
  // Torso
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, height*0.6, 8), mat);
  torso.position.y = height*0.5;
  torso.castShadow = true;
  g.add(torso);
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), mat);
  head.position.y = height*0.92;
  head.castShadow = true;
  g.add(head);
  // Arms
  const armGeom = new THREE.CylinderGeometry(0.08, 0.08, height*0.45, 5);
  const armL = new THREE.Mesh(armGeom, mat); armL.position.set(-0.38, height*0.55, 0); g.add(armL);
  const armR = new THREE.Mesh(armGeom, mat); armR.position.set( 0.38, height*0.55, 0); g.add(armR);
  // Eyes (glowing points for spook factor)
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3030 });
  const eyeGeom = new THREE.SphereGeometry(0.035, 6, 6);
  const eyeL = new THREE.Mesh(eyeGeom, eyeMat); eyeL.position.set(-0.09, height*0.94, 0.25); g.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeom, eyeMat); eyeR.position.set( 0.09, height*0.94, 0.25); g.add(eyeR);
  g.userData.armL = armL; g.userData.armR = armR; g.userData.body = g;
  g.userData.height = height;
  return g;
}

function buildCorpseMesh(color, yaw=0) {
  // Ragdoll-style horizontal body with splayed limbs + blood pool underneath
  const g = new THREE.Group();
  const c = new THREE.Color(color || '#cc4040');
  const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.0 });
  // Blood pool
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(0.9, 20),
    new THREE.MeshBasicMaterial({ color: 0x3a0505, transparent: true, opacity: 0.85 })
  );
  pool.rotation.x = -Math.PI/2;
  pool.position.set(0, 0.02, 0);
  g.add(pool);
  // Torso — lying flat
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 8), mat);
  torso.rotation.z = Math.PI/2;
  torso.position.set(0, 0.3, 0);
  torso.castShadow = true;
  g.add(torso);
  // Head — slumped sideways
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), mat);
  head.position.set(0.7, 0.25, 0.15);
  head.castShadow = true;
  g.add(head);
  // Arms flopped outward
  const armGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.55, 6);
  const armL = new THREE.Mesh(armGeom, mat);
  armL.rotation.z = Math.PI/2;
  armL.rotation.y = 0.5;
  armL.position.set(-0.15, 0.28, -0.45);
  g.add(armL);
  const armR = new THREE.Mesh(armGeom, mat);
  armR.rotation.z = Math.PI/2;
  armR.rotation.y = -0.5;
  armR.position.set(-0.15, 0.28, 0.45);
  g.add(armR);
  // Legs — bent akimbo
  const legGeom = new THREE.CylinderGeometry(0.09, 0.09, 0.7, 6);
  const legL = new THREE.Mesh(legGeom, mat);
  legL.rotation.z = Math.PI/2;
  legL.rotation.y = 0.25;
  legL.position.set(-0.75, 0.25, -0.15);
  g.add(legL);
  const legR = new THREE.Mesh(legGeom, mat);
  legR.rotation.z = Math.PI/2;
  legR.rotation.y = -0.25;
  legR.position.set(-0.75, 0.25, 0.15);
  g.add(legR);
  g.rotation.y = yaw;
  return g;
}

function spawnCorpse(playerId, pos, yaw, color, name) {
  // Remove any prior corpse for same player on this level
  removeCorpse(playerId);
  const mesh = buildCorpseMesh(color, yaw);
  mesh.position.set(pos[0], 0, pos[2]);
  mesh.userData = { type: 'corpse', playerId, name };
  levelGroup.add(mesh);
  STATE.corpses.push({ playerId, pos: pos.slice(), yaw, color, name, mesh });
}

function removeCorpse(playerId) {
  const idx = STATE.corpses.findIndex(c => c.playerId === playerId);
  if (idx >= 0) {
    const c = STATE.corpses[idx];
    if (c.mesh) levelGroup.remove(c.mesh);
    STATE.corpses.splice(idx, 1);
  }
}

function clearAllCorpses() {
  for (const c of STATE.corpses) if (c.mesh) levelGroup.remove(c.mesh);
  STATE.corpses = [];
}

function applyMimicVisual(m) {
  // Replace monster mesh with a player-like capsule using the stored mimic color
  if (!m || !m.mimicColor) return;
  if (m.mesh) levelGroup.remove(m.mesh);
  const g = new THREE.Group();
  const color = new THREE.Color(m.mimicColor);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 8), mat);
  body.position.y = 0.85; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), mat);
  head.position.y = 1.6; head.castShadow = true; g.add(head);
  g.userData.isMimic = true;
  g.userData.mimicName = m.mimicName;
  g.position.set(m.pos[0], 0, m.pos[2]);
  levelGroup.add(g);
  m.mesh = g;
}

function spawnMonster(type, x, z, opts={}) {
  const def = MONSTER_DEFS[type];
  if (!def) { console.warn('[trapped] Unknown monster type:', type); return null; }
  const group = def.build();
  group.position.set(x, 0, z);
  levelGroup.add(group);
  const m = {
    id: `mon_${STATE.monsters.length}_${Math.random().toString(36).slice(2,6)}`,
    type,
    pos: [x, 0, z],
    vel: [0, 0, 0],
    yaw: Math.random()*Math.PI*2,
    hp: def.hp,
    maxHp: def.hp,
    targetId: null,
    state: 'idle',   // idle | patrol | chase | attack | stunned | dormant
    stateT: 0,
    attackT: 0,
    mesh: group,
    def,
    mimicColor: null,
    mimicName: null,
    ownerId: opts.ownerId || null,
    lastDamageT: 0,
  };
  STATE.monsters.push(m);
  return m;
}

// ------------------------------------------------------------------
// PLAYER SETUP
// ------------------------------------------------------------------
function newPlayerState(id, name) {
  return {
    id,
    name: name || 'player',
    pos: [0, 0, 0],
    renderPos: [0, 0, 0],
    vy: 0,
    grounded: true,
    yaw: 0,
    pitch: 0,
    hp: 100, maxHp: 100,
    stam: 100, maxStam: 100,
    flashOn: false, flashBattery: 100, battReserve: 0,
    crouching: false, sprinting: false,
    color: '#' + (incomingParams.color || 'dd3333'),
    items: [{ type: 'flashlight' }, null, null, null, null],
    selectedSlot: 0,
    maxSlots: 5,
    buffs: [], debuffs: [],
    alive: true,
    finishedLevel: false,
    inSafeRoom: false,
    trappedUntil: 0,           // bear trap immobilization
    speedMul: 1, regen: 0, armor: 0,
    silent: false, xrayMonsters: false, nightVision: false, crouchFull: false,
    infBattery: false, flareAura: false, seesFakeExits: false, battDrainMul: 1, bleed: 0,
    deathMsg: null,
    level: STATE.level,
  };
}

const me = newPlayerState(STATE.myId, STATE.username);
STATE.players.set(STATE.myId, me);

// ------------------------------------------------------------------
// CONTROLS
// ------------------------------------------------------------------
const keys = {};
let mouseLocked = false;
let clickCooldown = 0;
canvas.addEventListener('click', () => {
  if (STATE.phase === 'playing') canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  mouseLocked = document.pointerLockElement === canvas;
});
addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  // Escape toggles pause menu mid-game, or closes any in-game overlay back to the HUD
  if (e.key === 'Escape') {
    if (STATE.phase === 'playing') {
      if (!pauseEl.classList.contains('hidden')) {
        resumeGame();
      } else if (!settingsEl.classList.contains('hidden') || !howtoEl.classList.contains('hidden')) {
        showScreen('pause');
      } else if (!choiceEl.classList.contains('hidden') || !deathEl.classList.contains('hidden')) {
        // Don't allow pausing over choice/death screens
      } else {
        openPause();
      }
      e.preventDefault();
      return;
    }
  }
  if (STATE.phase !== 'playing') return;
  // Ignore gameplay keys while any overlay is showing
  if (!pauseEl.classList.contains('hidden') || !settingsEl.classList.contains('hidden') ||
      !howtoEl.classList.contains('hidden') || !choiceEl.classList.contains('hidden') ||
      !deathEl.classList.contains('hidden')) return;
  const n = parseInt(e.key);
  if (n >= 1 && n <= 5) selectSlot(n-1);
  if (e.key.toLowerCase() === 'f') toggleFlashlight();
  if (e.key.toLowerCase() === 'z') dropSelected();
  if (e.key.toLowerCase() === 'e') interact();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('wheel', e => {
  if (STATE.phase !== 'playing') return;
  const dir = Math.sign(e.deltaY);
  const slots = me.maxSlots;
  let s = me.selectedSlot + dir;
  if (s < 0) s = slots-1;
  if (s >= slots) s = 0;
  selectSlot(s);
});
addEventListener('mousemove', e => {
  if (!mouseLocked) return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch -= e.movementY * 0.0022;
  me.pitch = Math.max(-Math.PI/2 + 0.05, Math.min(Math.PI/2 - 0.05, me.pitch));
});
addEventListener('mousedown', e => {
  if (STATE.phase !== 'playing' || !mouseLocked) return;
  if (e.button === 0) useSelected();
});

// ------------------------------------------------------------------
// COLLISION
// ------------------------------------------------------------------
// BFS shortest path through maze cells. Returns [[cx,cy], ...] from start to
// target inclusive, or null if unreachable. Respects each cell's walls (including
// walls that carveRooms opened and wall-restoration re-closed).
function bfsPath(cells, sx, sy, tx, ty) {
  if (!cells) return null;
  const h = cells.length, w = cells[0].length;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return null;
  if (sx === tx && sy === ty) return [[sx, sy]];
  const seen = Array.from({length: h}, () => new Array(w).fill(false));
  const prev = Array.from({length: h}, () => new Array(w).fill(null));
  seen[sy][sx] = true;
  const q = [[sx, sy]];
  let head = 0;
  while (head < q.length) {
    const [x, y] = q[head++];
    const c = cells[y][x];
    const neigh = [
      [!c.walls.N, x, y - 1],
      [!c.walls.E, x + 1, y],
      [!c.walls.S, x, y + 1],
      [!c.walls.W, x - 1, y],
    ];
    for (const [open, nx, ny] of neigh) {
      if (!open) continue;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (seen[ny][nx]) continue;
      seen[ny][nx] = true;
      prev[ny][nx] = [x, y];
      if (nx === tx && ny === ty) {
        const path = [[nx, ny]];
        let cur = [x, y];
        while (cur) { path.unshift(cur); cur = prev[cur[1]][cur[0]]; }
        return path;
      }
      q.push([nx, ny]);
    }
  }
  return null;
}

// Pick a cell neighbor to wander toward, preferring not to double back. Mutates
// m.targetCellX/Y/prevDir. Returns true if a new target was set.
function pickWanderCell(m) {
  const cells = STATE.levelMeta?.cells;
  if (!cells) return false;
  const cx = Math.round(m.pos[0] / TILE);
  const cy = Math.round(m.pos[2] / TILE);
  if (cy < 0 || cy >= cells.length || cx < 0 || cx >= cells[0].length) return false;
  const cell = cells[cy][cx];
  const dirs = [];
  if (!cell.walls.N) dirs.push([0, -1]);
  if (!cell.walls.E) dirs.push([1,  0]);
  if (!cell.walls.S) dirs.push([0,  1]);
  if (!cell.walls.W) dirs.push([-1, 0]);
  if (!dirs.length) { m.targetCellX = null; return false; }
  // If there are multiple options, avoid reversing the previous step
  if (dirs.length > 1 && m.prevDir) {
    const filt = dirs.filter(d => !(d[0] === -m.prevDir[0] && d[1] === -m.prevDir[1]));
    if (filt.length) { dirs.length = 0; dirs.push(...filt); }
  }
  const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
  m.targetCellX = cx + dx;
  m.targetCellY = cy + dy;
  m.prevDir = [dx, dy];
  return true;
}

// Line-of-sight check between two 2D points (X-Z plane). Returns true if no wall
// AABB blocks the segment, false if any wall intersects it.
function hasLineOfSight(x1, z1, x2, z2) {
  const aabbs = STATE.levelMeta?.wallAABBs;
  if (!aabbs) return true;
  const dx = x2 - x1, dz = z2 - z1;
  for (const b of aabbs) {
    let tmin = 0, tmax = 1;
    if (dx !== 0) {
      const tx1 = (b.minX - x1) / dx;
      const tx2 = (b.maxX - x1) / dx;
      tmin = Math.max(tmin, Math.min(tx1, tx2));
      tmax = Math.min(tmax, Math.max(tx1, tx2));
    } else if (x1 < b.minX || x1 > b.maxX) {
      continue;
    }
    if (dz !== 0) {
      const tz1 = (b.minZ - z1) / dz;
      const tz2 = (b.maxZ - z1) / dz;
      tmin = Math.max(tmin, Math.min(tz1, tz2));
      tmax = Math.min(tmax, Math.max(tz1, tz2));
    } else if (z1 < b.minZ || z1 > b.maxZ) {
      continue;
    }
    if (tmax >= tmin && tmax >= 0 && tmin <= 1) return false;
  }
  return true;
}

function collidePoint(x, z, radius=0.28) {
  if (!STATE.levelMeta) return { x, z };
  const aabbs = STATE.levelMeta.wallAABBs;
  let nx = x, nz = z;
  for (const b of aabbs) {
    const cx = Math.max(b.minX, Math.min(nx, b.maxX));
    const cz = Math.max(b.minZ, Math.min(nz, b.maxZ));
    const dx = nx - cx, dz = nz - cz;
    const d2 = dx*dx + dz*dz;
    if (d2 < radius*radius) {
      const d = Math.sqrt(d2) || 0.0001;
      const push = (radius - d);
      nx += (dx/d)*push;
      nz += (dz/d)*push;
    }
  }
  return { x: nx, z: nz };
}

// ------------------------------------------------------------------
// INVENTORY
// ------------------------------------------------------------------
function selectSlot(i) {
  if (i < 0 || i >= me.maxSlots) return;
  me.selectedSlot = i;
  renderInventory();
}
function addItem(type, extra={}) {
  // Special: battery logic
  if (type === 'battery') {
    const maxRes = me.maxReserve || 3;
    if (me.flashBattery >= 100) {
      me.battReserve = Math.min(maxRes, me.battReserve + (me.battBonus ? 2 : 1));
      popup('Battery stored (reserve ' + me.battReserve + '/' + maxRes + ')');
    } else {
      me.flashBattery = 100;
      popup('Battery — flashlight fully charged');
      if (me.battBonus) { me.battReserve = Math.min(maxRes, me.battReserve + 1); }
    }
    return true;
  }
  for (let i=0;i<me.maxSlots;i++) {
    if (!me.items[i]) {
      me.items[i] = { type, ...extra };
      renderInventory();
      return true;
    }
  }
  popup('Inventory full');
  return false;
}
function dropSelected() {
  const slot = me.selectedSlot;
  const it = me.items[slot];
  if (!it || it.type === 'flashlight') { popup("Can't drop flashlight"); return; }
  // Spawn pickup at player
  const dropId = 'drop_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
  const pk = {
    id: dropId,
    type: it.type,
    pos: [me.pos[0], 0.6, me.pos[2] + 0.4],
    mesh: spawnPickupMesh(it.type, me.pos[0], me.pos[2]),
    taken: false,
    dropped: true,
  };
  STATE.pickups.push(pk);
  me.items[slot] = null;
  renderInventory();
  popup('Dropped ' + itemMeta(it.type).name);
  // Tell others
  sendEvent && sendEvent({ type: 'drop', pickup: { id: pk.id, itemType: pk.type, pos: pk.pos } });
}
function useSelected() {
  const it = me.items[me.selectedSlot];
  if (!it) return;
  const meta = itemMeta(it.type);
  if (it.type === 'flashlight') { toggleFlashlight(); return; }
  if (it.type === 'battery') {
    // Shouldn't be in slot normally, but if forced
    if (me.flashBattery < 100) { me.flashBattery = 100; me.items[me.selectedSlot] = null; }
    return;
  }
  if (it.type === 'medpack') {
    if (me.hp >= me.maxHp) { popup("HP already full"); return; }
    const heal = 60 + (me.medBonus||0);
    me.hp = Math.min(me.maxHp, me.hp + heal);
    me.items[me.selectedSlot] = null;
    popup('Healed +' + heal + ' HP');
    audio.heal();
  } else if (it.type === 'flare') {
    useFlare();
    me.items[me.selectedSlot] = null;
  } else if (it.type === 'teltx') {
    useTeleport();
    me.items[me.selectedSlot] = null;
  } else if (it.type === 'mirror') {
    useMirror();
    // mirror persists, a one-use could be toggled — keep as multi-use small stun
  } else if (it.type === 'smoke') {
    useSmoke();
    me.items[me.selectedSlot] = null;
  } else if (it.type === 'repellent') {
    me.repellentT = 20;
    me.items[me.selectedSlot] = null;
    popup('Repellent active — 20s');
  } else if (it.type === 'dagger') {
    useDagger();
  } else if (it.type === 'key') {
    popup('Use it on the exit door');
  }
  renderInventory();
}

function toggleFlashlight() {
  me.flashOn = !me.flashOn;
  if (me.flashOn && me.flashBattery <= 0 && !me.infBattery) {
    me.flashOn = false;
    popup('Battery dead');
  }
  const intensity = me.flashPower ? 20 : 12;
  flashlight.intensity = me.flashOn ? intensity : 0;
  flashlight.distance = me.flashPower ? 32 : 24;
  audio.flashlight();
}

function renderInventory() {
  const invEl = $('inventory');
  invEl.innerHTML = '';
  for (let i=0;i<me.maxSlots;i++) {
    const slot = document.createElement('div');
    slot.className = 'inv-slot' + (i===me.selectedSlot ? ' selected' : '');
    const num = document.createElement('div'); num.className = 'slot-num'; num.textContent = (i+1);
    slot.appendChild(num);
    const it = me.items[i];
    if (it) {
      const meta = itemMeta(it.type);
      const icon = document.createElement('div');
      icon.textContent = meta.icon;
      slot.appendChild(icon);
      const nm = document.createElement('div'); nm.className='slot-name'; nm.textContent = meta.name;
      slot.appendChild(nm);
    }
    if (i === 0 && me.battReserve > 0) {
      const ex = document.createElement('div'); ex.className = 'slot-extra';
      ex.textContent = 'R:' + me.battReserve;
      slot.appendChild(ex);
    }
    invEl.appendChild(slot);
  }
  // Key icon
  $('keyIcon').classList.toggle('hidden', STATE.keyHolderId !== STATE.myId);
}

// ------------------------------------------------------------------
// INTERACTIONS
// ------------------------------------------------------------------
function interact() {
  const reachMul = me.scavenger ? 2 : 1;
  const doorReach = 4.0 * reachMul;
  const pickReach = 2.0 * reachMul;
  // 1) try exit door
  if (STATE.levelMeta?.door) {
    const d = STATE.levelMeta.door;
    const dx = me.pos[0] - d.position.x, dz = me.pos[2] - d.position.z;
    if (dx*dx + dz*dz < doorReach) {
      if (STATE.exitOpen) {
        openExitAndEnterSafeRoom();
        return;
      } else if (STATE.keyHolderId === STATE.myId) {
        STATE.exitOpen = true;
        popup('Exit opened — hurry!');
        audio.doorOpen();
        audio.fanfare();
        sendEvent && sendEvent({ type: 'exitOpen', openedBy: STATE.myId });
        openExitAndEnterSafeRoom();
        return;
      } else {
        popup('Locked. Find the key.');
        return;
      }
    }
  }
  // 2) pickups
  for (const p of STATE.pickups) {
    if (p.taken) continue;
    const dx = me.pos[0]-p.pos[0], dz = me.pos[2]-p.pos[2];
    if (dx*dx + dz*dz < pickReach) {
      takePickup(p);
      return;
    }
  }
}

function takePickup(p) {
  if (p.type === 'key') {
    STATE.keyHolderId = STATE.myId;
    popup('Picked up KEY');
    audio.keyPickup();
    sendEvent && sendEvent({ type: 'keyTaken', by: STATE.myId });
  } else {
    if (!addItem(p.type)) return;
    audio.pickup();
  }
  p.taken = true;
  if (p.mesh) levelGroup.remove(p.mesh);
  sendEvent && sendEvent({ type: 'pickupTaken', id: p.id, by: STATE.myId });
  renderInventory();
}

// ------------------------------------------------------------------
// FLARE / TELEPORT / MIRROR / SMOKE / DAGGER
// ------------------------------------------------------------------
const flares = [];   // { pos, t, light, mesh }
const smokes = [];   // { pos, t, mesh }
function useFlare() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const start = [me.pos[0], 1.3, me.pos[2]];
  const vel = [dir.x*8, 3.5, dir.z*8];
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5030 }));
  m.position.set(...start);
  levelGroup.add(m);
  const light = new THREE.PointLight(0xff8050, 8, 18, 1.5);
  m.add(light);
  flares.push({ pos: start.slice(), vel, t: 30, mesh: m, light, launched: true, landed: false });
  popup('Flare fired');
  audio.flare();
  sendEvent && sendEvent({ type: 'flare', pos: start, vel });
}
function useTeleport() {
  const size = STATE.levelMeta.size;
  const rng = Math.random;
  const cx = Math.floor(rng()*size), cy = Math.floor(rng()*size);
  const wp = cellToWorld(cx, cy);
  me.pos[0] = wp.x; me.pos[2] = wp.z;
  popup('Teleported!');
  audio.teleport();
}
function useMirror() {
  // Stun statues within view
  let stunned = 0;
  for (const m of STATE.monsters) {
    if (m.def.special === 'statue') {
      const dx = m.pos[0]-me.pos[0], dz = m.pos[2]-me.pos[2];
      if (dx*dx + dz*dz < 100) {
        m.state = 'stunned'; m.stateT = 4;
        stunned++;
      }
    }
  }
  popup(stunned ? `Mirror stunned ${stunned}` : 'Mirror flashed');
}
function useSmoke() {
  const pos = [me.pos[0], 0.5, me.pos[2]];
  const m = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.55 }));
  m.position.set(...pos);
  levelGroup.add(m);
  smokes.push({ pos, t: 10, mesh: m });
  popup('Smoke bomb');
  audio.smoke();
  sendEvent && sendEvent({ type: 'smoke', pos });
}
function useDagger() {
  if (me.weakGrip) { popup('Weak grip — can\'t hold dagger'); return; }
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  for (const m of STATE.monsters) {
    const dx = m.pos[0]-me.pos[0], dz = m.pos[2]-me.pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist > 1.6) continue;
    const ang = Math.atan2(dx, dz);
    const facing = Math.atan2(dir.x, dir.z);
    const diff = Math.abs(((ang - facing + Math.PI*3) % (Math.PI*2)) - Math.PI);
    if (diff > 1.0) continue;
    damageMonster(m, 35);
    popup('Stab!');
    audio.dagger();
    if (me.lifesteal && m.hp <= 0) { me.hp = Math.min(me.maxHp, me.hp + me.lifesteal); }
    return;
  }
  popup('Dagger slashes air');
  audio.dagger();
}

function damageMonster(m, dmg) {
  if (!STATE.isHost) {
    sendEvent && sendEvent({ type: 'hurtMon', id: m.id, dmg });
    return;
  }
  m.hp -= dmg;
  m.lastDamageT = performance.now();
  // Hivemind: on hit, spawn a crawler nearby
  if (m.def.special === 'hivemind' && m.hp > 0 && Math.random() < 0.35) {
    spawnMonster('crawler', m.pos[0] + (Math.random()-0.5)*2, m.pos[2] + (Math.random()-0.5)*2);
  }
  if (m.hp <= 0) {
    // Bloater death: AoE damage
    if (m.def.special === 'bloater') {
      for (const p of STATE.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.pos[0]-m.pos[0], p.pos[2]-m.pos[2]);
        if (d < 3) broadcastPlayerDamage(p, 30 - d*6, 'Bloater burst');
      }
      // visual burst
      const burst = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.6 }));
      burst.position.set(m.pos[0], 1.2, m.pos[2]);
      levelGroup.add(burst);
      setTimeout(()=>levelGroup.remove(burst), 500);
    }
    // Carrier: drop a medpack
    if (m.def.special === 'carrier') {
      const id = 'drop_carrier_' + m.id;
      const pk = {
        id, type: 'medpack',
        pos: [m.pos[0], 0.5, m.pos[2]],
        mesh: spawnPickupMesh('medpack', m.pos[0], m.pos[2]),
        taken: false, dropped: true,
      };
      STATE.pickups.push(pk);
      sendEvent && sendEvent({ type: 'drop', pickup: { id, itemType: 'medpack', pos: pk.pos } });
    }
    levelGroup.remove(m.mesh);
    STATE.monsters = STATE.monsters.filter(x => x !== m);
  }
}

// ------------------------------------------------------------------
// POPUPS
// ------------------------------------------------------------------
let popupT = 0;
function popup(msg, ms=2200) {
  const el = $('popup');
  el.textContent = msg;
  el.classList.add('show');
  popupT = ms/1000;
}

// ------------------------------------------------------------------
// SAFE ROOM
// ------------------------------------------------------------------
const safeRoomGroup = new THREE.Group();
scene.add(safeRoomGroup);

function buildSafeRoom() {
  // Dispose old
  while (safeRoomGroup.children.length) {
    const c = safeRoomGroup.children.pop();
    c.geometry?.dispose?.();
  }
  const s = 8;
  const offset = { x: -1000, z: -1000 };
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a1818, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2020, roughness: 0.85 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x1a1010, roughness: 1.0 });
  const f = new THREE.Mesh(new THREE.PlaneGeometry(s, s), floorMat);
  f.rotation.x = -Math.PI/2;
  f.position.set(offset.x, 0, offset.z);
  safeRoomGroup.add(f);
  const c = new THREE.Mesh(new THREE.PlaneGeometry(s, s), ceilMat);
  c.rotation.x = Math.PI/2;
  c.position.set(offset.x, 4, offset.z);
  safeRoomGroup.add(c);
  for (let i=0;i<4;i++){
    const w = new THREE.Mesh(new THREE.BoxGeometry(s, 4, 0.2), wallMat);
    if (i===0) { w.position.set(offset.x, 2, offset.z - s/2); }
    if (i===1) { w.position.set(offset.x, 2, offset.z + s/2); }
    if (i===2) { w.rotation.y = Math.PI/2; w.position.set(offset.x - s/2, 2, offset.z); }
    if (i===3) { w.rotation.y = Math.PI/2; w.position.set(offset.x + s/2, 2, offset.z); }
    safeRoomGroup.add(w);
  }
  // Warm light
  const light = new THREE.PointLight(0xffa060, 2.5, 12, 1.5);
  light.position.set(offset.x, 3.2, offset.z);
  safeRoomGroup.add(light);
  // Descend door (hidden until all players ready)
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x2a1a3a, emissive: 0x6020c0, emissiveIntensity: 0, roughness: 0.5,
  });
  const doorGeom = new THREE.BoxGeometry(2.2, 3.2, 0.3);
  const descDoor = new THREE.Mesh(doorGeom, doorMat);
  descDoor.position.set(offset.x, 1.6, offset.z + s/2 - 0.15);
  descDoor.visible = false;
  descDoor.userData = { type: 'descendDoor' };
  safeRoomGroup.add(descDoor);
  // Portal ring visual
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.08, 10, 32),
    new THREE.MeshBasicMaterial({ color: 0xa040ff }));
  ring.position.set(offset.x, 1.6, offset.z + s/2 - 0.3);
  ring.visible = false;
  safeRoomGroup.add(ring);
  const doorLight = new THREE.PointLight(0xa040ff, 0, 6);
  doorLight.position.set(offset.x, 1.6, offset.z + s/2 - 1.0);
  safeRoomGroup.add(doorLight);
  safeRoomGroup.userData.center = new THREE.Vector3(offset.x, 0, offset.z);
  safeRoomGroup.userData.size = s;
  safeRoomGroup.userData.descendDoor = descDoor;
  safeRoomGroup.userData.descendRing = ring;
  safeRoomGroup.userData.descendLight = doorLight;
}
buildSafeRoom();

function openExitAndEnterSafeRoom() {
  // Teleport player to safe room
  const center = safeRoomGroup.userData.center;
  me.pos[0] = center.x;
  me.pos[2] = center.z + 2.5;
  me.inSafeRoom = true;
  me.finishedLevel = true;
  popup('Safe Room — pick a reward', 3500);

  // First-to-exit gets better pool
  const rankedOrder = [...STATE.players.values()].filter(p => p.finishedLevel).length;
  const isFirst = rankedOrder === 1;
  showChoice(isFirst);

  sendEvent && sendEvent({ type: 'exited', id: STATE.myId });
  if (STATE.keyHolderId === STATE.myId) STATE.keyHolderId = null;
}

// ------------------------------------------------------------------
// CHOICE OVERLAY
// ------------------------------------------------------------------
function showChoice(isFirst) {
  const rng = Math.random;
  const options = [];
  const pool = [];

  // Populate pool based on tier
  for (const b of BUFFS) pool.push({ kind: 'buff', id: b.id, data: b });
  // Items
  const itemPool = ['medpack','flare','teltx','mirror','smoke','repellent','dagger'];
  for (const it of itemPool) pool.push({ kind: 'item', id: it });
  // Cure
  pool.push({ kind: 'cure' });

  // Pick 3 unique
  const chosen = [];
  const poolCopy = pool.slice();
  while (chosen.length < 3 && poolCopy.length) {
    const idx = Math.floor(rng()*poolCopy.length);
    chosen.push(poolCopy.splice(idx, 1)[0]);
  }

  $('choiceTitle').textContent = isFirst ? 'First Escape — Grand Reward' : 'Lesser Rewards';
  $('choiceSubtitle').textContent = isFirst
    ? 'Pick one. No downsides.'
    : 'Pick one. Some have a catch.';

  const grid = $('choiceOptions');
  grid.innerHTML = '';
  for (const opt of chosen) {
    const card = document.createElement('div');
    card.className = 'choice-card';
    let title='', tag='buff', desc='', downside=null;
    if (opt.kind === 'buff') {
      title = opt.data.name;
      tag = 'buff';
      desc = 'A lasting boon.';
      if (!isFirst && Math.random() < 0.55) {
        const d = DEBUFFS[Math.floor(Math.random()*DEBUFFS.length)];
        downside = d;
      }
    } else if (opt.kind === 'item') {
      const meta = itemMeta(opt.id);
      title = meta.name + ' (Item)';
      tag = 'item';
      desc = meta.description;
      if (!isFirst && Math.random() < 0.4) {
        const d = DEBUFFS[Math.floor(Math.random()*DEBUFFS.length)];
        downside = d;
      }
    } else if (opt.kind === 'cure') {
      title = 'Cleanse Debuff';
      tag = 'cure';
      desc = (me.debuffs.length === 0) ? '(nothing to cleanse)' : 'Remove a random debuff from yourself.';
    }

    card.innerHTML = `<span class="tag ${tag}">${tag.toUpperCase()}</span>
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(desc)}</p>
      ${downside ? `<div class="downside">⚠ Downside: ${escapeHtml(downside.name)}</div>` : ''}`;
    card.onclick = () => {
      applyChoice(opt, downside);
      choiceEl.classList.add('hidden');
      showScreen('hud');
    };
    grid.appendChild(card);
  }

  showScreen('choice');
}

function applyChoice(opt, downside) {
  if (opt.kind === 'buff') {
    if (!me.buffs.includes(opt.id)) me.buffs.push(opt.id);
  } else if (opt.kind === 'item') {
    addItem(opt.id);
  } else if (opt.kind === 'cure') {
    if (me.debuffs.length) {
      const idx = Math.floor(Math.random()*me.debuffs.length);
      me.debuffs.splice(idx, 1);
    }
  }
  if (downside) {
    if (!me.debuffs.includes(downside.id)) me.debuffs.push(downside.id);
  }
  recomputeStats(me);
  renderInventory();
  STATE.chosenThisLevel.add(STATE.myId);
  sendEvent && sendEvent({ type: 'choseReward', id: STATE.myId });
  maybeAdvanceLevelCheck();
}

// ------------------------------------------------------------------
// LEVEL ADVANCE (host only)
// ------------------------------------------------------------------
function maybeAdvanceLevelCheck() {
  // When all alive players have finished AND chosen their reward, OPEN the descend door.
  // Actual advance happens when a player walks through the door.
  if (!STATE.isHost) return;
  const alive = [...STATE.players.values()].filter(p => p.alive);
  if (!alive.length) {
    endGame();
    return;
  }
  const allDone = alive.every(p => p.finishedLevel && STATE.chosenThisLevel.has(p.id));
  if (allDone && !STATE.safeRoomOpen) {
    openDescendDoor();
  }
}

function openDescendDoor() {
  STATE.safeRoomOpen = true;
  const d = safeRoomGroup.userData.descendDoor;
  const r = safeRoomGroup.userData.descendRing;
  const l = safeRoomGroup.userData.descendLight;
  if (d) d.visible = true;
  if (r) r.visible = true;
  if (l) l.intensity = 2.5;
  popup('The way down is open — walk through', 4000);
  audio.doorOpen();
  audio.sting();
  sendEvent && sendEvent({ type: 'descendOpen' });
}

function closeDescendDoor() {
  STATE.safeRoomOpen = false;
  const d = safeRoomGroup.userData.descendDoor;
  const r = safeRoomGroup.userData.descendRing;
  const l = safeRoomGroup.userData.descendLight;
  if (d) d.visible = false;
  if (r) r.visible = false;
  if (l) l.intensity = 0;
}

function advanceLevel() {
  STATE.level++;
  // Add dead players to deadPlayerIds set (for next level)
  for (const [id, p] of STATE.players) if (!p.alive) STATE.deadPlayerIds.add(id);
  const newSeed = (STATE.seed + STATE.level*31) >>> 0;
  // Broadcast
  sendEvent && sendEvent({ type: 'advance', level: STATE.level, seed: newSeed, deadIds: [...STATE.deadPlayerIds] });
  loadLevel(STATE.level, newSeed);
}

function loadLevel(level, seed) {
  STATE.level = level;
  STATE.seed = seed;
  me.finishedLevel = false;
  me.inSafeRoom = false;
  me.level = level;
  me.spectator = false;  // dead players become monsters, no longer spectating
  closeDescendDoor();
  buildLevel();
  // Spawn at start cell, face whichever direction is open
  const sp = cellToWorld(0, 0);
  me.pos[0] = sp.x; me.pos[2] = sp.z;
  const startCell = STATE.levelMeta.cells[0][0];
  // yaw: 0 -> -Z, PI/2 -> -X, PI -> +Z, -PI/2 -> +X
  if (!startCell.walls.S) me.yaw = Math.PI;       // face +Z
  else if (!startCell.walls.E) me.yaw = -Math.PI/2; // face +X
  else if (!startCell.walls.N) me.yaw = 0;         // face -Z
  else if (!startCell.walls.W) me.yaw = Math.PI/2; // face -X
  me.pitch = 0;
  me.flashOn = true;
  recomputeStats(me);
  flashlight.intensity = me.flashPower ? 20 : 12;
  flashlight.distance = me.flashPower ? 32 : 24;
  $('levelIndicator').textContent = `Level ${level} — ${STATE.levelMeta.theme.name}`;
}

// ------------------------------------------------------------------
// START GAME
// ------------------------------------------------------------------
function startGame(seed) {
  STATE.phase = 'playing';
  STATE.level = 1;
  STATE.seed = seed;
  STATE.deadPlayerIds = new Set();
  STATE.chosenThisLevel.clear();
  Object.assign(me, newPlayerState(STATE.myId, STATE.username));
  electHost();
  loadLevel(1, seed);
  showScreen('hud');
  renderInventory();
  canvas.requestPointerLock?.();
  // First-play tutorial
  if (!localStorage.getItem('trapped.seenTutorial')) {
    $('tutorial').classList.remove('hidden');
    const dismiss = () => {
      $('tutorial').classList.add('hidden');
      localStorage.setItem('trapped.seenTutorial', '1');
      $('tutorial').removeEventListener('click', dismiss);
    };
    $('tutorial').addEventListener('click', dismiss);
  }
}

function endGame() {
  STATE.phase = 'end';
  audio.stopAmbient();
  recordLeaderboard(STATE.username, STATE.level);
  $('endInfo').textContent = `Deepest level reached: ${STATE.level}`;
  showScreen('end');
}

// ------------------------------------------------------------------
// HOST WORLD SNAPSHOT
// ------------------------------------------------------------------
function hostSnapshot() {
  return {
    tick: STATE.tickCount,
    level: STATE.level,
    seed: STATE.seed,
    exitOpen: STATE.exitOpen,
    keyHolderId: STATE.keyHolderId,
    monsters: STATE.monsters.map(m => ({
      id: m.id, type: m.type, pos: m.pos.slice(), yaw: m.yaw, hp: m.hp,
      state: m.state, mimicColor: m.mimicColor, mimicName: m.mimicName,
    })),
    pickupsTaken: STATE.pickups.filter(p => p.taken).map(p => p.id),
  };
}

function applyWorldSnapshot(data) {
  if (!data) return;
  if (data.level !== STATE.level) return; // wait for level sync
  STATE.exitOpen = data.exitOpen;
  STATE.keyHolderId = data.keyHolderId;
  // Monsters: sync by id
  const byId = new Map(STATE.monsters.map(m => [m.id, m]));
  const seen = new Set();
  for (const md of data.monsters || []) {
    seen.add(md.id);
    let m = byId.get(md.id);
    if (!m) {
      const def = MONSTER_DEFS[md.type];
      if (!def) continue;
      const group = def.build();
      group.position.set(md.pos[0], 0, md.pos[2]);
      levelGroup.add(group);
      m = { id: md.id, type: md.type, pos: md.pos.slice(), yaw: md.yaw, hp: md.hp, state: md.state, mesh: group, def };
      STATE.monsters.push(m);
    }
    m.pos[0] = md.pos[0]; m.pos[2] = md.pos[2]; m.yaw = md.yaw; m.hp = md.hp; m.state = md.state;
    m.mesh.position.set(md.pos[0], 0, md.pos[2]);
    m.mesh.rotation.y = md.yaw;
  }
  // Remove killed monsters
  STATE.monsters = STATE.monsters.filter(m => {
    if (seen.has(m.id)) return true;
    levelGroup.remove(m.mesh);
    return false;
  });
  // Pickups taken
  for (const id of data.pickupsTaken || []) {
    const p = STATE.pickups.find(x => x.id === id);
    if (p && !p.taken) { p.taken = true; if (p.mesh) levelGroup.remove(p.mesh); }
  }
}

// ------------------------------------------------------------------
// REMOTE EVENTS
// ------------------------------------------------------------------
function handleRemoteEvent(data, fromId) {
  if (!data) return;
  if (data.type === 'start') {
    startGame(data.seed);
  } else if (data.type === 'advance') {
    STATE.deadPlayerIds = new Set(data.deadIds || []);
    loadLevel(data.level, data.seed);
  } else if (data.type === 'keyTaken') {
    STATE.keyHolderId = data.by;
    const p = STATE.pickups.find(x => x.type === 'key' && !x.taken);
    if (p) { p.taken = true; if (p.mesh) levelGroup.remove(p.mesh); }
  } else if (data.type === 'pickupTaken') {
    const p = STATE.pickups.find(x => x.id === data.id);
    if (p && !p.taken) { p.taken = true; if (p.mesh) levelGroup.remove(p.mesh); }
  } else if (data.type === 'exitOpen') {
    STATE.exitOpen = true;
    popup('Exit opened!');
    audio.doorOpen();
    audio.fanfare();
  } else if (data.type === 'exited') {
    const pl = STATE.players.get(data.id);
    if (pl) pl.finishedLevel = true;
  } else if (data.type === 'choseReward') {
    STATE.chosenThisLevel.add(data.id);
    if (STATE.isHost) maybeAdvanceLevelCheck();
  } else if (data.type === 'descendOpen') {
    STATE.safeRoomOpen = true;
    const d = safeRoomGroup.userData.descendDoor;
    const r = safeRoomGroup.userData.descendRing;
    const l = safeRoomGroup.userData.descendLight;
    if (d) d.visible = true;
    if (r) r.visible = true;
    if (l) l.intensity = 2.5;
    popup('The way down is open', 3500);
    audio.doorOpen();
  } else if (data.type === 'reqAdvance') {
    if (STATE.isHost) advanceLevel();
  } else if (data.type === 'roar') {
    // Play monster roar if close to us
    const d = Math.hypot((data.pos?.[0]||0)-me.pos[0], (data.pos?.[2]||0)-me.pos[2]);
    if (d < 15) audio.monsterRoar();
  } else if (data.type === 'hurtMon' && STATE.isHost) {
    const m = STATE.monsters.find(x => x.id === data.id);
    if (m) damageMonster(m, data.dmg);
  } else if (data.type === 'flare') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.15,8,8), new THREE.MeshBasicMaterial({ color: 0xff5030 }));
    m.position.set(...data.pos);
    levelGroup.add(m);
    const l = new THREE.PointLight(0xff8050, 8, 18, 1.5);
    m.add(l);
    flares.push({ pos: data.pos.slice(), vel: data.vel, t: 30, mesh: m, light: l, launched: true, landed: false });
  } else if (data.type === 'smoke') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.55 }));
    m.position.set(...data.pos);
    levelGroup.add(m);
    smokes.push({ pos: data.pos, t: 10, mesh: m });
  } else if (data.type === 'drop') {
    const pk = data.pickup;
    STATE.pickups.push({
      id: pk.id, type: pk.itemType, pos: pk.pos,
      mesh: spawnPickupMesh(pk.itemType, pk.pos[0], pk.pos[2]),
      taken: false, dropped: true,
    });
  } else if (data.type === 'damagePlayer') {
    if (data.id === STATE.myId) takeDamage(data.dmg, data.reason);
  } else if (data.type === 'mimicMorph') {
    const m = STATE.monsters.find(x => x.id === data.id);
    if (m) { m.mimicColor = data.color; m.mimicName = data.name; applyMimicVisual(m); }
  } else if (data.type === 'slowed') {
    if (data.id === STATE.myId) me.slowedUntil = performance.now() + data.duration*1000;
  } else if (data.type === 'trapFx') {
    const t = STATE.traps.find(x => x.id === data.id);
    if (t && data.kind === 'crush') t.crushT = 0.6;
  } else if (data.type === 'bearTrapped') {
    if (data.id === STATE.myId) { me.trappedUntil = performance.now() + 4000; popup('BEAR TRAP — stuck'); }
  } else if (data.type === 'died') {
    const pl = STATE.players.get(data.id);
    if (pl) pl.alive = false;
    if (data.id === STATE.myId) {
      playerDied(data.reason);
    } else if (data.pos) {
      // Remote corpse
      spawnCorpse(data.id, data.pos, data.yaw || 0, data.color || (pl && pl.color) || '#cc4040', data.name || (pl && pl.name));
    }
  }
}

function spawnBloodDrip(dmg) {
  const n = Math.min(4, 1 + Math.floor(dmg/15));
  const host = $('bloodDrips');
  for (let i=0;i<n;i++) {
    const d = document.createElement('div');
    d.className = 'drip';
    d.style.left = (20 + Math.random()*60) + '%';
    d.style.top = (Math.random()*40) + '%';
    d.style.height = (14 + Math.random()*16) + 'px';
    host.appendChild(d);
    setTimeout(()=>d.remove(), 1900);
  }
}

function takeDamage(amt, reason='') {
  if (!me.alive) return;
  if (me.dodge > 0 && Math.random() < me.dodge) {
    popup('Dodged!');
    return;
  }
  const armored = amt * (1 - (me.armor||0));
  me.hp -= armored;
  $('damageVignette').classList.add('hit');
  setTimeout(()=>$('damageVignette').classList.remove('hit'), 220);
  spawnBloodDrip(armored);
  audio.hit();
  if (me.hp <= 0) {
    if (me.deathSave) {
      me.hp = 1;
      me.deathSave = false;
      me.buffs = me.buffs.filter(b => b !== 'deathsave');
      popup('Second chance! HP: 1');
      return;
    }
    playerDied(reason);
  }
}

function playerDied(reason='killed') {
  if (!me.alive) return;  // guard against re-entry
  me.alive = false;
  me.hp = 0;
  me.spectator = true;
  me.specY = 3.0;
  STATE.deadPlayerIds.add(STATE.myId);
  $('deathInfo').textContent = 'Cause: ' + reason;
  showScreen('death');
  document.exitPointerLock?.();
  audio.death();
  // Drop a corpse at the death position
  spawnCorpse(STATE.myId, me.pos.slice(), me.yaw, me.color, me.name);
  sendEvent && sendEvent({ type: 'died', id: STATE.myId, reason, pos: me.pos.slice(), yaw: me.yaw, color: me.color, name: me.name });
  setTimeout(()=>{
    if (STATE.phase !== 'end') {
      showScreen('hud');
      popup('Spectating — move freely, next level you hunt');
      canvas.requestPointerLock?.();
    }
  }, 3500);
}

// ------------------------------------------------------------------
// MONSTER AI (host only)
// ------------------------------------------------------------------
function updateMonstersHost(dt) {
  for (const m of STATE.monsters) {
    const def = m.def;
    // Target: nearest alive player (not ghost owner if dead-player monster)
    let closest = null, closestD = Infinity;
    for (const p of STATE.players.values()) {
      if (!p.alive) continue;
      if (def.special === 'deadplayer' && p.id === m.ownerId) continue; // skip own ghost? allow target though
      const dx = p.pos[0]-m.pos[0], dz = p.pos[2]-m.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < closestD) { closestD = d; closest = p; }
    }

    // State handling by type
    if (m.state === 'stunned') {
      m.stateT -= dt;
      if (m.stateT <= 0) m.state = 'idle';
      continue;
    }

    // Statue: only moves when NOT observed by any alive player
    if (def.special === 'statue') {
      let observed = false;
      for (const p of STATE.players.values()) {
        if (!p.alive) continue;
        if (isInView(p, m.pos, 0.8)) { observed = true; break; }
      }
      if (observed) continue; // freeze completely
    }

    // Shadow: only active in dark — if any flashlight is on and shining on it, stunned
    if (def.special === 'shadow') {
      let lit = false;
      for (const p of STATE.players.values()) {
        if (!p.alive) continue;
        if (p.flashOn && isInFlashlightCone(p, m.pos)) { lit = true; break; }
      }
      if (lit) {
        m.state = 'stunned'; m.stateT = 1.5;
        m.mesh.visible = true;
        m.mesh.traverse(o => { if (o.material) o.material.opacity = 1.0; });
        continue;
      } else {
        // If in darkness (no one has their flashlight nearby illuminating), fade visually
        const tooBrightNear = [...STATE.players.values()].some(p => p.alive && p.flashOn && dist2(p.pos, m.pos) < 4);
        m.mesh.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = tooBrightNear ? 0.6 : 0.05; }});
      }
    }

    // Hunter: gets extra sight range if nearest player is sprinting
    let sight = def.sightRange;
    if (def.special === 'hunter' && closest && closest.sprinting) sight *= 1.6;
    if (closest && closest.loud) sight *= 2.0;
    if (closest && closest.quiet) sight *= 0.6;
    if (closest && closest.silent && closest.crouching) sight *= 0.3;

    // Siren: stationary scream — damages players in radius, doesn't pursue
    if (def.special === 'siren') {
      for (const p of STATE.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.pos[0]-m.pos[0], p.pos[2]-m.pos[2]);
        if (d < 3.5) broadcastPlayerDamage(p, 5*dt*60*0.05, 'Siren wail');
      }
      m.mesh.position.set(m.pos[0], 0, m.pos[2]);
      continue;
    }

    // Gazer: damages any player LOOKING at it
    if (def.special === 'gazer') {
      for (const p of STATE.players.values()) {
        if (!p.alive) continue;
        if (isInView(p, m.pos, 0.8) && dist2(p.pos, m.pos) < def.sightRange*def.sightRange) {
          broadcastPlayerDamage(p, def.damage*dt, 'Gazer stare');
        }
      }
    }

    // Wraith: flashlight damages, dark heals
    if (def.special === 'wraith') {
      let lit = false;
      for (const p of STATE.players.values()) {
        if (p.flashOn && isInFlashlightCone(p, m.pos)) { lit = true; break; }
      }
      if (lit) m.hp = Math.max(0, m.hp - 12*dt);
      else m.hp = Math.min(m.maxHp, m.hp + 2*dt);
      if (m.hp <= 0) {
        levelGroup.remove(m.mesh);
        STATE.monsters = STATE.monsters.filter(x => x !== m);
        continue;
      }
    }

    // Leech: applies slow debuff on hit (handled at attack)
    // Stretcher: large attack range, already set in def
    // Spider: attacks from above — fine via default logic
    // Doppelganger: same as stalker AI
    // Bloater: on death → AoE (handled in damageMonster)
    // Hivemind: on damage spawns crawler (handled in damageMonster)
    // Carrier: drops medpack on death (handled in damageMonster)

    // Basic chase logic
    if (closest && closestD < sight) {
      // Check FOV (unless 360)
      const dxp = closest.pos[0]-m.pos[0], dzp = closest.pos[2]-m.pos[2];
      const angTo = Math.atan2(dxp, dzp);
      const facing = m.yaw;
      const angDiff = Math.abs(((angTo - facing + Math.PI*3) % (Math.PI*2)) - Math.PI);
      const fov = def.sightAngle*Math.PI/180 / 2;
      const inFov = (def.sightAngle >= 360) || angDiff < fov;

      // Crouch stealth
      let detected = inFov;
      if (detected && closest.crouching) {
        if (closestD > def.sightRange*0.35) detected = false;
      }
      if (closest.repellentT > 0) detected = false;
      // Line-of-sight — walls block detection (phantoms ignore walls anyway)
      if (detected && def.special !== 'phantom') {
        if (!hasLineOfSight(m.pos[0], m.pos[2], closest.pos[0], closest.pos[2])) {
          detected = false;
        }
      }

      if (detected) {
        m.state = 'chase';
        m.targetId = closest.id;
      }
    }

    if (m.state === 'chase' && closest) {
      // Track line-of-sight. Lose interest after 5s without seeing them.
      const canSee = (def.special === 'phantom') ||
        hasLineOfSight(m.pos[0], m.pos[2], closest.pos[0], closest.pos[2]);
      if (canSee) {
        m.lostSightT = 0;
        m.lastSeenX = closest.pos[0];
        m.lastSeenZ = closest.pos[2];
      } else {
        m.lostSightT = (m.lostSightT || 0) + dt;
        if (m.lostSightT > 5) {
          m.state = 'idle';
          m.stateT = 1 + Math.random()*2;
          m.targetId = null;
          m.lostSightT = 0;
          m.path = null;
          m.targetCellX = null;
          continue;
        }
      }
      // Pick a goal: direct to player when we see them, else toward last-seen cell.
      let goalX, goalZ;
      if (canSee || def.special === 'phantom') {
        goalX = closest.pos[0];
        goalZ = closest.pos[2];
        m.path = null;
      } else {
        // BFS path through cells. Recompute periodically or when we arrive at a waypoint.
        const cells = STATE.levelMeta?.cells;
        m.pathRecomputeT = (m.pathRecomputeT || 0) - dt;
        const mcx = Math.round(m.pos[0] / TILE);
        const mcy = Math.round(m.pos[2] / TILE);
        const tcx = Math.round((m.lastSeenX ?? closest.pos[0]) / TILE);
        const tcy = Math.round((m.lastSeenZ ?? closest.pos[2]) / TILE);
        if (!m.path || m.pathRecomputeT <= 0 || m.pathIndex >= (m.path?.length||0)) {
          m.path = cells ? bfsPath(cells, mcx, mcy, tcx, tcy) : null;
          m.pathIndex = m.path ? 1 : 0;  // skip our own cell
          m.pathRecomputeT = 0.6;
        }
        if (m.path && m.pathIndex < m.path.length) {
          const [gcx, gcy] = m.path[m.pathIndex];
          goalX = gcx * TILE;
          goalZ = gcy * TILE;
          // Advance waypoint when close enough
          if (Math.hypot(goalX - m.pos[0], goalZ - m.pos[2]) < 0.35) m.pathIndex++;
        } else {
          // No path — idle for now
          goalX = m.pos[0]; goalZ = m.pos[2];
        }
      }
      const dx = goalX - m.pos[0], dz = goalZ - m.pos[2];
      const d = Math.hypot(dx, dz) || 0.001;
      // While the attack animation is playing, hold position so the swing reads
      // cleanly. Still turn to face the target.
      const swinging = performance.now() < (m.attackAnimUntil || 0);
      if (!swinging) {
        const vx = (dx/d)*def.speed, vz = (dz/d)*def.speed;
        let nx = m.pos[0] + vx*dt, nz = m.pos[2] + vz*dt;
        if (def.special !== 'phantom') {
          const fixed = collidePoint(nx, nz, 0.4);
          nx = fixed.x; nz = fixed.z;
        }
        m.pos[0] = nx; m.pos[2] = nz;
      }
      m.yaw = Math.atan2(dx, dz);

      // Attack (only if still in direct sight of the real player)
      m.attackT -= dt;
      const realD = Math.hypot(closest.pos[0]-m.pos[0], closest.pos[2]-m.pos[2]);
      if (canSee && realD < def.attackRange && m.attackT <= 0) {
        const willKill = closest.hp <= def.damage;
        // Play a random attack/punch clip if the model has any
        const attacks = m.mesh.userData?.actions?.attacks;
        if (attacks && attacks.length) {
          const pick = attacks[Math.floor(Math.random() * attacks.length)];
          const ud = m.mesh.userData;
          // Stop other actions and start this attack from frame 0
          if (ud.currentAction && ud.actions[ud.currentAction] && ud.actions[ud.currentAction] !== pick) {
            ud.actions[ud.currentAction].fadeOut(0.08);
          }
          pick.reset().fadeIn(0.05).play();
          ud.currentAction = '__attack__';
          // Track when the swing ends so movement stays frozen and the picker
          // doesn't rip the animation out mid-punch.
          const dur = (pick.getClip && pick.getClip().duration) || m.mesh.userData.actions.attackDuration || 0.9;
          m.attackAnimUntil = performance.now() + dur * 1000;
        }
        broadcastPlayerDamage(closest, def.damage, def.name);
        if (def.special === 'leech') {
          sendEvent && sendEvent({ type: 'slowed', id: closest.id, duration: 2 });
          if (closest.id === STATE.myId) me.slowedUntil = performance.now() + 2000;
        }
        m.attackT = def.attackCooldown;

        // Mimic post-kill transform
        if (def.special === 'mimic' && willKill) {
          m.mimicColor = closest.color;
          m.mimicName = closest.name;
          applyMimicVisual(m);
          m.state = 'idle';
          m.stateT = 15;
          m.targetId = null;
          m.hp = Math.max(m.hp, 80);
          sendEvent && sendEvent({ type: 'mimicMorph', id: m.id, color: m.mimicColor, name: m.mimicName });
        } else if (willKill) {
          // Kill shot — revert to idle/wander, forget this target.
          m.state = 'idle';
          m.targetId = null;
          m.idleT = 0;
          m.idleDur = 1.5 + Math.random()*2;
          m.moving = false;
          m.lostSightT = 0;
        }
      }
    } else {
      // Idle/patrol: alternate between STANDING STILL and WANDERING through the
      // maze graph. Monsters only walk toward cells they can actually reach.
      m.idleT = (m.idleT || 0) + dt;
      if (m.moving === undefined) { m.moving = false; m.idleDur = 1.5 + Math.random()*1.5; }
      if (m.idleT >= m.idleDur) {
        m.moving = !m.moving;
        m.idleT = 0;
        if (m.moving) {
          pickWanderCell(m);
          m.idleDur = 2.5 + Math.random()*3;
        } else {
          m.targetCellX = null;
          m.idleDur = 1.2 + Math.random()*2.3;
        }
      }
      if (m.moving && m.targetCellX != null && def.special !== 'phantom') {
        const gx = m.targetCellX * TILE;
        const gz = m.targetCellY * TILE;
        const dx = gx - m.pos[0], dz = gz - m.pos[2];
        const d = Math.hypot(dx, dz);
        if (d < 0.25) {
          // Arrived — pick the next neighbor and keep walking
          pickWanderCell(m);
        } else {
          const speed = def.speed * 0.4;
          const vx = (dx/d) * speed, vz = (dz/d) * speed;
          let nx = m.pos[0] + vx*dt, nz = m.pos[2] + vz*dt;
          const fixed = collidePoint(nx, nz, 0.4);
          nx = fixed.x; nz = fixed.z;
          m.pos[0] = nx; m.pos[2] = nz;
          m.yaw = Math.atan2(dx, dz);
        }
      } else if (m.moving && def.special === 'phantom') {
        // Phantoms ignore walls — keep the old free-direction wander
        const vx = Math.sin(m.yaw)*def.speed*0.4, vz = Math.cos(m.yaw)*def.speed*0.4;
        m.pos[0] += vx*dt;
        m.pos[2] += vz*dt;
      }
    }

    // Update mesh (walking animation)
    const walking = m.state === 'chase' || m.stateT > 0.1;
    m.walkPhase = (m.walkPhase||0) + dt * (m.state === 'chase' ? 8 : 4);
    if (m.mesh.userData?.noProcWalkAnim) {
      // GLB-based monsters animate via AnimationMixer, no procedural bob/limb swing.
      m.mesh.position.set(m.pos[0], 0, m.pos[2]);
    } else {
      const bob = walking ? Math.sin(m.walkPhase)*0.05 : 0;
      m.mesh.position.set(m.pos[0], bob, m.pos[2]);
      const armL = m.mesh.userData?.armL, armR = m.mesh.userData?.armR;
      if (armL && armR && walking) {
        const swing = Math.sin(m.walkPhase) * 0.6;
        armL.rotation.x = swing;
        armR.rotation.x = -swing;
      }
    }
    m.mesh.rotation.y = m.yaw;
  }
}

// Advance AnimationMixers for GLB monsters every frame (host + clients)
function updateMonsterMixers(dt) {
  for (const m of STATE.monsters) {
    const ud = m.mesh?.userData;
    if (!ud?.mixer) continue;
    // Crossfade between animations based on monster state
    if (ud.actions) {
      // While a punch is playing, don't touch the state machine; let the
      // LoopOnce attack clip run to completion.
      const attacking = performance.now() < (m.attackAnimUntil || 0);
      if (!attacking) {
        let target = 'idle';
        if (m.state === 'chase') {
          target = ud.actions.run ? 'run' : (ud.actions.walk ? 'walk' : 'idle');
        } else if (m.state === 'idle' || m.state === 'patrol') {
          const movingNow = !!m.moving;
          target = (movingNow && ud.actions.walk) ? 'walk' : 'idle';
        }
        if (target !== ud.currentAction && ud.actions[target]) {
          const prev = ud.actions[ud.currentAction];
          const next = ud.actions[target];
          next.reset().play();
          // Cross-fading from an attack clip that just finished would look
          // snappy — use a simple fadeIn instead.
          if (prev && ud.currentAction !== '__attack__') prev.crossFadeTo(next, 0.25, false);
          else next.fadeIn(0.12);
          ud.currentAction = target;
        }
      }
    }
    ud.mixer.update(dt);
  }
}

function isInView(player, pos, thresholdDotProduct=0.7) {
  // Use player yaw/pitch
  const dx = pos[0]-player.pos[0], dz = pos[2]-player.pos[2];
  const d = Math.hypot(dx, dz) || 0.001;
  const facingX = Math.sin(player.yaw), facingZ = Math.cos(player.yaw) * -1; // camera faces -Z at yaw 0
  // simpler: angle between (dx,dz) normalized and (sin(yaw), cos(yaw)*-1)
  const nx = dx/d, nz = dz/d;
  // In our world, at yaw 0, camera looks down -Z so forward = (0,0,-1)
  // dot between (nx, nz) and (-sin(yaw)*something) ... simplify
  const ang = Math.atan2(nx, -nz) - player.yaw;
  const norm = Math.atan2(Math.sin(ang), Math.cos(ang));
  return Math.abs(norm) < Math.PI*0.45; // ~80 deg FOV
}

function isInFlashlightCone(player, pos) {
  if (!player.flashOn) return false;
  const dx = pos[0]-player.pos[0], dz = pos[2]-player.pos[2];
  const d = Math.hypot(dx, dz);
  if (d > 12) return false;
  const nx = dx/d, nz = dz/d;
  const ang = Math.atan2(nx, -nz) - player.yaw;
  const norm = Math.atan2(Math.sin(ang), Math.cos(ang));
  return Math.abs(norm) < Math.PI*0.18;
}

function dist2(a, b) { const dx=a[0]-b[0], dz=a[2]-b[2]; return dx*dx+dz*dz; }

function broadcastPlayerDamage(player, dmg, reason) {
  if (player.id === STATE.myId) takeDamage(dmg, reason);
  sendEvent && sendEvent({ type: 'damagePlayer', id: player.id, dmg, reason });
}

// ------------------------------------------------------------------
// TRAPS (host checks collisions for all players)
// ------------------------------------------------------------------
function updateTrapsHost(dt) {
  for (const t of STATE.traps) {
    t.cooldown -= dt;
    for (const p of STATE.players.values()) {
      if (!p.alive) continue;
      const dx = p.pos[0]-t.pos[0], dz = p.pos[2]-t.pos[2];
      const d = Math.hypot(dx, dz);
      if (t.type === 'pit' && d < TILE*0.38 && t.armed) {
        if (p.id === STATE.myId) { takeDamage(9999, 'Pitfall'); }
        sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 9999, reason: 'Pitfall' });
        sendEvent && sendEvent({ type: 'died', id: p.id, reason: 'Pitfall' });
        if (p.id !== STATE.myId) { p.alive = false; }
      } else if (t.type === 'bear' && d < 0.6 && t.armed) {
        t.armed = false;
        t.mesh.visible = false; // sprung
        if (p.id === STATE.myId) { me.trappedUntil = performance.now() + 4000; takeDamage(10, 'Bear trap'); popup('BEAR TRAP — stuck'); }
        else { sendEvent && sendEvent({ type: 'bearTrapped', id: p.id }); sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 10, reason: 'Bear trap' }); }
      } else if (t.type === 'spike' && d < TILE*0.45 && t.cooldown <= 0) {
        t.cooldown = 1.1;
        if (p.id === STATE.myId) takeDamage(14, 'Spike floor');
        else sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 14, reason: 'Spike floor' });
      } else if (t.type === 'gas' && d < 1.2 && t.cooldown <= 0) {
        t.cooldown = 0.6;
        if (p.id === STATE.myId) takeDamage(3, 'Gas cloud');
        else sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 3, reason: 'Gas cloud' });
      } else if (t.type === 'dart' && d < TILE*0.5 && t.cooldown <= 0) {
        t.cooldown = 1.6;
        if (p.id === STATE.myId) takeDamage(18, 'Dart trap');
        else sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 18, reason: 'Dart trap' });
        sendEvent && sendEvent({ type: 'trapFx', id: t.id, kind: 'dart' });
      } else if (t.type === 'crusher' && d < TILE*0.45 && t.cooldown <= 0) {
        t.cooldown = 2.5;
        // Trigger crusher animation on all clients
        t.crushT = 0.6;
        sendEvent && sendEvent({ type: 'trapFx', id: t.id, kind: 'crush' });
        if (p.id === STATE.myId) takeDamage(40, 'Crusher');
        else sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 40, reason: 'Crusher' });
      } else if (t.type === 'electric' && d < TILE*0.5 && t.cooldown <= 0) {
        t.cooldown = 0.35;
        if (p.id === STATE.myId) takeDamage(8, 'Electric floor');
        else sendEvent && sendEvent({ type: 'damagePlayer', id: p.id, dmg: 8, reason: 'Electric floor' });
      } else if (t.type === 'trip' && d < 0.6 && t.armed) {
        t.armed = false;
        // Alert all monsters within 15 units
        for (const mon of STATE.monsters) {
          const dd = Math.hypot(mon.pos[0]-t.pos[0], mon.pos[2]-t.pos[2]);
          if (dd < 15) { mon.state = 'chase'; mon.targetId = p.id; }
        }
        if (p.id === STATE.myId) popup('Trip wire! Monsters alerted');
      }
    }
  }
}

// ------------------------------------------------------------------
// MAIN UPDATE LOOP
// ------------------------------------------------------------------
let last = performance.now();
let lastPlayerBroadcast = 0;
let lastWorldBroadcast = 0;

function update(dt) {
  if (STATE.phase !== 'playing') return;
  // Pause menu / settings / howto → skip player input this frame
  // (host monsters and traps still run so networked worlds don't desync)
  const paused = !pauseEl.classList.contains('hidden') ||
                 !settingsEl.classList.contains('hidden') ||
                 !howtoEl.classList.contains('hidden');

  if (paused) {
    if (STATE.isHost) { updateMonstersHost(dt); updateTrapsHost(dt); }
    return;
  }

  // Bear trap immobilization
  const trapped = me.alive && performance.now() < me.trappedUntil;

  // Movement (FPS)
  const speedBase = 3.3;
  let speed = speedBase * (me.speedMul || 1);
  if (me.crouching && !me.crouchFull) speed *= 0.55;
  const slowed = performance.now() < (me.slowedUntil || 0);
  if (slowed) speed *= 0.55;
  if (me.adrenaline && me.hp < me.maxHp*0.3) speed *= 1.3;
  const sprintable = keys['shift'] && me.stam > 0 && !me.crouching && !trapped && !slowed && !me.noSprint;
  if (sprintable) speed *= 1.7;
  me.sprinting = sprintable;

  if (trapped) speed = 0;
  if (!me.alive) speed = 0;

  const fwd = (keys['w'] || keys['arrowup']) ? 1 : 0;
  const back = (keys['s'] || keys['arrowdown']) ? 1 : 0;
  const left = (keys['a'] || keys['arrowleft']) ? 1 : 0;
  const right = (keys['d'] || keys['arrowright']) ? 1 : 0;
  let mz = fwd - back;
  let mx = right - left;
  // Confusion debuff: shuffle controls every few seconds
  if (me.confusion) {
    if (!me._confNext || performance.now() > me._confNext) {
      me._confNext = performance.now() + 3000 + Math.random()*4000;
      me._confMode = Math.floor(Math.random()*4);
    }
    const mode = me._confMode || 0;
    if (mode === 1) { mz = -mz; mx = -mx; }            // reversed
    else if (mode === 2) { const t = mz; mz = mx; mx = t; }  // axes swapped
    else if (mode === 3) { const t = mz; mz = -mx; mx = t; } // rotated 90
  }
  const magn = Math.hypot(mx, mz) || 1;
  const vx = (Math.sin(me.yaw) * -mz + Math.cos(me.yaw) * mx) * speed / magn;
  const vz = (Math.cos(me.yaw) * -mz - Math.sin(me.yaw) * mx) * speed / magn;

  if (me.spectator && !me.alive) {
    // Free-fly movement, ignore walls, use fixed speed; use Space/Shift for vertical
    const sv = 6 * ((keys['shift'] ? 2.2 : 1));
    const fvx = (Math.sin(me.yaw) * -mz + Math.cos(me.yaw) * mx) * sv / magn;
    const fvz = (Math.cos(me.yaw) * -mz - Math.sin(me.yaw) * mx) * sv / magn;
    if (magn > 0.05) {
      me.pos[0] += fvx * dt;
      me.pos[2] += fvz * dt;
    }
    if (keys[' ']) me.specY = Math.min(12, (me.specY||3) + sv*dt);
    if (keys['c']) me.specY = Math.max(0.3, (me.specY||3) - sv*dt);
  } else if (speed > 0 && magn > 0.05) {
    const nx = me.pos[0] + vx * dt;
    const nz = me.pos[2] + vz * dt;
    const fixedX = collidePoint(nx, me.pos[2], 0.28);
    const fixedZ = collidePoint(fixedX.x, nz, 0.28);
    const intended = Math.hypot(vx*dt, vz*dt);
    const actual = Math.hypot(fixedZ.x - me.pos[0], fixedZ.z - me.pos[2]);
    if (intended > 0.02 && actual < intended * 0.35) {
      if (!me._lastBumpT || performance.now() - me._lastBumpT > 600) {
        audio.bump();
        me._lastBumpT = performance.now();
      }
    }
    me.pos[0] = fixedZ.x;
    me.pos[2] = fixedZ.z;
  }

  // Sprint FOV kick
  const targetFov = me.sprinting ? 84 : 75;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt*6);
  camera.updateProjectionMatrix();

  // Jump physics
  if (!me.jumpY) me.jumpY = 0;
  if (keys[' '] && me.grounded && me.alive && !trapped && !me.crouching) {
    me.vy = 5.5;
    me.grounded = false;
    keys[' '] = false;
  }
  me.vy -= 14 * dt;
  me.jumpY = Math.max(0, me.jumpY + me.vy * dt);
  if (me.jumpY <= 0) { me.jumpY = 0; me.vy = 0; me.grounded = true; }
  // Breathing (heavy when stamina low or sprinting)
  if (me.alive && !me.inSafeRoom) {
    const winded = me.stam < 30 || me.sprinting;
    if (winded) audio.breathing(true);
    else if (me.hp < me.maxHp * 0.3) audio.breathing(true);
  }

  // Crouch
  const wantCrouch = keys['c'] && !trapped && me.alive;
  me.crouching = !!wantCrouch;

  // Stamina
  if (sprintable && (mx || mz)) {
    me.stam = Math.max(0, me.stam - 22*dt*(me.sprintEff||1)*(me.stamDrainMul||1));
  } else {
    me.stam = Math.min(me.maxStam, me.stam + 12*dt*(me.stamRegenMul||1));
  }

  // HP regen / bleed
  if (me.alive) {
    if (me.regen > 0) me.hp = Math.min(me.maxHp, me.hp + me.regen*dt);
    if (me.bleed > 0) me.hp = Math.max(0, me.hp - me.bleed*dt);
    if (me.hp <= 0 && me.alive) playerDied('bled out');
  }

  // Repellent timer
  if (me.repellentT) {
    me.repellentT = Math.max(0, me.repellentT - dt);
  }

  // Flashlight battery
  if (me.flashOn && !me.infBattery) {
    me.flashBattery = Math.max(0, me.flashBattery - 3*dt*(me.battDrainMul||1));
    if (me.flashBattery <= 0) {
      if (me.battReserve > 0) {
        me.battReserve--;
        me.flashBattery = 100;
        popup('Reserve battery used');
      } else {
        me.flashOn = false;
        flashlight.intensity = 0;
        popup('Flashlight out');
      }
    }
  } else if (me.infBattery) {
    me.flashBattery = 100;
  }

  // Flashlight glitch debuff: random brief outage
  if (me.flashGlitch && me.flashOn) {
    if (!me._glitchEnd) {
      if (Math.random() < dt * 0.08) {
        me._glitchEnd = performance.now() + 300 + Math.random()*700;
      }
    }
    if (me._glitchEnd) {
      if (performance.now() < me._glitchEnd) {
        flashlight.intensity = Math.random() < 0.5 ? 0 : (me.flashPower ? 20 : 12);
      } else {
        me._glitchEnd = null;
        flashlight.intensity = me.flashOn ? (me.flashPower ? 20 : 12) : 0;
      }
    }
  }

  // Phobia: drain HP near monsters
  if (me.phobia && me.alive) {
    for (const m of STATE.monsters) {
      const d = Math.hypot(m.pos[0]-me.pos[0], m.pos[2]-me.pos[2]);
      if (d < 5) { me.hp = Math.max(0, me.hp - dt * 2); break; }
    }
  }

  // Butterfingers: randomly drop selected item
  if (me.butterfingers && Math.random() < dt * 0.015) {
    const it = me.items[me.selectedSlot];
    if (it && it.type !== 'flashlight') {
      popup('Fumble! Dropped ' + itemMeta(it.type).name);
      dropSelected();
    }
  }

  // Fake exits debuff
  updateFakeExits();

  // Echo sense: periodic sonar pulse
  if (me.echo) {
    me._echoT = (me._echoT || 0) + dt;
    if (me._echoT > 4) {
      me._echoT = 0;
      const el = $('sonarPulse');
      el.classList.remove('ping');
      void el.offsetWidth;
      el.classList.add('ping');
    }
  }

  // Camera follow
  const camY = me.spectator
    ? (me.specY || 3.0)
    : ((me.crouching ? 1.0 : 1.55) + (me.jumpY || 0));
  // Trembling debuff: tiny random noise
  let trX = 0, trY = 0, trYaw = 0, trPitch = 0;
  if (me.trembling) {
    trX = (Math.random()-0.5) * 0.05;
    trY = (Math.random()-0.5) * 0.04;
    trYaw = (Math.random()-0.5) * 0.02;
    trPitch = (Math.random()-0.5) * 0.02;
  }
  camera.position.set(me.pos[0] + trX, camY + trY, me.pos[2]);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = me.yaw + trYaw;
  camera.rotation.x = me.pitch + trPitch;
  // Crooked: head tilt roll
  camera.rotation.z = me.crooked ? 0.18 : 0;

  // Crosshair / interact hint
  const hintMul = me.scavenger ? 2 : 1;
  let canInteract = false;
  if (STATE.levelMeta?.door) {
    const d = STATE.levelMeta.door;
    if (dist2(me.pos, [d.position.x, 0, d.position.z]) < 4*hintMul) canInteract = true;
  }
  for (const p of STATE.pickups) if (!p.taken && dist2(me.pos, p.pos) < 2*hintMul) { canInteract = true; break; }
  $('interactHint').classList.toggle('hidden', !canInteract);

  // Flares & smokes tick
  updateFlares(dt);
  updateSmokes(dt);
  // Trap meshes (spike animation)
  for (const t of STATE.traps) {
    if (t.type === 'spike') {
      const bob = Math.sin(performance.now()*0.005 + (t.pos[0]+t.pos[2]));
      t.mesh.position.y = 0.02 + Math.max(0, bob*0.2);
    }
    if (t.type === 'gas') {
      t.mesh.rotation.y += dt*0.3;
    }
    if (t.type === 'crusher' && t.crushT > 0) {
      t.crushT -= dt;
      const plate = t.mesh.userData.crusherPlate;
      if (plate) {
        const phase = 1 - t.crushT/0.6;
        const down = Math.sin(Math.PI * phase);
        plate.position.y = WALL_H - 0.25 - down*3.6;
      }
    } else if (t.type === 'crusher' && t.mesh.userData.crusherPlate) {
      t.mesh.userData.crusherPlate.position.y = WALL_H - 0.25;
    }
    if (t.type === 'electric' && t.mesh.userData.elecLight) {
      t.mesh.userData.elecLight.intensity = 0.3 + Math.random()*0.8;
    }
  }

  // Key spin / pickup bob
  for (const p of STATE.pickups) {
    if (p.taken || !p.mesh) continue;
    p.mesh.rotation.y += dt*1.2;
    p.mesh.position.y = p.pos[1] + Math.sin(performance.now()*0.002 + p.pos[0])*0.15;
  }
  // Exit light flicker
  if (STATE.levelMeta?.exitLight) {
    STATE.levelMeta.exitLight.intensity = 1.2 + Math.sin(performance.now()*0.007)*0.4 + (Math.random()<0.02 ? -0.6 : 0);
  }
  // Torches/fluorescents flicker
  levelGroup.children.forEach(o => {
    if (o.userData?.type === 'torch') {
      o.userData.light.intensity = 1.0 + Math.sin(performance.now()*0.008 + o.userData.flicker)*0.3 + (Math.random()<0.05 ? -0.5 : 0);
    } else if (o.userData?.type === 'fluor') {
      o.userData.light.intensity = (Math.random()<0.03 ? 0.0 : 1.0) + Math.sin(performance.now()*0.03 + o.userData.flicker)*0.1;
    }
  });

  // Host tasks
  if (STATE.isHost) {
    updateMonstersHost(dt);
    updateTrapsHost(dt);
  }

  // Animation mixers (runs on host and clients)
  updateMonsterMixers(dt);

  // Detect walking through descend door
  if (me.alive && me.inSafeRoom && STATE.safeRoomOpen) {
    const d = safeRoomGroup.userData.descendDoor;
    if (d) {
      const dx = me.pos[0] - d.position.x, dz = me.pos[2] - d.position.z;
      if (dx*dx + dz*dz < 1.5) {
        if (STATE.isHost) {
          advanceLevel();
        } else {
          sendEvent && sendEvent({ type: 'reqAdvance' });
        }
      }
    }
  }
  // Render other players' meshes (our players map) — we create simple capsules for them
  renderPeerAvatars(dt);

  // Multiplayer broadcasts
  const now = performance.now();
  if (now - lastPlayerBroadcast > 60) {
    lastPlayerBroadcast = now;
    sendPlayer && sendPlayer({
      name: me.name, pos: me.pos.slice(), yaw: me.yaw, pitch: me.pitch,
      hp: me.hp, stam: me.stam, flashOn: me.flashOn, crouching: me.crouching,
      sprinting: me.sprinting, color: me.color, alive: me.alive, level: me.level,
    });
  }
  if (STATE.isHost && now - lastWorldBroadcast > 120) {
    lastWorldBroadcast = now;
    sendWorld && sendWorld(hostSnapshot());
  }

  // Monster growl when close (host only to avoid duplicate sounds)
  if (me.alive && !me.inSafeRoom && STATE.isHost) {
    let closest = Infinity;
    for (const m of STATE.monsters) {
      const d = Math.hypot(m.pos[0]-me.pos[0], m.pos[2]-me.pos[2]);
      if (d < closest) closest = d;
    }
    if (closest < 6 && Math.random() < dt * 0.4) {
      audio.monsterRoar();
      sendEvent && sendEvent({ type: 'roar', pos: me.pos.slice() });
    }
  }

  // HUD update
  renderHUD();

  STATE.tickCount++;
}
let heartbeatAcc = 0;

function updateFlares(dt) {
  for (let i=flares.length-1;i>=0;i--) {
    const f = flares[i];
    f.t -= dt;
    if (!f.landed) {
      f.vel[1] -= 10*dt;
      f.pos[0] += f.vel[0]*dt;
      f.pos[1] += f.vel[1]*dt;
      f.pos[2] += f.vel[2]*dt;
      if (f.pos[1] <= 0.15) {
        f.pos[1] = 0.15; f.landed = true;
        f.vel[0]=f.vel[1]=f.vel[2]=0;
      }
      const fixed = collidePoint(f.pos[0], f.pos[2], 0.15);
      f.pos[0] = fixed.x; f.pos[2] = fixed.z;
      f.mesh.position.set(...f.pos);
    }
    // flicker
    f.light.intensity = 6 + Math.sin(performance.now()*0.02)*2;
    // scare monsters away (host only)
    if (STATE.isHost && f.landed) {
      for (const m of STATE.monsters) {
        const dx = m.pos[0]-f.pos[0], dz = m.pos[2]-f.pos[2];
        const d = Math.hypot(dx, dz);
        if (d < 8) {
          m.pos[0] += (dx/d) * 2 * dt;
          m.pos[2] += (dz/d) * 2 * dt;
          m.yaw = Math.atan2(dx, dz) + Math.PI;
        }
      }
    }
    if (f.t <= 0) {
      levelGroup.remove(f.mesh);
      flares.splice(i, 1);
    }
  }
}
function updateSmokes(dt) {
  for (let i=smokes.length-1;i>=0;i--) {
    const s = smokes[i];
    s.t -= dt;
    if (s.mesh) {
      s.mesh.material.opacity = Math.max(0, s.t/10 * 0.55);
      s.mesh.scale.setScalar(1 + (1 - s.t/10)*0.8);
    }
    if (s.t <= 0) { levelGroup.remove(s.mesh); smokes.splice(i, 1); }
  }
}

// Per-peer avatar rendering
const peerAvatars = new Map();
function renderPeerAvatars(dt) {
  // add/update meshes for each player (not me)
  for (const [id, p] of STATE.players) {
    if (id === STATE.myId) continue;
    let g = peerAvatars.get(id);
    if (!g) {
      g = new THREE.Group();
      const color = new THREE.Color(p.color || '#cc4040');
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 8), mat);
      body.position.y = 0.85;
      body.castShadow = true;
      g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), mat);
      head.position.y = 1.6;
      head.castShadow = true;
      g.add(head);
      // Flashlight visual (cone)
      const lightCone = new THREE.PointLight(0xfff4d6, 0, 10);
      lightCone.position.set(0, 1.4, 0.4);
      g.add(lightCone);
      g.userData.light = lightCone;
      scene.add(g);
      peerAvatars.set(id, g);
    }
    if (!p.renderPos) p.renderPos = p.pos.slice();
    const k = Math.min(1, dt*10);
    p.renderPos[0] += (p.pos[0] - p.renderPos[0]) * k;
    p.renderPos[2] += (p.pos[2] - p.renderPos[2]) * k;
    g.position.set(p.renderPos[0], p.crouching ? -0.4 : 0, p.renderPos[2]);
    g.rotation.y = p.yaw;
    g.userData.light.intensity = p.flashOn ? 1.2 : 0;
    g.visible = !!p.alive;
  }
  // remove avatars for gone peers
  for (const [id, g] of peerAvatars) {
    if (!STATE.players.has(id)) {
      scene.remove(g);
      peerAvatars.delete(id);
    }
  }
}

// ------------------------------------------------------------------
// HUD RENDER
// ------------------------------------------------------------------
function renderHUD() {
  $('hpFill').style.width = `${Math.max(0, me.hp/me.maxHp*100)}%`;
  $('hpText').textContent = `${Math.round(me.hp)} / ${me.maxHp}`;
  $('stamFill').style.width = `${Math.max(0, me.stam/me.maxStam*100)}%`;
  $('stamText').textContent = me.sprinting ? 'Sprinting' : 'Stamina';
  $('flashFill').style.width = `${Math.max(0, me.flashBattery)}%`;
  $('flashText').textContent = me.infBattery ? 'Battery: ∞' : `Battery: ${Math.round(me.flashBattery)}%`;
  if (popupT > 0) {
    popupT -= 1/60;
    if (popupT <= 0) $('popup').classList.remove('show');
  }

  // Compass arrows
  const compass = $('compass');
  const hasKeySense = me.keySense, hasExitSense = me.exitSense;
  if ((hasKeySense || hasExitSense) && STATE.levelMeta) {
    compass.classList.remove('hidden');
    const keyEl = $('compassKey'), exEl = $('compassExit');
    if (hasKeySense && STATE.keyHolderId == null) {
      const kp = cellToWorld(STATE.levelMeta.keyCell[0], STATE.levelMeta.keyCell[1]);
      keyEl.classList.remove('hidden');
      const ang = Math.atan2(kp.x - me.pos[0], -(kp.z - me.pos[2])) - me.yaw;
      keyEl.querySelector('.arr').style.transform = `rotate(${ang}rad)`;
    } else { keyEl.classList.add('hidden'); }
    if (hasExitSense) {
      const ep = cellToWorld(STATE.levelMeta.exitCell[0], STATE.levelMeta.exitCell[1]);
      exEl.classList.remove('hidden');
      const ang = Math.atan2(ep.x - me.pos[0], -(ep.z - me.pos[2])) - me.yaw;
      exEl.querySelector('.arr').style.transform = `rotate(${ang}rad)`;
    } else { exEl.classList.add('hidden'); }
  } else {
    compass.classList.add('hidden');
  }

  // Night vision overlay
  $('nightVis').classList.toggle('on', !!me.nightVision);

  // Bleed vignette (active if bleed > 0)
  $('bleedVignette').classList.toggle('on', (me.bleed||0) > 0);

  // Phobia vignette (active when near a monster, if debuff present)
  const phobia = $('phobiaVignette');
  if (me.phobia) {
    let near = false;
    for (const m of STATE.monsters) {
      if (Math.hypot(m.pos[0]-me.pos[0], m.pos[2]-me.pos[2]) < 5) { near = true; break; }
    }
    phobia.classList.toggle('on', near);
  } else {
    phobia.classList.remove('on');
  }

  // Status strip
  const strip = $('statusStrip');
  const chips = [];
  for (const bid of (me.buffs||[])) {
    const b = BUFFS.find(x => x.id === bid);
    if (b) chips.push(`<span class="status-chip buff">${escapeHtml(b.name)}</span>`);
  }
  for (const did of (me.debuffs||[])) {
    const d = DEBUFFS.find(x => x.id === did);
    if (d) chips.push(`<span class="status-chip debuff">${escapeHtml(d.name)}</span>`);
  }
  strip.innerHTML = chips.join('');

  // Teammate HP list
  const team = $('teamList');
  const rows = [];
  const allPlayers = [...STATE.players.values()].filter(p => p.id !== STATE.myId);
  for (const p of allPlayers) {
    const color = p.color || '#888';
    const hpN = Math.round(p.hp || 0);
    const maxN = p.maxHp || 100;
    const dead = !p.alive;
    const finished = p.finishedLevel ? ' ✓' : '';
    rows.push(`<div class="team-row${dead ? ' dead' : ''}" style="border-left-color:${color}">
      <span class="dot" style="background:${color}"></span>
      <span class="n">${escapeHtml(p.name || 'player')}${finished}</span>
      <span class="hp">${dead ? '☠' : (hpN + '/' + maxN)}</span>
    </div>`);
  }
  team.innerHTML = rows.join('');
}

// ------------------------------------------------------------------
// X-RAY OVERLAY (monsters/traps through walls)
// ------------------------------------------------------------------
const xrayScene = new THREE.Scene();
const xrayMarkers = new Map();
const xrayTrapMarkers = new Map();
const xrayMonsterMat = new THREE.MeshBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
const xrayTrapMat = new THREE.MeshBasicMaterial({ color: 0xffcc40, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });

function updateXrayScene() {
  const xrayMon = me.xrayMonsters || me.reveal;
  const wantedMon = new Set();
  if (xrayMon) {
    for (const m of STATE.monsters) {
      wantedMon.add(m.id);
      let x = xrayMarkers.get(m.id);
      if (!x) {
        x = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), xrayMonsterMat);
        x.renderOrder = 999;
        xrayScene.add(x);
        xrayMarkers.set(m.id, x);
      }
      x.position.set(m.pos[0], 1.0, m.pos[2]);
    }
  }
  for (const [id, mesh] of [...xrayMarkers]) {
    if (!wantedMon.has(id)) { xrayScene.remove(mesh); xrayMarkers.delete(id); }
  }

  const xrayTrap = me.trapSense;
  const wantedT = new Set();
  if (xrayTrap) {
    for (const t of STATE.traps) {
      wantedT.add(t.id);
      let x = xrayTrapMarkers.get(t.id);
      if (!x) {
        x = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 16), xrayTrapMat);
        x.rotation.x = -Math.PI/2;
        x.renderOrder = 998;
        xrayScene.add(x);
        xrayTrapMarkers.set(t.id, x);
      }
      x.position.set(t.pos[0], 0.08, t.pos[2]);
    }
  }
  for (const [id, mesh] of [...xrayTrapMarkers]) {
    if (!wantedT.has(id)) { xrayScene.remove(mesh); xrayTrapMarkers.delete(id); }
  }
}

// ------------------------------------------------------------------
// MAIN LOOP
// ------------------------------------------------------------------
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  updateXrayScene();
  renderer.render(scene, camera);
  // Overlay the x-ray pass (no depth clearing — relies on depthTest:false on its materials)
  if (xrayMarkers.size + xrayTrapMarkers.size > 0) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(xrayScene, camera);
    renderer.autoClear = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------
// KICK OFF (show menu)
// ------------------------------------------------------------------
showScreen('menu');

// If portal-arrived, pre-fill name
if (incomingParams.fromPortal) {
  STATE.username = incomingParams.username;
  $('nameInput').value = STATE.username;
}

// Also initialize multiplayer lazily when entering lobby,
// but preload the module in background so the first join is snappy.
loadTrystero().catch(()=>{});

// Expose for debugging
window.TRAPPED = { STATE, scene, camera, spawnCorpse, removeCorpse };
