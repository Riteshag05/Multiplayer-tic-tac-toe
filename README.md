# Multiplayer Tic-Tac-Toe with Nakama

Production-style **server-authoritative** tic-tac-toe: all board state and move validation run in Nakama’s Lua match loop; clients only send *intent* (cell index). Includes **matchmaking**, **private rooms**, **leaderboard** (wins/losses/draws, streak, score, time played), and **timed mode** (30s per move, auto-loss on timeout).

**Real-life analogy:** the Nakama server is the referee at a chess club — players call out moves, the referee updates the official board and tells everyone what is legal. Nobody can drag pieces when it is not their turn.

## Repository layout

| Path | Purpose |
|------|---------|
| `docker-compose.yml` | Postgres + Nakama for local/dev |
| `nakama/modules/tictactoe.lua` | Authoritative match handler (board, validation, timers, persistence) |
| `nakama/modules/bootstrap.lua` | Matchmaker hook → creates matches; RPCs `create_private_match`, `resolve_invite`, `leaderboard` |
| `nakama/config/local.yml` | Runtime module path |
| `frontend/` | React + Vite + `@heroiclabs/nakama-js` mobile-first UI |

## Prerequisites

- **Docker** and **Docker Compose** (for Nakama + Postgres)
- **Node.js** 18+ (20.19+ recommended; Vite 5 works on 20.18)
- A browser (or two — easiest way to test multiplayer)

## Quick start (local)

1. **Start Nakama**

   ```bash
   cd tic-tac-toe-nakama
   docker compose up -d
   ```

   - HTTP API / auth: `http://127.0.0.1:7350`
   - Default server key: `defaultkey` (change for any public deployment)

2. **Run the web client**

   ```bash
   cd frontend
   cp .env.example .env   # optional; defaults match local Docker
   npm install
   npm run dev
   ```

   Open the URL Vite prints (usually `http://localhost:5173`).

3. **Test multiplayer**

   - Window A: nickname e.g. `Ritesh`, **Find random player**
   - Window B (or incognito): nickname e.g. `Gunnu`, same mode (Classic or Timed), **Find random player**
   - When paired, only the server applies moves; invalid or out-of-turn moves get an error opcode back to that client only.

4. **Private room**

   - Host: **Create room & copy code** — copies a **short room code** (and shows **Copy full id** on the game screen).
   - Guest: enter the **6-character code** or the full `uuid.node` match id in **Join**.

## Architecture

- **Authoritative match** (`tictactoe.lua`): `match_init` sets tick rate (5 Hz classic, 10 Hz timed). `match_loop` reads opcode `1` messages, validates turn/occupancy, updates `board`, detects win/draw, handles disconnect as forfeit, timed expiry as loss for the current player. State is broadcast with opcode `2` (JSON).
- **Matchmaking**: Clients call `addMatchmaker` with query `properties.mode:classic` or `properties.mode:timed` and string property `mode`. `bootstrap.lua` registers `matchmaker_matched` and calls `nk.match_create("tictactoe", { timed = ... })`.
- **Isolation**: Each `match_create` run is a separate match id — many concurrent games are supported by Nakama’s match registry.
- **Leaderboard / stats**: After each finished game, storage object `tictactoe/stats` per user is updated and `tic_tac_toe_score` leaderboard rows are written (authoritative, operator `set`) with metadata `w`, `l`, `d`, `play_sec`. RPC `leaderboard` returns the top 10 for the results screen.

## API / configuration

| Item | Value |
|------|--------|
| Server key | `defaultkey` (override in production) |
| RPC ids | `create_private_match`, `resolve_invite`, `leaderboard` |
| Match module name | `tictactoe` (file `tictactoe.lua`) |
| Leaderboard id | `tic_tac_toe_score` |
| Client env | See `frontend/.env.example` (`VITE_NAKAMA_HOST`, `VITE_NAKAMA_PORT`, `VITE_NAKAMA_SERVER_KEY`, `VITE_NAKAMA_USE_SSL`) |

## Deliverables checklist (submission)

| Deliverable | What to do |
|-------------|------------|
| **Source repository** | Create a **personal** GitHub or GitLab repo (see [Git on a company laptop](#git-on-a-company-laptop-personal-project) below), `git init`, commit, push this project. |
| **Live game URL** | Deploy the **built** frontend (`frontend/dist`) to Netlify, Vercel, Cloudflare Pages, S3+CloudFront, etc. |
| **Live Nakama endpoint** | Run Nakama + Postgres on a cloud VM or container platform with a **public** hostname and **TLS**. |
| **README** | This file: setup, architecture, API/config, **how to test multiplayer** (below). |
| **Deployment detail** | See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for a step-by-step template and placeholders. |

### Fill in your live links (after deploy)

Edit this table in your fork so reviewers can open them directly:

| Resource | URL |
|----------|-----|
| **Game (production)** | _e.g. `https://your-game.vercel.app`_ |
| **Nakama API (HTTPS)** | _e.g. `https://nakama.yourdomain.com:443`_ |
| **Git repository** | _e.g. `https://github.com/youruser/tic-tac-toe-nakama`_ |

### Git on a company laptop (personal project)

You want **company work** and **personal repos** separated. Pick one approach:

1. **Personal GitHub/GitLab account + HTTPS + PAT (simplest)**  
   - Log in to GitHub **in the browser** with your **personal** account.  
   - Use **Git Credential Manager** (common on Windows) so `git push` stores credentials for `github.com` under your personal login.  
   - Do **not** use the company SSO token for the personal remote; use a **personal access token** scoped to `repo` when prompted for password.

2. **SSH key used only for personal GitHub**  
   - Generate a key: `ssh-keygen -t ed25519 -f %USERPROFILE%\.ssh\id_ed25519_personal -C "you+personal@email"`  
   - Add the **public** key to your **personal** GitHub/GitLab account.  
   - In `~/.ssh/config`, map `Host github.com-personal` to that key and `HostName github.com`, then set remote:  
     `git remote add origin git@github.com-personal:YOURUSER/tic-tac-toe-nakama.git`

3. **Separate Git user for this repo only** (commit author)  
   Inside this project, set your **personal** name/email so commits are not attributed to work:

   ```bash
   cd tic-tac-toe-nakama
   git config user.name "Your Personal Name"
   git config user.email "your.personal@email.com"
   ```

   (Use `--global` only if you want this identity everywhere on that machine.)

4. **Second browser profile / machine**  
   If IT policy forbids mixing accounts, clone and push from a **personal PC** or a **VM** where you control Git identity end-to-end.

**First-time push (example):**

```bash
cd tic-tac-toe-nakama
git init
git add .
git commit -m "Initial commit: Nakama tic-tac-toe"
git branch -M main
git remote add origin https://github.com/YOURUSER/tic-tac-toe-nakama.git
git push -u origin main
```

## Deployment (summary)

Full checklist and provider-agnostic steps: **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

1. **Nakama + Postgres** on a cloud VM or containers: strong keys, TLS, mount `nakama/modules` and `nakama/config`.
2. **Frontend**: `cd frontend && npm run build` — configure `VITE_NAKAMA_*` for your **public** Nakama URL at build time.
3. **CORS / WebSocket**: reverse proxy must allow upgrades; Nakama must accept your frontend origin.

## How to test multiplayer (for reviewers)

1. Open the **deployed game URL** in two browsers (or one + incognito).
2. Enter two different nicknames (≥ 2 characters) and **Continue**.
3. Choose the **same** mode (**Classic** or **Timed**) on both; click **Find random player** on both — they should pair.
4. Confirm only the player whose turn it is can place a mark; finish a game and check the **leaderboard** on the result screen.
5. **Private room**: host **Create room & copy code**; guest enters the **short code** (or full match id) under **Join**.
6. **Forfeit**: mid-game, one player **Leave room** — the other should see a win with an opponent-left style message on the result screen.

Local testing is the same using `docker compose` and `npm run dev` (see Quick start).

## Troubleshooting

- **Matchmaking never matches**: confirm both clients use the **same** mode query (`classic` vs `timed`).
- **Cannot connect from phone**: use your machine’s LAN IP in `VITE_NAKAMA_HOST` and open firewall ports 7350/7351; Nakama must accept connections from that interface.
- **Lua errors on start**: check `docker compose logs nakama` — usually a typo in modules or DB URL.

## License

Apache-2.0 (Nakama runtime modules follow Nakama ecosystem norms; adjust if your institution requires otherwise).
