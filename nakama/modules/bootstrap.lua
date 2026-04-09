--[[
  Registers global leaderboard, matchmaker hook, and RPCs for private rooms + leaderboard fetch.
]]

local nk = require("nakama")

local LB_ID = "tic_tac_toe_score"

local function ensure_leaderboard()
  pcall(function()
    nk.leaderboard_create(LB_ID, true, "desc", "set", "", {}, false)
  end)
end

ensure_leaderboard()

-- Short invite codes -> full match id (in-memory; cleared if Nakama restarts).
local invites = {}

local function gen_invite_code()
  local u = nk.uuid_v4()
  local hex = string.gsub(u, "-", "")
  return string.upper(string.sub(hex, 1, 6))
end

local function matchmaker_matched(context, entries)
  local timed = false
  for _, e in ipairs(entries) do
    local props = e.properties
    if type(props) == "table" and props.mode == "timed" then
      timed = true
      break
    end
  end
  return nk.match_create("tictactoe", { timed = timed })
end

nk.register_matchmaker_matched(matchmaker_matched)

local function rpc_create_private_match(ctx, payload)
  local p = {}
  if payload and #payload > 0 then
    p = nk.json_decode(payload) or {}
  end
  local timed = p.mode == "timed"
  local mid = nk.match_create("tictactoe", { timed = timed })
  local code = gen_invite_code()
  for _ = 1, 24 do
    if not invites[code] then
      break
    end
    code = gen_invite_code()
  end
  invites[code] = mid
  return nk.json_encode({ match_id = mid, invite_code = code })
end

local function rpc_resolve_invite(ctx, payload)
  local p = {}
  if payload and #payload > 0 then
    p = nk.json_decode(payload) or {}
  end
  local code = string.upper(tostring(p.code or ""):gsub("%s+", ""))
  if #code < 4 then
    return nk.json_encode({ ok = false, error = "invalid" })
  end
  local mid = invites[code]
  if not mid then
    return nk.json_encode({ ok = false, error = "not_found" })
  end
  return nk.json_encode({ ok = true, match_id = mid })
end

local function rpc_leaderboard(ctx, payload)
  -- Empty owner list {} means "no owners" — use nil to fetch global top scores (see Nakama Lua API).
  local records, _owner_records = nk.leaderboard_records_list(LB_ID, nil, 10)
  local out = { entries = {} }
  if type(records) ~= "table" then
    return nk.json_encode(out)
  end
  for _, rec in ipairs(records) do
    local md = rec.metadata or {}
    if type(md) == "string" then
      md = nk.json_decode(md) or {}
    end
    table.insert(out.entries, {
      rank = tonumber(rec.rank) or 0,
      username = rec.username or "",
      score = tonumber(rec.score) or 0,
      streak = tonumber(rec.subscore) or 0,
      w = tonumber(md.w) or 0,
      l = tonumber(md.l) or 0,
      d = tonumber(md.d) or 0,
      play_sec = tonumber(md.play_sec) or 0,
    })
  end
  return nk.json_encode(out)
end

nk.register_rpc(rpc_create_private_match, "create_private_match")
nk.register_rpc(rpc_resolve_invite, "resolve_invite")
nk.register_rpc(rpc_leaderboard, "leaderboard")
