--[[
  Server-authoritative Tic-Tac-Toe. Clients send opcode 1 + JSON { "i": 0..8 }.
  Server broadcasts opcode 2 JSON state. Opcode 3 = error (targeted).
]]

local nk = require("nakama")

local OP_MOVE = 1
local OP_STATE = 2
local OP_ERROR = 3

local TURN_SECONDS = 30
local LB_ID = "tic_tac_toe_score"

local function empty_board()
  return { "", "", "", "", "", "", "", "", "" }
end

local function lines()
  return {
    { 1, 2, 3 },
    { 4, 5, 6 },
    { 7, 8, 9 },
    { 1, 4, 7 },
    { 2, 5, 8 },
    { 3, 6, 9 },
    { 1, 5, 9 },
    { 3, 5, 7 },
  }
end

local function check_winner(board)
  for _, line in ipairs(lines()) do
    local a, b, c = line[1], line[2], line[3]
    local x, y, z = board[a], board[b], board[c]
    if x ~= "" and x == y and y == z then
      return x, { a, b, c }
    end
  end
  local full = true
  for i = 1, 9 do
    if board[i] == "" then
      full = false
      break
    end
  end
  if full then
    return "draw", nil
  end
  return nil, nil
end

local function presence_key(p)
  return p.user_id .. "|" .. p.session_id
end

local function find_presence(state, user_id, session_id)
  for _, p in pairs(state.presences) do
    if p.user_id == user_id and p.session_id == session_id then
      return p
    end
  end
  return nil
end

local function symbol_for(state, user_id)
  return state.player_symbols[user_id]
end

local function now_ms()
  return math.floor(nk.time() / 1000000)
end

local function broadcast_state(dispatcher, state, target_filter)
  local payload = {
    board = state.board,
    current = state.current,
    status = state.status,
    players = {},
    winner_user_id = state.winner_user_id,
    win_line = state.win_line,
    result = state.result,
    timed = state.timed,
    turn_deadline_ms = state.turn_deadline_ms,
    match_started_ms = state.match_started_ms,
    server_now_ms = now_ms(),
    left_user_id = state.left_user_id,
  }
  for uid, sym in pairs(state.player_symbols) do
    local uname = state.usernames[uid] or ""
    table.insert(payload.players, { user_id = uid, username = uname, symbol = sym })
  end
  table.sort(payload.players, function(a, b)
    return (a.symbol or "") < (b.symbol or "")
  end)
  local data = nk.json_encode(payload)
  if target_filter then
    dispatcher.broadcast_message(OP_STATE, data, target_filter, nil, true)
  else
    dispatcher.broadcast_message(OP_STATE, data, nil, nil, true)
  end
end

local function read_stats(user_id)
  local objects = nk.storage_read({ { collection = "tictactoe", key = "stats", user_id = user_id } })
  if not objects or #objects == 0 then
    return { w = 0, l = 0, d = 0, streak = 0, score = 0, play_sec = 0 }
  end
  local v = objects[1].value
  if type(v) == "string" then
    v = nk.json_decode(v)
  end
  return {
    w = tonumber(v.w) or 0,
    l = tonumber(v.l) or 0,
    d = tonumber(v.d) or 0,
    streak = tonumber(v.streak) or 0,
    score = tonumber(v.score) or 0,
    play_sec = tonumber(v.play_sec) or 0,
  }
end

local function write_stats(user_id, stats)
  nk.storage_write({
    {
      collection = "tictactoe",
      key = "stats",
      user_id = user_id,
      value = stats,
      permission_read = 1,
      permission_write = 0,
    },
  })
end

local function leaderboard_sync(user_id)
  local s = read_stats(user_id)
  local acc = nk.users_get_id({ user_id })
  local uname = ""
  if acc and acc[1] then
    uname = acc[1].username or ""
  end
  nk.leaderboard_record_write(LB_ID, user_id, uname, s.score, s.streak, {
    w = s.w,
    l = s.l,
    d = s.d,
    play_sec = s.play_sec,
  }, "set")
end

local function persist_win(winner_uid, loser_uid, duration_sec, fast_finish)
  local w = read_stats(winner_uid)
  w.w = w.w + 1
  w.streak = math.max(0, w.streak) + 1
  local streak_bonus = math.min(w.streak, 5) * 10
  local base = fast_finish and 150 or 200
  w.score = w.score + base + streak_bonus
  w.play_sec = w.play_sec + duration_sec
  write_stats(winner_uid, w)
  leaderboard_sync(winner_uid)

  local l = read_stats(loser_uid)
  l.l = l.l + 1
  l.streak = 0
  l.score = math.max(0, l.score - 30)
  l.play_sec = l.play_sec + duration_sec
  write_stats(loser_uid, l)
  leaderboard_sync(loser_uid)
end

local function persist_draw(uid_a, uid_b, duration_sec)
  for _, uid in ipairs({ uid_a, uid_b }) do
    local s = read_stats(uid)
    s.d = s.d + 1
    s.streak = 0
    s.score = s.score + 40
    s.play_sec = s.play_sec + duration_sec
    write_stats(uid, s)
    leaderboard_sync(uid)
  end
end

local function match_duration_sec(state)
  if not state.match_started_ms then
    return 0
  end
  return math.max(0, math.floor((now_ms() - state.match_started_ms) / 1000))
end

local function finalize_game(state, dispatcher, winner_symbol, win_line, result_kind)
  if state.status == "finished" then
    return
  end
  state.status = "finished"
  state.win_line = win_line
  state.result = result_kind
  local dur = match_duration_sec(state)
  local x_uid, o_uid = state.x_user_id, state.o_user_id
  local is_draw = winner_symbol == "draw"

  if is_draw and x_uid and o_uid then
    state.winner_user_id = nil
    persist_draw(x_uid, o_uid, dur)
  elseif not is_draw and x_uid and o_uid then
    local wuid = winner_symbol == "X" and x_uid or o_uid
    local luid = winner_symbol == "X" and o_uid or x_uid
    state.winner_user_id = wuid
    local fast = result_kind == "forfeit" or result_kind == "timeout"
    persist_win(wuid, luid, dur, fast)
  end

  broadcast_state(dispatcher, state, nil)
end

local function start_turn_timer(state)
  if not state.timed then
    state.turn_deadline_ms = nil
    return
  end
  state.turn_deadline_ms = now_ms() + (TURN_SECONDS * 1000)
end

local function match_init(context, params)
  local timed = params and params.timed == true
  local state = {
    board = empty_board(),
    presences = {},
    player_symbols = {},
    usernames = {},
    join_order = {},
    status = "waiting",
    current = "X",
    winner_user_id = nil,
    win_line = nil,
    result = nil,
    timed = timed,
    turn_deadline_ms = nil,
    match_started_ms = nil,
    x_user_id = nil,
    o_user_id = nil,
    empty_ticks = 0,
    left_user_id = nil,
  }
  local tick_rate = timed and 10 or 5
  local label = timed and "game=tictactoe;mode=timed" or "game=tictactoe;mode=classic"
  return state, tick_rate, label
end

local function match_join_attempt(context, dispatcher, tick, state, presence, metadata)
  local n = 0
  for _ in pairs(state.presences) do
    n = n + 1
  end
  if n >= 2 and not find_presence(state, presence.user_id, presence.session_id) then
    return state, false
  end
  return state, true
end

local function already_in_join_order(state, user_id)
  for _, uid in ipairs(state.join_order) do
    if uid == user_id then
      return true
    end
  end
  return false
end

local function match_join(context, dispatcher, tick, state, presences)
  for _, p in ipairs(presences) do
    state.presences[presence_key(p)] = p
    state.usernames[p.user_id] = p.username or p.user_id
    if not already_in_join_order(state, p.user_id) then
      table.insert(state.join_order, p.user_id)
    end
  end

  if #state.join_order >= 2 and not state.x_user_id then
    state.x_user_id = state.join_order[1]
    state.o_user_id = state.join_order[2]
    state.player_symbols[state.x_user_id] = "X"
    state.player_symbols[state.o_user_id] = "O"
    state.status = "playing"
    state.match_started_ms = now_ms()
    start_turn_timer(state)
  end

  broadcast_state(dispatcher, state, nil)
  return state
end

local function match_leave(context, dispatcher, tick, state, presences)
  if state.status == "finished" then
    for _, p in ipairs(presences) do
      state.presences[presence_key(p)] = nil
    end
    return state
  end

  local left_uid = presences[1] and presences[1].user_id
  for _, p in ipairs(presences) do
    state.presences[presence_key(p)] = nil
  end

  if state.status == "playing" and left_uid then
    local remaining_uid = nil
    for _, p in pairs(state.presences) do
      remaining_uid = p.user_id
      break
    end
    if remaining_uid then
      state.left_user_id = left_uid
      local winner_sym = symbol_for(state, remaining_uid)
      finalize_game(state, dispatcher, winner_sym, nil, "forfeit")
    else
      state.status = "finished"
      state.result = "abandoned"
      broadcast_state(dispatcher, state, nil)
    end
  end

  return state
end

local function apply_move(state, dispatcher, sender_presence, index_1based)
  if state.status ~= "playing" then
    return "not_playing"
  end
  local sym = symbol_for(state, sender_presence.user_id)
  if not sym then
    return "not_in_match"
  end
  if sym ~= state.current then
    return "not_your_turn"
  end
  if index_1based < 1 or index_1based > 9 or state.board[index_1based] ~= "" then
    return "invalid_move"
  end
  state.board[index_1based] = sym
  local w, line = check_winner(state.board)
  if w then
    if w == "draw" then
      finalize_game(state, dispatcher, "draw", nil, "draw")
    else
      finalize_game(state, dispatcher, w, line, "win")
    end
    return nil
  end
  state.current = state.current == "X" and "O" or "X"
  start_turn_timer(state)
  broadcast_state(dispatcher, state, nil)
  return nil
end

local function sender_filter(sender)
  return {
    {
      session_id = sender.session_id,
      node = sender.node,
    },
  }
end

local function match_loop(context, dispatcher, tick, state, messages)
  if state.status == "playing" and state.timed and state.turn_deadline_ms then
    if now_ms() >= state.turn_deadline_ms then
      local loser_sym = state.current
      local winner_sym = loser_sym == "X" and "O" or "X"
      finalize_game(state, dispatcher, winner_sym, nil, "timeout")
      return state
    end
  end

  for _, m in ipairs(messages) do
    if m.op_code == OP_MOVE and m.data and m.sender then
      local ok, decoded = pcall(nk.json_decode, m.data)
      if ok and decoded and decoded.i ~= nil then
        local cell = tonumber(decoded.i)
        if cell ~= nil then
          local idx = cell + 1
          local err = apply_move(state, dispatcher, m.sender, idx)
          if err then
            dispatcher.broadcast_message(OP_ERROR, nk.json_encode({ error = err }), sender_filter(m.sender), nil, true)
          end
        end
      end
    end
  end

  if state.status == "finished" then
    state.empty_ticks = (state.empty_ticks or 0) + 1
    if state.empty_ticks > 30 then
      return nil
    end
  end

  return state
end

local function match_terminate(context, dispatcher, tick, state, grace_seconds)
  return state
end

local function match_signal(context, dispatcher, tick, state, data)
  return state, ""
end

return {
  match_init = match_init,
  match_join_attempt = match_join_attempt,
  match_join = match_join,
  match_leave = match_leave,
  match_loop = match_loop,
  match_terminate = match_terminate,
  match_signal = match_signal,
}
