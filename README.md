# Ordinary Game Jam #1 — Starter Template

**Click the green "Use this template" button at the top of this repo** to create your own game repository from this starter. (Don't fork — template creates a clean, independent repo with a working Pages deploy and the portal protocol already wired up.)

Showcase & spec: https://github.com/CallumHYoung/gamejam

---

## What you get out of the box

- A minimal working game (`index.html` + `game.js`) — moving circle, exit portal, incoming-portal spawn logic, auto-picks a destination from the live jam registry.
- **Realtime multiplayer** via [Trystero](https://github.com/dmotz/trystero). Pure P2P over BitTorrent trackers — no backend, no accounts, no keys. Open two tabs and you'll see each other as circles in the same demo room. Works from the internet, not just localhost.
- `portal.js` — the Portal Protocol helper library. ~80 lines, no dependencies. This is the only hard requirement of the jam.
- `.github/workflows/pages.yml` — a GitHub Actions workflow that deploys your game to GitHub Pages on every push to `main`.
- Purple vibes to match the jam's theme.

Try the starter as-is: after you create your repo and enable Pages, the starter game will already portal to other jam games *and* show other players that are currently in the demo room.

**Multiplayer is optional per the jam spec.** If you don't want it, delete the `Trystero` block in `game.js` (clearly commented) and the `#peers` element in `index.html`. Your game will drop back to solo and the portal protocol still works.

---

## Quick start

### 1. Create your game repo

Click **"Use this template" → "Create a new repository"** at the top of this page. Name it whatever you want (e.g. `rocket-racer`). Make it public.

### 2. Clone it

```bash
git clone https://github.com/<your-username>/<your-game>.git
cd <your-game>
```

### 3. Run it locally

Any static file server works:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

Walk into the purple portal. It'll redirect you to a random game from the live jam registry.

### 4. Build your game

Replace `game.js` (and `index.html` / `style.css` as needed) with your actual game. **Keep `portal.js` and the calls to `Portal.*`** — those are the jam's contract.

Feed the full build spec into your coding agent for the rules: https://github.com/CallumHYoung/gamejam/blob/main/SPEC.md

### 5. Deploy

Push to `main`:

```bash
git add .
git commit -m "Build my game"
git push
```

Then on GitHub:

1. Go to **Settings → Pages** on your repo
2. **Source**: GitHub Actions
3. Watch the workflow run in the **Actions** tab (~1 minute)

Your game is live at:
```
https://<your-username>.github.io/<your-game>/
```

### 6. Submit to the jam

Open https://github.com/CallumHYoung/gamejam/blob/main/jam1.json, click the pencil icon (GitHub will auto-fork for you), and add your entry to the `games` array:

```json
{
  "id": "rocket-racer",
  "title": "Rocket Racer",
  "author": "Your Name",
  "description": "One-line pitch.",
  "url": "https://your-username.github.io/rocket-racer/",
  "repo": "your-username/rocket-racer",
  "thumbnail": "thumbnails/rocket-racer.png",
  "type": "3d",
  "tags": ["platformer", "three.js"],
  "status": "wip"
}
```

Commit to a new branch and open a PR. That's it — once merged, your game appears on the showcase with live deploy status pulled from your repo.

Full walkthrough: https://github.com/CallumHYoung/gamejam/blob/main/GETTING_STARTED.md

---

## The Portal Protocol in 30 seconds

Every jam game reads the same URL params on load and redirects out the same way. That's how players travel between games without any backend.

**Incoming** — when your game loads, `Portal.readPortalParams()` returns:

```js
const { fromPortal, username, color, speed, ref } = Portal.readPortalParams();
```

If `fromPortal` is true, the player arrived from another game — skip your menu and spawn them in. If `ref` is set, also draw a return portal pointing back to `ref`.

**Outgoing** — when the player enters your exit portal:

```js
const target = await Portal.pickPortalTarget();   // random game from the live registry
Portal.sendPlayerThroughPortal(target.url, {
  username, color, speed,
});
```

That's the whole protocol. Full details in [SPEC.md](https://github.com/CallumHYoung/gamejam/blob/main/SPEC.md).

---

## 3D vs 2D

- **2D:** a door, tile, button, or menu item — anything a player can interact with.
- **3D:** a visible object in the world (ring, archway, door) with a collision check against the player.

The starter is 2D canvas. If you're building 3D (Three.js / Babylon / PlayCanvas), you can still import `portal.js` and call `Portal.sendPlayerThroughPortal` / `Portal.readPortalParams` — the protocol is framework-agnostic.

---

## Multiplayer (optional)

Static hosting is compatible with realtime multiplayer through browser-to-service libraries. Don't add multiplayer until your portal loop works. Recommended: [PlayroomKit](https://joinplayroom.com/). Full options in [SPEC.md § Multiplayer](https://github.com/CallumHYoung/gamejam/blob/main/SPEC.md#multiplayer-optional).

---

## Stack freedom

Use whatever you want — Three.js, Phaser, Pixi, Babylon, PlayCanvas, raw canvas, raw WebGL, p5.js, HTML + CSS. The only constraints:

- **Browser-only.** No backend. Static hosting must be enough.
- **Join the network.** Drop in `portal.js` (or implement the handful of URL-param behaviors yourself — it's ~15 lines if you want to inline it). A game that doesn't portal isn't in the jam.
- **Build in public.** Your game repo must be public from the first commit — watching each other's games take shape is half the fun.
- **One entry point.** `index.html` at the root.

Have fun.
