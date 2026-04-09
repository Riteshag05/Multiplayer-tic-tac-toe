import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Client, Session, type Socket } from '@heroiclabs/nakama-js'
import './App.css'

const OP_MOVE = 1
const OP_STATE = 2

const DEVICE_KEY = 'ttt_device_id'

type GameMode = 'classic' | 'timed'

interface GamePayload {
  board: string[]
  current: string
  status: string
  players: { user_id: string; username: string; symbol: string }[]
  winner_user_id: string | null
  win_line: number[] | null
  result: string | null
  timed: boolean
  turn_deadline_ms: number | null
  /** Server wall clock (ms) so the client can correct timer display vs local clock skew. */
  server_now_ms?: number | null
  /** User id who disconnected first (forfeit); remaining client can show “opponent left”. */
  left_user_id?: string | null
}

interface LbEntry {
  rank: number
  username: string
  score: number
  streak: number
  w: number
  l: number
  d: number
  play_sec: number
}

function getConfig() {
  const host = import.meta.env.VITE_NAKAMA_HOST ?? '127.0.0.1'
  const port = import.meta.env.VITE_NAKAMA_PORT ?? '7350'
  const serverKey = import.meta.env.VITE_NAKAMA_SERVER_KEY ?? 'defaultkey'
  const useSSL = import.meta.env.VITE_NAKAMA_USE_SSL === 'true'
  return { host, port, serverKey, useSSL }
}

function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return `web-${Math.random().toString(36).slice(2)}`
  }
}

function decodeMatchData(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

function fmtPlay(sec: number): string {
  const m = Math.floor(sec / 60)
  if (m < 1) return '<1m'
  return `${m}m`
}

function shortMatchId(id: string): string {
  const base = id.split('.')[0] ?? id
  return base.slice(-6).toUpperCase()
}

/** Nakama Lua json_encode may send an empty Lua table as JSON `{}` instead of `[]`. */
function coercePlayers(raw: unknown): GamePayload['players'] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw) as GamePayload['players']
  return []
}

function coerceLbEntries(raw: unknown): LbEntry[] {
  if (Array.isArray(raw)) return raw as LbEntry[]
  if (raw && typeof raw === 'object') return Object.values(raw) as LbEntry[]
  return []
}

function parseRpcPayload<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') return raw as T
  return null
}

export default function App() {
  const { host, port, serverKey, useSSL } = getConfig()
  const [nickname, setNickname] = useState('')
  const [screen, setScreen] = useState<'name' | 'lobby' | 'matchmaking' | 'game' | 'result'>('name')
  const [gameMode, setGameMode] = useState<GameMode>('classic')
  const [session, setSession] = useState<Session | null>(null)
  const [socket, setSocket] = useState<Socket | null>(null)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [game, setGame] = useState<GamePayload | null>(null)
  const [mmTicket, setMmTicket] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LbEntry[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [hostCode, setHostCode] = useState<string | null>(null)
  const [hostInviteCode, setHostInviteCode] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [connecting, setConnecting] = useState(false)

  const clientRef = useRef<Client | null>(null)
  const sessionRef = useRef<Session | null>(null)
  /** server_now_ms - Date.now() from last match state (corrects Docker/host clock skew for turn timer). */
  const clockSkewRef = useRef(0)

  useEffect(() => {
    if (!game?.timed || !game.turn_deadline_ms || game.status !== 'playing') return
    const t = window.setInterval(() => setTick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [game?.timed, game?.turn_deadline_ms, game?.status])

  const loadLeaderboard = async (sess: Session, client: Client) => {
    try {
      const res = await client.rpc(sess, 'leaderboard', {})
      let payload: unknown = res.payload
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload) as unknown
        } catch {
          payload = {}
        }
      }
      const entries = (payload as { entries?: unknown } | null)?.entries
      setLeaderboard(coerceLbEntries(entries))
    } catch {
      setLeaderboard([])
    }
  }

  const connectAndAuth = async () => {
    setError(null)
    const name = nickname.trim()
    if (name.length < 2) {
      setError('Pick a nickname (at least 2 characters).')
      return
    }
    setConnecting(true)
    try {
      const client = new Client(serverKey, host, port, useSSL)
      clientRef.current = client
      const sess = await client.authenticateDevice(deviceId(), true, name)
      setSession(sess)
      sessionRef.current = sess

      const sock = client.createSocket(useSSL, false)
      sock.onmatchdata = (md) => {
        if (md.op_code === OP_STATE && md.data) {
          try {
            const p = JSON.parse(decodeMatchData(md.data)) as GamePayload
            p.players = coercePlayers(p.players)
            if (typeof p.server_now_ms === 'number' && Number.isFinite(p.server_now_ms)) {
              clockSkewRef.current = p.server_now_ms - Date.now()
            }
            setGame(p)
            if (p.status === 'finished') {
              setScreen('result')
              const s = sessionRef.current
              const c = clientRef.current
              if (s && c) void loadLeaderboard(s, c)
            }
          } catch {
            /* ignore */
          }
        }
      }

    sock.onmatchmakermatched = async (m) => {
      setMmTicket(null)
      try {
        const mid = m.match_id
        await sock.joinMatch(mid, m.token || undefined)
        setMatchId(mid)
        setScreen('game')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not join match')
        setScreen('lobby')
      }
    }

    sock.ondisconnect = () => {
      setError((prev) => prev ?? 'Disconnected from server')
    }

      await sock.connect(sess, true)
      setSocket(sock)
      setScreen('lobby')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect')
    } finally {
      setConnecting(false)
    }
  }

  const startMatchmaking = async () => {
    if (!socket || !session) return
    setError(null)
    setScreen('matchmaking')
    const mode = gameMode
    const query = `properties.mode:${mode}`
    try {
      const ticket = await socket.addMatchmaker(query, 2, 2, { mode })
      setMmTicket(ticket.ticket)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Matchmaking failed')
      setScreen('lobby')
    }
  }

  const cancelMatchmaking = async () => {
    if (!socket || !mmTicket) {
      setScreen('lobby')
      return
    }
    try {
      await socket.removeMatchmaker(mmTicket)
    } catch {
      /* ignore */
    }
    setMmTicket(null)
    setScreen('lobby')
  }

  const createPrivateRoom = async () => {
    if (!socket || !session || !clientRef.current) return
    setError(null)
    try {
      const res = await clientRef.current.rpc(session, 'create_private_match', { mode: gameMode })
      const body = parseRpcPayload<{ match_id?: string; invite_code?: string }>(res.payload)
      const mid = body?.match_id
      if (!mid) throw new Error('No match id from server')
      await socket.joinMatch(mid)
      setHostCode(mid)
      setHostInviteCode(body?.invite_code ?? null)
      setMatchId(mid)
      setScreen('game')
      try {
        await navigator.clipboard.writeText(body?.invite_code ?? mid)
      } catch {
        /* clipboard optional */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create room')
    }
  }

  const joinPrivateRoom = async () => {
    if (!socket || !session || !clientRef.current || !joinCode.trim()) return
    setError(null)
    const raw = joinCode.trim()
    try {
      let mid = raw
      if (!raw.includes('.')) {
        const res = await clientRef.current.rpc(session, 'resolve_invite', { code: raw })
        const body = parseRpcPayload<{ ok?: boolean; match_id?: string; error?: string }>(res.payload)
        if (!body?.ok || !body.match_id) {
          throw new Error(body?.error === 'not_found' ? 'Room code not found or server was restarted.' : 'Could not resolve room code.')
        }
        mid = body.match_id
      }
      await socket.joinMatch(mid)
      setMatchId(mid)
      setHostCode(null)
      setHostInviteCode(null)
      setScreen('game')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join room')
    }
  }

  const sendMove = async (index0: number) => {
    if (!socket || !matchId || !game || game.status !== 'playing') return
    const payload = JSON.stringify({ i: index0 })
    await socket.sendMatchState(matchId, OP_MOVE, payload)
  }

  const leaveMatch = useCallback(async () => {
    if (socket && matchId) {
      try {
        await socket.leaveMatch(matchId)
      } catch {
        /* ignore */
      }
    }
    setMatchId(null)
    setGame(null)
    setHostCode(null)
    setHostInviteCode(null)
    setScreen('lobby')
  }, [socket, matchId])

  const playAgain = () => {
    setGame(null)
    setMatchId(null)
    setHostCode(null)
    setHostInviteCode(null)
    setScreen('lobby')
  }

  const secondsLeft = useMemo(() => {
    void tick
    if (!game?.timed || !game.turn_deadline_ms || game.status !== 'playing') return null
    const skew = clockSkewRef.current
    return Math.max(0, Math.ceil((game.turn_deadline_ms - Date.now() - skew) / 1000))
  }, [game, tick])

  const leaderboardRows = useMemo(() => coerceLbEntries(leaderboard), [leaderboard])

  const myId = session?.user_id
  const myPlayer = game?.players.find((p) => p.user_id === myId)
  const opp = game?.players.find((p) => p.user_id !== myId)
  const currentTurnPlayer =
    game?.status === 'playing' ? game.players.find((p) => p.symbol === game.current) : undefined

  const resultLabel = () => {
    if (!game || !myId) return ''
    if (game.result === 'draw') return 'Draw — good game!'
    if (
      game.result === 'forfeit' &&
      game.winner_user_id === myId &&
      game.left_user_id &&
      opp &&
      game.left_user_id === opp.user_id
    ) {
      return 'WINNER! Opponent left the room.'
    }
    if (game.result === 'timeout' && game.winner_user_id === myId) return 'WINNER! Opponent ran out of time.'
    if (game.winner_user_id === myId) return 'WINNER! +200 pts'
    if (game.winner_user_id) return 'You lost — rematch?'
    if (game.result === 'timeout') return 'Defeat — time ran out'
    return 'Game over'
  }

  const resultSymbol = () => {
    if (!game || !myId) return '—'
    if (game.result === 'draw') return '='
    if (game.winner_user_id === myId) return myPlayer?.symbol ?? '★'
    return opp?.symbol ?? '—'
  }

  return (
    <div className="app">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {screen === 'name' && (
        <div className="screen screen--name">
          <h1 className="title">Who are you?</h1>
          <p className="muted">Choose a nickname. It is stored on this device only (like a guest badge at a café).</p>
          <input
            className="field"
            placeholder="Nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={20}
            autoComplete="off"
          />
          <div className="row-actions">
            <button type="button" className="btn btn-primary" disabled={connecting} onClick={() => void connectAndAuth()}>
              {connecting ? 'Connecting…' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {screen === 'lobby' && session && (
        <div className="screen">
          <h1 className="title">Play</h1>
          <p className="muted">Hi {session.username}. Pick a mode, then find a random opponent or use a private room.</p>
          <div className="mode-row">
            <button
              type="button"
              className={`mode-btn ${gameMode === 'classic' ? 'active' : ''}`}
              onClick={() => setGameMode('classic')}
            >
              Classic
            </button>
            <button
              type="button"
              className={`mode-btn ${gameMode === 'timed' ? 'active' : ''}`}
              onClick={() => setGameMode('timed')}
            >
              Timed (30s / move)
            </button>
          </div>
          <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={() => void startMatchmaking()}>
            Find random player
          </button>

          <div className="private-box">
            <h3>Private room</h3>
            <p className="muted" style={{ margin: 0 }}>
              Host gets a short <strong>room code</strong> (easy to type). Guest enters the code or the full match id if needed.
            </p>
            <button type="button" className="btn btn-ghost" style={{ width: '100%', marginTop: '0.75rem' }} onClick={() => void createPrivateRoom()}>
              Create room &amp; copy code
            </button>
            <div className="private-row">
              <input
                className="field"
                placeholder="Room code (e.g. A1B2C3) or full match id"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
              <button type="button" className="btn btn-primary" onClick={() => void joinPrivateRoom()}>
                Join
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === 'matchmaking' && (
        <div className="screen" style={{ justifyContent: 'center' }}>
          <p className="mm-title">Finding a random player…</p>
          <p className="muted" style={{ textAlign: 'center' }}>
            Usually under half a minute. Open a second browser (or incognito) with another nickname to test quickly — like
            two friends waiting at different bus stops for the same bus.
          </p>
          <button type="button" className="btn btn-ghost" style={{ alignSelf: 'center' }} onClick={() => void cancelMatchmaking()}>
            Cancel
          </button>
        </div>
      )}

      {screen === 'game' && matchId && (
        <div className="screen">
          <div className="game-header">
            <span>
              {(myPlayer?.username ?? 'You').toUpperCase()}
              {myPlayer ? ` (you) · ${myPlayer.symbol}` : ''}
            </span>
            <span>{opp ? `${opp.username.toUpperCase()} (opp) · ${opp.symbol}` : '…'}</span>
          </div>
          {hostCode && (
            <div className="invite-strip">
              <div className="invite-strip-label">Share room</div>
              <div className="invite-code">{hostInviteCode ?? hostCode}</div>
              <div className="invite-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-compact"
                  onClick={() =>
                    void navigator.clipboard.writeText(hostInviteCode ?? hostCode).catch(() => undefined)
                  }
                >
                  {hostInviteCode ? 'Copy room code' : 'Copy match id'}
                </button>
                {hostInviteCode && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={() => void navigator.clipboard.writeText(hostCode).catch(() => undefined)}
                  >
                    Copy full id
                  </button>
                )}
              </div>
              <p className="invite-hint muted">
                {hostInviteCode
                  ? 'Friend enters the 6-character code on the home screen (or full id after a server restart).'
                  : 'Share this full id with your friend to join.'}
              </p>
            </div>
          )}
          <div className="game-surface">
            {game?.status === 'waiting' && <p className="turn-pill">Waiting for opponent…</p>}
            {game?.status === 'playing' && (
              <>
                <div className="turn-pill">
                  {currentTurnPlayer ? (
                    <>
                      <span className="turn-name">{currentTurnPlayer.username}</span>
                      <span className="turn-rest">to move</span>
                      <span className="turn-badge">({currentTurnPlayer.symbol})</span>
                    </>
                  ) : (
                    <>
                      <span className="turn-symbol">{game.current}</span>
                      <span>to move</span>
                    </>
                  )}
                  {secondsLeft != null && <span className="timer">{secondsLeft}s</span>}
                </div>
                <div className="board">
                  {(() => {
                    const cells = [...(game.board ?? [])]
                    while (cells.length < 9) cells.push('')
                    return cells
                  })().map((mark, i) => {
                    const winIdx =
                      game.win_line?.map((c) => c - 1) ?? []
                    const isWin = winIdx.includes(i)
                    const sym = mark
                    const disabled =
                      game.status !== 'playing' ||
                      sym !== '' ||
                      !myPlayer ||
                      myPlayer.symbol !== game.current
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`cell ${sym === 'X' ? 'x' : ''} ${sym === 'O' ? 'o' : ''} ${isWin ? 'win' : ''}`}
                        disabled={disabled}
                        onClick={() => void sendMove(i)}
                      >
                        {sym}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          <div className="leave-bar">
            <button type="button" className="leave-btn" onClick={() => void leaveMatch()}>
              Leave room ({shortMatchId(matchId)})
            </button>
          </div>
        </div>
      )}

      {screen === 'result' && game && (
        <div className="screen">
          <div className="result-hero">
            <div className="result-symbol">{resultSymbol()}</div>
            <p className="result-title">{resultLabel()}</p>
          </div>
          <h2 className="lb-title">Leaderboard</h2>
          <table className="lb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>W/L/D</th>
                <th>Time</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {leaderboardRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No rows yet — play a ranked game first.
                  </td>
                </tr>
              )}
              {leaderboardRows.map((row) => (
                <tr key={`${row.rank}-${row.username}`}>
                  <td className="lb-rank">{row.rank}.</td>
                  <td>
                    {row.username}
                    {row.username === session?.username ? ' (you)' : ''}
                  </td>
                  <td>
                    {row.w}/{row.l}/{row.d}
                  </td>
                  <td>{fmtPlay(row.play_sec)}</td>
                  <td>{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-outline" style={{ width: '100%', marginTop: '1rem' }} onClick={playAgain}>
            Play again
          </button>
        </div>
      )}
    </div>
  )
}
