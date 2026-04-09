# Deployment guide (fill in your values)

Use this after you have chosen a cloud provider. Replace all `YOUR_*` placeholders.

## 1. What you are deploying

| Piece | Role |
|--------|------|
| **PostgreSQL** | Nakama’s database |
| **Nakama** | Game server (HTTP + WebSocket), Lua modules |
| **Static frontend** | Built Vite app (HTML/JS/CSS) |

## 2. Nakama + Postgres (example: single Linux VM)

1. Create a VM (e.g. Ubuntu 22.04) with a **public IP** and open ports **80**, **443** (and optionally **7350** only behind the proxy).
2. Install Docker + Docker Compose on the VM.
3. Copy this repo (or your image) to the server: `nakama/modules`, `nakama/config`, and a **production** `docker-compose` (do not use `defaultkey` in production).

### Minimum production changes

- Generate a strong **server key** and set it in Nakama config and in the frontend `VITE_NAKAMA_SERVER_KEY` at **build time**.
- Set `session.encryption_key` (and related Nakama security settings) per [Nakama configuration](https://heroiclabs.com/docs/nakama/getting-started/configuration/).
- Put **TLS** in front of Nakama (Caddy, nginx, or a cloud load balancer) so browsers can use **HTTPS/WSS**.
- Restrict Postgres to the Docker network only (do not expose `5432` publicly).

### Module loading

Mount the same paths as locally:

- `./nakama/modules` → `/nakama/data/modules` (or equivalent in your image)
- `./nakama/config` → `/nakama/config`

Ensure `local.yml` (or prod yaml) sets `runtime.path` to the modules directory.

## 3. Frontend (example: Vercel or Netlify)

1. On your machine:

   ```bash
   cd frontend
   cp .env.example .env.production.local
   ```

2. Set **build-time** variables (names must start with `VITE_`):

   - `VITE_NAKAMA_HOST` — public hostname of Nakama (no `https://`)
   - `VITE_NAKAMA_PORT` — usually `443` if TLS terminates on 443, or your public API port
   - `VITE_NAKAMA_SERVER_KEY` — must match production server key
   - `VITE_NAKAMA_USE_SSL` — `true` when the page is served over HTTPS and Nakama API is TLS

3. Build locally to verify:

   ```bash
   npm ci
   npm run build
   ```

4. Connect the Git repo to Vercel/Netlify, set the same env vars in the dashboard, root/build directory `frontend`, build command `npm run build`, output `dist`.

5. After deploy, open the **live game URL** and test with two browsers.

## 4. CORS and WebSockets

- Nakama must allow your **frontend origin** for browser calls (see Nakama docs for `socket` / CORS-related settings for your version).
- The reverse proxy must support **WebSocket upgrade** on the same host/port the client uses for the socket.

## 5. URLs to record (for README / submission)

| Item | Your value |
|------|------------|
| **Game URL** | `https://YOUR_GAME_HOST` |
| **Nakama API base** | `https://YOUR_NAKAMA_HOST:PORT` (describe port and TLS in README) |
| **Repository** | `https://github.com/YOU/tic-tac-toe-nakama` (or GitLab) |

## 6. Private room codes (short invite)

Short codes are stored **in memory** on the Nakama process (`bootstrap.lua`). If Nakama restarts, old codes stop working — users can still join with the **full match id**. For production you may replace this with durable storage later.

## 7. Health check

- HTTP: `GET https://YOUR_NAKAMA_HOST/healthcheck` (path may vary slightly by version; confirm in Nakama docs).
