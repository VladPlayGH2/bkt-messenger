const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool, types } = require("pg");
types.setTypeParser(20, value => Number(value));
const { WebSocketServer } = require("ws");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const webpush = require("web-push");

const PHONE_EXEMPTIONS = new Set(["79537977093", "89132069070"]);
const BANNED_USERNAME_TERMS = [
  "жоп", "жопа", "жопочка", "хуй", "хуя", "хуе", "хуё", "хую", "хуйня",
  "пизд", "пизда", "пиздец", "бляд", "блять", "бля", "блядин", "еб", "ёб",
  "еба", "ебан", "ебат", "ебл", "манда", "манд", "сук", "сука", "шлюх",
  "гандон", "мудак", "долбо", "пидор", "педик", "тварь", "доксер", "доксинг",
  "хакер", "твоямама", "твойпапа", "твоябабушка", "твойбабушка", "твойдедушка", "твойдядя",
  "blyad", "blyat", "bljad", "pizd", "hui", "xui", "ebat", "eblan", "suka", "suk",
  "zhopa", "zhopochka", "mand", "shluha"
];
function normalizePhone(v) {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") return "7" + digits.slice(1);
  return digits;
}
function isNumericOnlyUsername(v) { return /^\d+$/.test(String(v || "").trim().replace(/^@+/, "")); }
function usernameSimilarityKey(v) {
  return String(v || "")
    .trim().replace(/^@+/, "").toLowerCase()
    .replace(/[\u0430\u0430]/g, "a").replace(/[\u0431]/g, "b").replace(/[\u0432]/g, "v")
    .replace(/[\u0435\u0451]/g, "e").replace(/[\u043a]/g, "k").replace(/[\u043c]/g, "m")
    .replace(/[\u043d]/g, "n").replace(/[\u043e]/g, "o").replace(/[\u0440]/g, "p")
    .replace(/[\u0441]/g, "c").replace(/[\u0442]/g, "t").replace(/[\u0445]/g, "x")
    .replace(/[\u0443]/g, "y").replace(/[\u0433]/g, "g").replace(/[\u043b]/g, "l")
    .replace(/[\u043f]/g, "p").replace(/[\u0438]/g, "i").replace(/[\u0439]/g, "i")
    .replace(/[\u044c\u044a]/g, "").replace(/[\u0456]/g, "i").replace(/[\u0455]/g, "s")
    .replace(/[\u00f0]/g, "d").replace(/[\u00fe]/g, "th").replace(/[\u0131]/g, "i")
}
const RESERVED_USERNAME_KEYS = new Set([
  usernameSimilarityKey("Premium_бот"),
  usernameSimilarityKey("Premium_bot"),
  usernameSimilarityKey("Premiumбот"),
  usernameSimilarityKey("Premiumbot")
]);
function isBannedUsername(v) {
  const u = String(v || "").trim().replace(/^@+/, "").toLowerCase().replace(/[\s._-]+/g, "");
  if (!u) return false;
  if (isNumericOnlyUsername(u)) return true;
  return BANNED_USERNAME_TERMS.some(term => u.includes(term));
}
function validateUsername(v) {
  const u = String(v || "").trim().replace(/^@+/, "");
  if (!u) return "Введите логин";
  if (u.length < 3 || u.length > 32) return "Логин должен быть от 3 до 32 символов";
  if (!/^[A-Za-zА-Яа-яЁё0-9_]+$/.test(u)) return "Логин может содержать буквы, цифры и _";
  if (isNumericOnlyUsername(u)) return "Логин только из цифр запрещён";
  if (RESERVED_USERNAME_KEYS.has(usernameSimilarityKey(u))) return "Этот логин зарезервирован";
  if (isBannedUsername(u)) return "Этот логин запрещён";
  return null;
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Create a PostgreSQL database on Render and add its Internal Database URL to the Web Service environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 15),
  min: Number(process.env.PG_POOL_MIN || 1),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});
pool.on("error", err => console.error("PostgreSQL pool error:", err));

function isTransientDbError(e) {
  const code = String(e?.code || "");
  return ["ECONNRESET","ECONNREFUSED","ETIMEDOUT","57P01","57P02","57P03","53300","08000","08003","08006","08001","08004","08007","08006"].includes(code);
}
async function query(text, params = []) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await pool.query(text, params); }
    catch (e) {
      last = e;
      if (!isTransientDbError(e) || attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  throw last;
}
async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}
async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}
async function ensureCommunityGroup() {
  // System group: every registered user is a member, but only Brozi and Vlad may post.
  let group = await one("SELECT id, name, owner_id FROM groups WHERE name=$1 ORDER BY id LIMIT 1", ["БКТ Сообщество"]);
  if (!group) {
    const owner = await one("SELECT id FROM users WHERE LOWER(username) IN ('brozi','vlad') ORDER BY CASE WHEN LOWER(username)='brozi' THEN 0 ELSE 1 END, id LIMIT 1")
      || await one("SELECT id FROM users ORDER BY id LIMIT 1");
    if (!owner) return null;
    group = await one("INSERT INTO groups(name,owner_id) VALUES($1,$2) RETURNING id,name,owner_id", ["БКТ Сообщество", owner.id]);
  }
  await query(`INSERT INTO group_members(group_id,user_id,role)
    SELECT $1, u.id, CASE WHEN LOWER(u.username)='brozi' OR LOWER(u.username)='vlad' THEN 'admin' ELSE 'member' END
    FROM users u
    ON CONFLICT(group_id,user_id) DO NOTHING`, [group.id]);
  return group;
}

async function addUserToCommunityGroup(userId) {
  const group = await ensureCommunityGroup();
  if (!group) return;
  const user = await one("SELECT id,username FROM users WHERE id=$1", [userId]);
  if (!user) return;
  await query(`INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,$3)
    ON CONFLICT(group_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [group.id, user.id, ['brozi','vlad'].includes(String(user.username).toLowerCase()) ? 'admin' : 'member']);
}

async function isCommunityGroup(groupId) {
  return !!(await one("SELECT 1 FROM groups WHERE id=$1 AND name=$2", [Number(groupId), "БКТ Сообщество"]));
}

function canPostInCommunity(username) {
  return ['brozi', 'vlad'].includes(String(username || '').trim().replace(/^@+/, '').toLowerCase());
}

function canManageAccounts(username) {
  return ['brozi', 'vlad'].includes(normalizeUsername(username));
}

const BOT_USERNAME = "BKT_Bot";
let botUserId = 0;
let botLastSeenAt = 0;
async function getAdminSetting(key, fallback) {
  const row = await one("SELECT value FROM admin_settings WHERE key=$1", [String(key)]).catch(()=>null);
  return row?.value ?? fallback;
}
function settingNumber(value, fallback, min=0, max=1000000) { const n=Number(value); return Number.isFinite(n) ? Math.min(max,Math.max(min,n)) : fallback; }
function makeReferralCode() { return crypto.randomBytes(6).toString("base64url"); }
async function ensureReferralCode(userId) {
  const row = await one("SELECT referral_code FROM users WHERE id=$1", [Number(userId)]);
  if (row?.referral_code) return row.referral_code;
  for (let i=0;i<5;i++) {
    const code=makeReferralCode();
    try {
      const updated=await one("UPDATE users SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code",[code,Number(userId)]);
      if(updated?.referral_code) return updated.referral_code;
    } catch(e) { if(e.code!=="23505") throw e; }
  }
  throw new Error("Не удалось создать реферальный код");
}
async function rewardReferralOnRegistration(referredUserId, rawCode) {
  const code=String(rawCode||"").trim(), referredId=Number(referredUserId);
  if(!code||!referredId) return {applied:false,reason:"no-code"};
  const referralReward=settingNumber(await getAdminSetting("sartsna.referral_reward","50"),50);
  const milestoneReward=settingNumber(await getAdminSetting("sartsna.referral_milestone_reward","150"),150);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const referrer=await client.query("SELECT id FROM users WHERE referral_code=$1 LIMIT 1",[code]);
    if(!referrer.rows[0] || Number(referrer.rows[0].id)===referredId){ await client.query("ROLLBACK"); return {applied:false,reason:"invalid-code"}; }
    const inserted=await client.query(`INSERT INTO referrals(referrer_id,referred_user_id,referral_code) VALUES($1,$2,$3) ON CONFLICT(referred_user_id) DO NOTHING RETURNING id`,[Number(referrer.rows[0].id),referredId,code]);
    if(!inserted.rows[0]){ await client.query("ROLLBACK"); return {applied:false,reason:"already-attributed"}; }
    await client.query(`INSERT INTO reward_wallets(user_id,oranges) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET oranges=reward_wallets.oranges+$2,updated_at=NOW()`,[referredId,referralReward]);
    const countRes=await client.query("SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id=$1",[Number(referrer.rows[0].id)]);
    const count=Number(countRes.rows[0].count||0), milestone=count%3===0;
    if(milestone) await client.query(`INSERT INTO reward_wallets(user_id,oranges) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET oranges=reward_wallets.oranges+$2,updated_at=NOW()`,[Number(referrer.rows[0].id),milestoneReward]);
    await client.query("COMMIT");
    const referredWallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[referredId]);
    await query(`INSERT INTO orange_transactions(user_id,amount,balance_after,type,description,metadata) VALUES($1,$2,$3,'referral','Бонус за регистрацию по приглашению',$4)`,[referredId,referralReward,Number(referredWallet?.oranges||0),JSON.stringify({referrerId:Number(referrer.rows[0].id)})]);
    if(milestone){ const refWallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[Number(referrer.rows[0].id)]); await query(`INSERT INTO orange_transactions(user_id,amount,balance_after,type,description,metadata) VALUES($1,$2,$3,'referral_milestone','Бонус за 3 приглашённых',$4)`,[Number(referrer.rows[0].id),milestoneReward,Number(refWallet?.oranges||0),JSON.stringify({count})]); }
    await checkOrangeAchievements(referredId); await checkOrangeAchievements(Number(referrer.rows[0].id));
    push(referredId,{type:"referral-reward",oranges:referralReward,referred:true});
    if(milestone) push(Number(referrer.rows[0].id),{type:"referral-reward",oranges:milestoneReward,referrals:count});
    return {applied:true,count,milestone};
  } catch(e){ try{await client.query("ROLLBACK")}catch(_){} console.error("Referral reward error:",e); return {applied:false,reason:"server-error"}; }
  finally{client.release();}
}
async function ensureBotAccount() {
  try {
    let row=await one("SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1",[BOT_USERNAME]);
    if(!row){ const passwordHash=await bcrypt.hash(crypto.randomBytes(24).toString("hex"),10); row=await one(`INSERT INTO users(username,password_hash,avatar,is_bot,referral_code) VALUES($1,$2,$3,TRUE,$4) RETURNING id`,[BOT_USERNAME,passwordHash,"/stickers/1.webp",makeReferralCode()]); await ensureRewardWallet(row.id); }
    else { await query("UPDATE users SET is_bot=TRUE WHERE id=$1",[Number(row.id)]); await ensureReferralCode(row.id); }
    botUserId=Number(row.id); botHeartbeat();
  } catch(e){ console.error("Bot account init error:",e); }
}
function botHeartbeat(){ if(!botUserId)return; botLastSeenAt=Date.now(); broadcastPresence(botUserId,true); }

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bio TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
      block_reason TEXT NOT NULL DEFAULT '',
      last_login_ip TEXT
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;

    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      referral_code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, created_at);

    CREATE TABLE IF NOT EXISTS deleted_usernames (
      username TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_banned_phones (
      phone TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT 'automatic threat moderation',
      banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      caller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      callee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_type TEXT NOT NULL,
      offer_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ringing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS answer_json TEXT;

    CREATE TABLE IF NOT EXISTS call_ice_candidates (
      id BIGSERIAL PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      candidate_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_call_ice_call ON call_ice_candidates(call_id, id);

    CREATE TABLE IF NOT EXISTS groups (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_messages (
      id BIGSERIAL PRIMARY KEY,
      group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS verified_users (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS statuses (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      media_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id <> blocked_id)
    );

    CREATE TABLE IF NOT EXISTS reward_wallets (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      oranges INTEGER NOT NULL DEFAULT 0 CHECK (oranges >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orange_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orange_transactions_user ON orange_transactions(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS daily_orange_bonus (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bonus_date DATE NOT NULL,
      amount INTEGER NOT NULL,
      streak_day INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, bonus_date)
    );
    ALTER TABLE daily_orange_bonus ADD COLUMN IF NOT EXISTS streak_day INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS user_profile_frames (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      frame_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orange_achievements (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🍊',
      badge TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS user_orange_achievements (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_key TEXT NOT NULL REFERENCES orange_achievements(key) ON DELETE CASCADE,
      obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, achievement_key)
    );

    CREATE TABLE IF NOT EXISTS orange_shop_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🍊',
      price INTEGER NOT NULL CHECK(price >= 0),
      item_type TEXT NOT NULL DEFAULT 'badge',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_orange_items (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES orange_shop_items(id) ON DELETE CASCADE,
      obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS user_profile_badges (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      badge_type TEXT NOT NULL,
      badge_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS captcha_challenges (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      referral_code TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS phone_verifications (
      token TEXT PRIMARY KEY,
      phone TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS user_stickers (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sticker_id INTEGER NOT NULL,
      obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, sticker_id)
    );

    CREATE TABLE IF NOT EXISTS profile_gifts (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sticker_id INTEGER NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, sticker_id)
    );

    ALTER TABLE phone_verifications ADD COLUMN IF NOT EXISTS referral_code TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_user_id BIGINT,
      target_username TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      jti TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions(ip);

    CREATE TABLE IF NOT EXISTS admin_ip_bans (
      id BIGSERIAL PRIMARY KEY,
      ip TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL,
      message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, id);
    CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_call_sessions_callee_status ON call_sessions(callee_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_statuses_expires ON statuses(expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id, blocked_id);
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id, blocker_id);
    CREATE INDEX IF NOT EXISTS idx_captcha_user ON captcha_challenges(user_id, expires_at);
  `);

  for (const protectedName of ["brozi", "vlad", "vladmobile", "premium_бот"]) {
    const account = await one("SELECT id FROM users WHERE LOWER(username)=LOWER($1)", [protectedName]);
    if (account) {
      await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [account.id]);
    }
  }
  await query("ALTER TABLE statuses ADD COLUMN IF NOT EXISTS media_url TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS block_reason TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT");
  // Message feature migrations (safe for existing databases).
  await query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL");
  await query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ");
  await query(`CREATE TABLE IF NOT EXISTS message_reactions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(message_id,user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS message_favorites (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,message_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS message_pins (
    message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)");
  await query("CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id)");
  await query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  await query("DROP INDEX IF EXISTS idx_users_email_lower");
  await query("ALTER TABLE users DROP COLUMN IF EXISTS email");
  await query("ALTER TABLE phone_verifications DROP COLUMN IF EXISTS email");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL");
  await query("CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, sender_id, read_at, id)");
  await seedOrangeSystem();
  await cleanupInvalidUsers();
  await ensureCommunityGroup();
  await ensureSpecialAccountsRewards();
}

async function cleanupInvalidUsers() {
  await query(`DELETE FROM users WHERE LOWER(username)=LOWER('жопочка') OR username ~ '^[0-9]+$'`);
}
async function sendVerificationCode(phone, code) {
  const webhook = process.env.SMS_WEBHOOK_URL;
  if (webhook) {
    const r = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: phone, code, message: `Код подтверждения БКТ: ${code}` }) });
    if (!r.ok) throw new Error("SMS provider error");
    return;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (sid && token && from) {
    const body = new URLSearchParams({ To: phone, From: from, Body: `Код подтверждения БКТ: ${code}` });
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body });
    if (!r.ok) throw new Error("Twilio SMS error");
    return;
  }
  if (process.env.NODE_ENV !== "production") { console.log(`[DEV OTP] ${phone}: ${code}`); return; }
  throw new Error("SMS-провайдер не настроен");
}
function phoneExempt(phone) { return PHONE_EXEMPTIONS.has(normalizePhone(phone)); }

const protectedAccess = JSON.parse(fs.readFileSync(path.join(__dirname, "protected-access.json"), "utf8"));
function protectedAccount(username) {
  const key = String(username || "").trim().replace(/^@+/, "").toLowerCase();
  return protectedAccess.accounts?.[key] || null;
}
function verifyProtectedCode(username, code) {
  const entry = protectedAccount(username);
  if (!entry) return true;
  const raw = Buffer.from(String(code || ""), "utf8");
  const salt = Buffer.from(entry.salt, "hex");
  const derived = crypto.scryptSync(raw, salt, 32);
  const expected = Buffer.from(entry.hash, "hex");
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}
function protectedError(username) {
  const display = protectedAccount(username)?.display || username;
  return `Для аккаунта ${display} нужен специальный код`;
}

const REWARD_STICKER_ID = 29;
const REWARD_STICKER_SRC = `/stickers/${REWARD_STICKER_ID}.webp`;
const REWARD_STICKER_150_ID = 30;
const REWARD_STICKER_150_SRC = `/stickers/${REWARD_STICKER_150_ID}.webp`;
const REWARD_STICKER_300_ID = 31;
const REWARD_STICKER_300_SRC = `/stickers/${REWARD_STICKER_300_ID}.webp`;
const REWARD_STICKER_IDS = [REWARD_STICKER_ID, REWARD_STICKER_150_ID, REWARD_STICKER_300_ID];
const GIFT_CATALOG = [
  { stickerId: 29, price: 50, name: 'Капибара', src: '/stickers/29.webp' },
  { stickerId: 30, price: 150, name: 'Королевская капибара', src: '/stickers/30.webp' },
  { stickerId: 31, price: 300, name: 'БКТ — Капибара и Туф', src: '/stickers/31.webp' }
];
const GIFT_PRICES = Object.fromEntries(GIFT_CATALOG.map(g => [g.stickerId, g.price]));

const ORANGE_FRAME_SRC = "/orange-frames/capybara-orange.png";
const ORANGE_SHOP = [
  { id: "orange_badge", name: "Значок 🍊", description: "Профильный значок за апельсины.", icon: "🍊", price: 100, itemType: "badge" },
  { id: "gold_orange_badge", name: "Золотой апельсин", description: "Редкий золотой значок профиля.", icon: "🌟🍊", price: 250, itemType: "badge" },
  { id: "citrus_title", name: "Титул «Цитрус»", description: "Особый предмет коллекции.", icon: "🍊✨", price: 500, itemType: "title" },
  { id: "capybara_orange_frame", name: "Рамка «Апельсиновая капибара»", description: "Профильная рамка с апельсинами и капибарой.", icon: "🖼️🍊", price: 350, itemType: "frame" }
];
const ORANGE_ACHIEVEMENTS = [
  { key:"first_orange", name:"Первый апельсин", description:"Получи свой первый 🍊.", icon:"🍊", badge:"🍊", sortOrder:1 },
  { key:"daily_7", name:"Апельсиновая неделя", description:"Получи ежедневный бонус 7 раз.", icon:"📅", badge:"🍊7", sortOrder:2 },
  { key:"orange_100", name:"Апельсиновый запас", description:"Накопи 100 🍊.", icon:"🧺", badge:"🍊100", sortOrder:3 },
  { key:"orange_500", name:"Цитрусовый магнат", description:"Накопи 500 🍊.", icon:"👑", badge:"🍊500", sortOrder:4 },
  { key:"three_referrals", name:"Апельсиновый друг", description:"Пригласи 3 друзей.", icon:"👥", badge:"🍊×3", sortOrder:5 },
  { key:"shop_purchase", name:"Покупатель БКТ", description:"Купи предмет в магазине.", icon:"🛍️", badge:"🛍️", sortOrder:6 }
];
async function seedOrangeSystem(){
  for(const a of ORANGE_ACHIEVEMENTS){
    await query(`INSERT INTO orange_achievements(key,name,description,icon,badge,sort_order) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,icon=EXCLUDED.icon,badge=EXCLUDED.badge,sort_order=EXCLUDED.sort_order`,[a.key,a.name,a.description,a.icon,a.badge,a.sortOrder]);
  }
  for(const item of ORANGE_SHOP){
    await query(`INSERT INTO orange_shop_items(id,name,description,icon,price,item_type) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,icon=EXCLUDED.icon,price=EXCLUDED.price,item_type=EXCLUDED.item_type`,[item.id,item.name,item.description,item.icon,item.price,item.itemType]);
  }
}
async function recordOrangeTransaction(userId, amount, type, description, metadata={}){
  const wallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[Number(userId)]);
  await query(`INSERT INTO orange_transactions(user_id,amount,balance_after,type,description,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[Number(userId),Number(amount),Number(wallet?.oranges||0),String(type),String(description||""),JSON.stringify(metadata||{})]);
}
async function addOranges(userId, amount, type, description, metadata={}){
  const n=Math.trunc(Number(amount));
  if(!Number.isFinite(n)||n<=0) throw new Error("Некорректное количество апельсинов");
  await ensureRewardWallet(userId);
  const wallet=await one(`UPDATE reward_wallets SET oranges=oranges+$2,updated_at=NOW() WHERE user_id=$1 RETURNING oranges`,[Number(userId),n]);
  const balance=Number(wallet.oranges);
  await query(`INSERT INTO orange_transactions(user_id,amount,balance_after,type,description,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[Number(userId),n,balance,String(type),String(description||""),JSON.stringify(metadata||{})]);
  await checkOrangeAchievements(userId);
  return balance;
}
async function spendOranges(userId, amount, type, description, metadata={}){
  const n=Math.trunc(Number(amount));
  if(!Number.isFinite(n)||n<=0) throw new Error("Некорректная стоимость");
  const wallet=await one(`UPDATE reward_wallets SET oranges=oranges-$2,updated_at=NOW() WHERE user_id=$1 AND oranges >= $2 RETURNING oranges`,[Number(userId),n]);
  if(!wallet) return null;
  const balance=Number(wallet.oranges);
  await query(`INSERT INTO orange_transactions(user_id,amount,balance_after,type,description,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[Number(userId),-n,balance,String(type),String(description||""),JSON.stringify(metadata||{})]);
  await checkOrangeAchievements(userId);
  return balance;
}
async function checkOrangeAchievements(userId){
  try{
    const id=Number(userId), wallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[id]);
    const oranges=Number(wallet?.oranges||0);
    const grants=[];
    if(oranges>=1) grants.push("first_orange");
    if(oranges>=100) grants.push("orange_100");
    if(oranges>=500) grants.push("orange_500");
    const ref=await one("SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id=$1",[id]).catch(()=>({count:0}));
    if(Number(ref?.count||0)>=3) grants.push("three_referrals");
    const daily=await one("SELECT COUNT(*)::int AS count FROM daily_orange_bonus WHERE user_id=$1",[id]).catch(()=>({count:0}));
    if(Number(daily?.count||0)>=7) grants.push("daily_7");
    const purchase=await one("SELECT 1 FROM user_orange_items WHERE user_id=$1 LIMIT 1",[id]).catch(()=>null);
    if(purchase) grants.push("shop_purchase");
    for(const key of grants){
      const row=await one(`INSERT INTO user_orange_achievements(user_id,achievement_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING achievement_key`,[id,key]);
      if(row) push(id,{type:"orange-achievement",achievement:key});
    }
  }catch(e){ console.error("Orange achievement check error:",e); }
}
async function getDailyOrangeStatus(userId){
  const id=Number(userId);
  const today=await one("SELECT bonus_date,amount,streak_day,claimed_at FROM daily_orange_bonus WHERE user_id=$1 AND bonus_date=CURRENT_DATE",[id]);
  const latest=await one("SELECT bonus_date,streak_day FROM daily_orange_bonus WHERE user_id=$1 ORDER BY bonus_date DESC LIMIT 1",[id]);
  if(today) return {
    claimed:true,
    amount:Number(today.amount||0),
    streakDay:Number(today.streak_day||0),
    claimedAt:today.claimed_at
  };
  let nextDay=1;
  if(latest){
    const last=String(latest.bonus_date).slice(0,10);
    const now=new Date();
    const todayUtc=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    const lastDate=new Date(last+"T00:00:00Z");
    const diff=Math.round((todayUtc-lastDate)/86400000);
    if(diff===1) nextDay=(Number(latest.streak_day||0)%20)+1;
  }
  return {claimed:false,amount:5+nextDay,streakDay:nextDay,claimedAt:null};
}
async function claimDailyOrangeBonus(userId){
  const id=Number(userId);
  await ensureRewardWallet(id);
  const status=await getDailyOrangeStatus(id);
  if(status.claimed) return {claimed:false,amount:0,streakDay:status.streakDay};
  const inserted=await one(
    `INSERT INTO daily_orange_bonus(user_id,bonus_date,amount,streak_day)
     VALUES($1,CURRENT_DATE,$2,$3)
     ON CONFLICT DO NOTHING
     RETURNING bonus_date,amount,streak_day,claimed_at`,
    [id,status.amount,status.streakDay]
  );
  if(!inserted) return {claimed:false,amount:0,streakDay:status.streakDay};
  const balance=await addOranges(
    id,
    Number(inserted.amount),
    "daily_bonus",
    `Ежедневный бонус · день ${Number(inserted.streak_day)}/20`,
    {date:String(inserted.bonus_date),streakDay:Number(inserted.streak_day),cycleLength:20}
  );
  return {
    claimed:true,
    amount:Number(inserted.amount),
    streakDay:Number(inserted.streak_day),
    balance,
    claimedAt:inserted.claimed_at
  };
}
async function ensureRewardWallet(userId) {
  await query(`INSERT INTO reward_wallets(user_id,oranges) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`, [Number(userId)]);
}
async function grantRewardSticker(userId, stickerId, addToProfile=false) {
  const sid = Number(stickerId);
  if (!REWARD_STICKER_IDS.includes(sid)) return;
  await query(`INSERT INTO user_stickers(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [Number(userId), sid]);
  if (addToProfile) await query(`INSERT INTO profile_gifts(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [Number(userId), sid]);
}
async function grantRewardsForBalance(userId, addToProfile=false) {
  await ensureRewardWallet(userId);
  const wallet = await one("SELECT oranges FROM reward_wallets WHERE user_id=$1", [Number(userId)]);
  const oranges = Number(wallet?.oranges || 0);
  if (oranges >= 50) await grantRewardSticker(userId, REWARD_STICKER_ID, addToProfile);
  if (oranges >= 150) await grantRewardSticker(userId, REWARD_STICKER_150_ID, addToProfile);
  if (oranges >= 300) await grantRewardSticker(userId, REWARD_STICKER_300_ID, addToProfile);
  return oranges;
}
async function ensureSpecialAccountsRewards() {
  for (const username of ['brozi','vlad']) {
    const u = await one(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`, [username]);
    if (u) {
      await ensureRewardWallet(u.id);
      if (username === 'brozi') await query("UPDATE reward_wallets SET oranges=1000000, updated_at=NOW() WHERE user_id=$1", [u.id]);
      // Special accounts receive both reward stickers immediately.
      await grantRewardSticker(u.id, REWARD_STICKER_ID, true);
      await grantRewardSticker(u.id, REWARD_STICKER_150_ID, true);
      await grantRewardSticker(u.id, REWARD_STICKER_300_ID, true);
    }
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  next();
});
app.set("trust proxy", true);

// Disappearing messages: 3 seconds, 1 view, or 10 seconds.
// State is kept server-side so the recipient can consume it once.
const disappearingMessages = new Map();

function normalizeDisappearMode(value){
  return ["3s","1view","10s"].includes(value) ? value : null;
}
function scheduleDisappear(id, mode){
  if(mode === "3s" || mode === "10s"){
    const ms = mode === "3s" ? 3000 : 10000;
    setTimeout(()=>disappearingMessages.delete(String(id)), ms);
  }
}

const mediaDir = path.join(__dirname, "uploads", "media");
fs.mkdirSync(mediaDir, { recursive: true });
const mediaStorage = multer.diskStorage({
  destination: mediaDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const uploadMedia = multer({ storage: mediaStorage, limits: { fileSize: 25 * 1024 * 1024 } });

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// One account can be open on a PC and a phone at the same time.
// Keep every live WebSocket instead of replacing the previous device.
const sockets = new Map();
function addSocket(userId, ws){
  const id=Number(userId);
  let set=sockets.get(id);
  if(!set){ set=new Set(); sockets.set(id,set); }
  set.add(ws);
}
function removeSocket(userId, ws){
  const id=Number(userId);
  const set=sockets.get(id);
  if(!set) return;
  set.delete(ws);
  if(!set.size) sockets.delete(id);
}
function hasLiveSocket(userId){
  const set=sockets.get(Number(userId));
  return !!set && [...set].some(ws=>ws.readyState===1);
}

const vapidFile = path.join(__dirname, "vapid.json");
let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(vapidFile, "utf8"));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@bkt.local",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

app.use(express.json());

// Ephemeral message controls
app.post("/api/messages/disappear", express.json(), (req,res)=>{
  const { id, mode } = req.body || {};
  const normalized = normalizeDisappearMode(mode);
  if(id == null || !normalized) return res.status(400).json({error:"invalid id or mode"});
  disappearingMessages.set(String(id), { mode: normalized, viewed: false, createdAt: Date.now() });
  scheduleDisappear(id, normalized);
  res.json({ok:true, id, mode:normalized});
});

app.post("/api/messages/:id/view", (req,res)=>{
  const item = disappearingMessages.get(String(req.params.id));
  if(!item) return res.json({ok:true, expired:true});
  if(item.mode === "1view"){
    item.viewed = true;
    disappearingMessages.delete(String(req.params.id));
    return res.json({ok:true, expired:true});
  }
  res.json({ok:true, expired:false, mode:item.mode});
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(mediaDir));
const statusMediaDir = path.join(__dirname, "uploads", "statuses");
fs.mkdirSync(statusMediaDir, { recursive: true });
const statusStorage = multer.diskStorage({
  destination: statusMediaDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `status-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});
const uploadStatusImage = multer({
  storage: statusStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype))
});
app.use("/status-media", express.static(statusMediaDir));

function requestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.ip || req.socket?.remoteAddress || "unknown");
}
async function issueToken(user, req) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ id: Number(user.id), username: user.username, jti }, JWT_SECRET, { expiresIn: "7d" });
  await query(`INSERT INTO user_sessions(jti,user_id,ip,user_agent) VALUES($1,$2,$3,$4)`, [jti, Number(user.id), requestIp(req), String(req.headers["user-agent"] || "").slice(0,500)]);
  await query("UPDATE users SET last_login_ip=$1 WHERE id=$2", [requestIp(req), Number(user.id)]).catch(()=>{});
  return token;
}
async function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!raw) throw new Error("missing token");
    req.user = jwt.verify(raw, JWT_SECRET);
    const uid = Number(req.user.id);
    const user = await one("SELECT id,username,is_blocked FROM users WHERE id=$1", [uid]);
    if (!user || user.is_blocked) return res.status(403).json({ error: user?.block_reason || "Аккаунт заблокирован" });
    if (req.user.jti) {
      const session = await one("SELECT jti FROM user_sessions WHERE jti=$1 AND user_id=$2 AND revoked_at IS NULL", [String(req.user.jti), uid]);
      if (!session) return res.status(401).json({ error: "Сессия завершена администратором" });
      await query("UPDATE user_sessions SET last_seen_at=NOW() WHERE jti=$1", [String(req.user.jti)]).catch(()=>{});
    }
    const ipBan = await one("SELECT id FROM admin_ip_bans WHERE ip=$1 AND (expires_at IS NULL OR expires_at>NOW())", [requestIp(req)]);
    if (ipBan && !canManageAccounts(user.username)) return res.status(403).json({ error: "IP-адрес заблокирован" });
    next();
  } catch {
    res.status(401).json({ error: "Требуется авторизация" });
  }
}
function normalizeUsername(v) {
  return String(v ?? "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeThreatText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[ьъ]/g, "")
    .replace(/[0о]/g, 'o').replace(/[1]/g, 'и')
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAutomaticThreat(value) {
  const t = normalizeThreatText(value);
  if (!t) return false;

  // Direct threats against the recipient.
  if (/\bя\s+(тебя|тебе)\s+(убью|убить|задушу|задушить|прикончу|зарежу|прибью)\b/.test(t)) return true;
  if (/\b(убью|задушу|прикончу|зарежу|прибью)\s+(тебя|тебе)\b/.test(t)) return true;
  if (/\bтебе\s+(конец|смерть)\b/.test(t)) return true;

  // Doxing threats, including common misspellings/transliterations.
  if (/\b(я\s+)?тебя\s+(задоксю|задокшу|задоксить|доксну|доксану|доксну)\b/.test(t)) return true;
  if (/\b(задоксю|задокшу|доксну|доксану)\b/.test(t)) return true;

  // Threats toward close relatives. A death/threat verb within the same sentence
  // and near a family term is treated as a moderation hit.
  const family = /(мама|мать|папа|отец|бабушка|дедушка|дядя|тетя|тетка|брат|сестра|родител|семья|семью|родные)/;
  const death = /(уб(ь|и)ю|убить|умрет|умрут|умрешь|сдохнет|сдохнут|сдохнешь|помрет|помрут|задуш|приконч|зареж|прибью|умереть)/;
  if (family.test(t) && death.test(t)) return true;

  // Explicit future-death formulations such as “твои родители умрут скоро”.
  if (/\b(твои|твой|твоя|твою|твоего|твоей|ваши|ваш|ваша|вашу)\s+(родител|мама|мать|папа|отец|бабуш|дедуш|дяд|тет|тетка|брат|сестр|семь|родн)[а-я]*\b/.test(t) && /\b(умр|сдох|помр|задуш|уб)/.test(t)) return true;

  // Broader direct-threat forms and common spacing/word-order variations.
  const directThreat = /\b(убью|убить|убей|задушу|задушить|прикончу|зарежу|прибью|сдохнешь|умрешь|умри|помрешь)\b/;
  const target = /\b(тебя|тебе|твой|твоя|твою|твоего|твоей|твои|ваш|ваша|вашу|ваши)\b/;
  if (directThreat.test(t) && target.test(t)) return true;
  if (/\b(тебя|тебе)\b.*\b(задокс|докс|задокш)|\b(задокс|докс|задокш).*\b(тебя|тебе)\b/.test(t)) return true;
  if (/\b(родител|мама|мать|папа|отец|бабуш|дедуш|дяд|тет|тетка|брат|сестр|семь|родн)[а-я]*\b.*\b(скоро|завтра|сегодня)?\s*(умр|сдох|помр|уб)/.test(t)) return true;

  return false;
}

async function permanentlyBotBanUser(userId, reason) {
  const id = Number(userId);
  const target = await one("SELECT id,username,phone FROM users WHERE id=$1", [id]);
  if (!target) return { banned: false, alreadyGone: true };
  if (canManageAccounts(target.username)) return { banned: false, protected: true };

  // Remove uploaded status media before the FK cascade deletes the rows.
  const mediaRows = await many("SELECT media_url FROM statuses WHERE user_id=$1 AND media_url LIKE '/status-media/%'", [id]);
  for (const row of mediaRows) {
    const fileName = path.basename(String(row.media_url || ""));
    if (fileName) { try { await fs.promises.unlink(path.join(statusMediaDir, fileName)); } catch (_) {} }
  }

  // A bot-ban permanently reserves the phone number. Unlike voluntary account
  // deletion, the same number cannot be registered again.
  if (target.phone) {
    await query(`INSERT INTO bot_banned_phones(phone,reason) VALUES($1,$2)
      ON CONFLICT(phone) DO UPDATE SET reason=EXCLUDED.reason,banned_at=NOW()`, [normalizePhone(target.phone), String(reason || "automatic threat moderation")]);
  }

  push(id, { type: "account-banned", permanent: true, reason: "Аккаунт заблокирован автоматической модерацией" });
  await query("DELETE FROM users WHERE id=$1", [id]);
  const socketsForUser = sockets.get(id);
  if (socketsForUser) {
    for (const ws of [...socketsForUser]) { try { ws.close(4003, "Account permanently banned"); } catch (_) {} }
    sockets.delete(id);
  }
  return { banned: true, username: target.username, phoneBanned: !!target.phone };
}
async function currentUser(req) {
  const id = Number(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? 0);
  if (id) {
    const byId = await one("SELECT id, username FROM users WHERE id=$1", [id]);
    if (byId) return byId;
  }
  const username = String(req.user?.username ?? "").trim();
  if (username) return one("SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)", [username]);
  return null;
}
async function currentUserId(req) {
  const user = await currentUser(req);
  return user ? Number(user.id) : 0;
}
async function isVerified(userId) {
  return !!(await one("SELECT 1 FROM verified_users WHERE user_id=$1", [Number(userId)]));
}
async function isGroupMember(groupId, userId) {
  return !!(await one("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [Number(groupId), Number(userId)]));
}
function push(userId, payload) {
  const set = sockets.get(Number(userId));
  if(!set) return false;
  let delivered=false;
  for(const ws of [...set]){
    if(ws.readyState===1){
      try{ ws.send(JSON.stringify(payload)); delivered=true; }catch(_){}
    }
  }
  return delivered;
}
function onlineUserIds(){
  const ids=new Set();
  for(const [id,set] of sockets.entries()){
    if([...set].some(ws=>ws.readyState===1)) ids.add(Number(id));
  }
  if(botUserId && Date.now()-botLastSeenAt<150000) ids.add(botUserId);
  return ids;
}
function broadcastPresence(userId, online){
  const payload=JSON.stringify({type:"presence",userId:Number(userId),online:!!online});
  for(const set of sockets.values()) for(const ws of [...set]){
    if(ws.readyState===1){ try{ws.send(payload)}catch(_){} }
  }
}
async function pushNotification(userId, payload) {
  const rows = await many("SELECT id, endpoint, subscription_json FROM push_subscriptions WHERE user_id=$1", [Number(userId)]);
  for (const row of rows) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload));
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
      } else {
        console.error("Web Push error:", err?.message || err);
      }
    }
  }
}
function sendSignal(toUserId, payload) {
  push(Number(toUserId), { type: "call-signal", ...payload });
}

app.get("/api/rtc-config", auth, async (req, res) => {
  // Prefer an external TURN provider when configured. Metered exposes a
  // credential-scoped API key, so the secret is never sent to the browser.
  try {
    const meteredApp = String(process.env.METERED_APP_NAME || "").trim();
    const meteredKey = String(process.env.METERED_API_KEY || "").trim();
    const meteredRegion = String(process.env.METERED_REGION || "").trim();
    if (meteredApp && meteredKey && typeof fetch === "function") {
      const url = new URL(`https://${meteredApp}.metered.live/api/v1/turn/credentials`);
      url.searchParams.set("apiKey", meteredKey);
      if (meteredRegion) url.searchParams.set("region", meteredRegion);
      const r = await fetch(url);
      if (r.ok) {
        const iceServers = await r.json();
        if (Array.isArray(iceServers) && iceServers.length) {
          res.set("Cache-Control", "no-store");
          return res.json({ iceServers });
        }
      } else {
        console.warn("Metered TURN request failed:", r.status);
      }
    }
  } catch (e) {
    console.warn("Metered TURN unavailable:", e?.message || e);
  }

  const iceServers = [
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478"
    ]}
  ];

  const turnUrls = String(process.env.TURN_URLS || process.env.TURN_URL || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const turnSecret = String(process.env.TURN_SECRET || "");
  if (turnUrls.length && turnSecret) {
    // TURN credentials are short-lived by default, but the lifetime can be
    // configured for a self-hosted coturn server. 1000 hours is the requested
    // lifetime; set TURN_CREDENTIAL_TTL_HOURS to override it in production.
    const ttlHours = Number(process.env.TURN_CREDENTIAL_TTL_HOURS || 1000);
    const safeTtlHours = Number.isFinite(ttlHours) && ttlHours > 0 ? Math.min(ttlHours, 24 * 365) : 1000;
    const expires = Math.floor(Date.now() / 1000) + Math.floor(safeTtlHours * 60 * 60);
    const username = `${expires}:${String(req.user.id)}`;
    const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }
  res.set("Cache-Control", "no-store");
  res.json({ iceServers });
});

app.post("/api/register/request-code", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const phoneRaw = String(req.body.phone || "").trim();
    const accessCode = String(req.body.accessCode || "");
    const referralCode = String(req.body.referralCode || "").trim();
    let avatar = String(req.body.avatar || "/stickers/1.webp").trim();
    const usernameError = validateUsername(username);
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (!/^\+?[0-9 ()-]{10,20}$/.test(phoneRaw)) return res.status(400).json({ error: "Введите корректный номер телефона" });
    const phone = normalizePhone(phoneRaw);
    if (phone.length < 10 || phone.length > 15) return res.status(400).json({ error: "Введите корректный номер телефона" });
    if (await one("SELECT 1 FROM bot_banned_phones WHERE phone=$1", [phone])) return res.status(403).json({ error: "Этот номер навсегда заблокирован автоматической модерацией" });
    if (!verifyProtectedCode(username, accessCode)) return res.status(403).json({ error: protectedError(username) });
    if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    if (await one("SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)", [username])) return res.status(409).json({ error: "Такой пользователь уже существует" });
    if (await one("SELECT 1 FROM users WHERE phone=$1", [phone])) return res.status(409).json({ error: "Этот номер уже привязан к аккаунту" });
    if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8]|29|30|31)\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
  if (/^\/stickers\/(?:29|30|31)\.webp$/.test(avatar)) {
    const sid = Number(avatar.match(/\d+/)[0]);
    const ownedGift = await one("SELECT 1 FROM user_stickers WHERE user_id=$1 AND sticker_id=$2", [meUser.id, sid]);
    if (!ownedGift) avatar = "/stickers/1.webp";
  }
    const verificationToken = crypto.randomBytes(24).toString("hex");
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const passwordHash = await bcrypt.hash(password, 10);
    await query("DELETE FROM phone_verifications WHERE phone=$1 OR expires_at<NOW()", [phone]);
    await query(`INSERT INTO phone_verifications(token,phone,username,password_hash,avatar,code_hash,expires_at,referral_code) VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes',$7)`, [verificationToken, phone, username, passwordHash, avatar, codeHash, referralCode]);
    if (!phoneExempt(phone)) await sendVerificationCode(phone, code);
    res.json({ token: verificationToken, phone: phone.replace(/(\d{2})\d{5}(\d{2})$/, "$1*****$2"), exempt: phoneExempt(phone), devCode: process.env.NODE_ENV !== "production" && !phoneExempt(phone) ? code : undefined });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message === "SMS-провайдер не настроен" ? e.message : "Не удалось отправить код подтверждения" }); }
});

app.post("/api/register/verify", async (req, res) => {
  try {
    const token = String(req.body.token || "");
    const code = String(req.body.code || "").trim();
    const pending = await one("SELECT * FROM phone_verifications WHERE token=$1 AND used=FALSE AND expires_at>NOW()", [token]);
    if (!pending) return res.status(400).json({ error: "Код истёк или заявка регистрации недействительна" });
    const exempt = phoneExempt(pending.phone);
    if (!exempt) {
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Введите 6-значный код" });
      if (pending.attempts >= 5) return res.status(429).json({ error: "Слишком много попыток. Запросите новый код" });
      const hash = crypto.createHash("sha256").update(code).digest("hex");
      if (hash !== pending.code_hash) { await query("UPDATE phone_verifications SET attempts=attempts+1 WHERE token=$1", [token]); return res.status(400).json({ error: "Неверный код подтверждения" }); }
    }
    const usernameError = validateUsername(pending.username);
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (await one("SELECT 1 FROM bot_banned_phones WHERE phone=$1", [normalizePhone(pending.phone)])) return res.status(403).json({ error: "Этот номер навсегда заблокирован автоматической модерацией" });
    const user = await one("INSERT INTO users(username,password_hash,avatar,phone) VALUES($1,$2,$3,$4) RETURNING id,username,avatar", [pending.username, pending.password_hash, pending.avatar, pending.phone]);
    await query("UPDATE phone_verifications SET used=TRUE WHERE token=$1", [token]);
    if (["brozi", "vlad", "vladmobile", "premium_бот"].includes(pending.username.toLowerCase())) await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [user.id]);
    await addUserToCommunityGroup(user.id);
    await ensureRewardWallet(user.id);
    await ensureReferralCode(user.id);
    await rewardReferralOnRegistration(user.id, pending.referral_code);
    if (pending.username.toLowerCase() === 'brozi') await query("UPDATE reward_wallets SET oranges=1000000, updated_at=NOW() WHERE user_id=$1", [user.id]);
    if (['brozi','vlad'].includes(pending.username.toLowerCase())) { await grantRewardSticker(user.id, REWARD_STICKER_ID, true); await grantRewardSticker(user.id, REWARD_STICKER_150_ID, true); }
    res.json({ token: await issueToken(user, req), user });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Такой пользователь или номер уже существует" }); console.error(e); res.status(500).json({ error: "Не удалось завершить регистрацию" }); }
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const accessCode = String(req.body.accessCode || "");
    let avatar = String(req.body.avatar || "/stickers/1.webp").trim();
    const usernameError = validateUsername(username);
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    if (!verifyProtectedCode(username, accessCode)) return res.status(403).json({ error: protectedError(username) });
    if (await one("SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)", [username])) return res.status(409).json({ error: "Такой пользователь уже существует" });
    if (await one("SELECT 1 FROM deleted_usernames WHERE LOWER(username)=LOWER($1)", [username])) return res.status(410).json({ error: "Этот аккаунт был удалён навсегда и логин больше недоступен" });
    if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8]|29|30|31)\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
  if (/^\/stickers\/(?:29|30|31)\.webp$/.test(avatar)) {
    const sid = Number(avatar.match(/\d+/)[0]);
    const ownedGift = await one("SELECT 1 FROM user_stickers WHERE user_id=$1 AND sticker_id=$2", [meUser.id, sid]);
    if (!ownedGift) avatar = "/stickers/1.webp";
  }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await one("INSERT INTO users(username,password_hash,avatar) VALUES($1,$2,$3) RETURNING id,username,avatar", [username, passwordHash, avatar]);
    if (["brozi", "vlad", "vladmobile", "premium_бот"].includes(username.toLowerCase())) await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [user.id]);
    await addUserToCommunityGroup(user.id);
    await ensureRewardWallet(user.id);
    await ensureReferralCode(user.id);
    await rewardReferralOnRegistration(user.id, req.body.referralCode);
    if (username.toLowerCase() === 'brozi') await query("UPDATE reward_wallets SET oranges=1000000, updated_at=NOW() WHERE user_id=$1", [user.id]);
    if (['brozi','vlad'].includes(username.toLowerCase())) { await grantRewardSticker(user.id, REWARD_STICKER_ID, true); await grantRewardSticker(user.id, REWARD_STICKER_150_ID, true); }
    res.json({ token: await issueToken(user, req), user });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Такой логин уже существует" }); console.error(e); res.status(500).json({ error: "Не удалось зарегистрировать аккаунт" }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(req.body.username || req.body.login || req.body.phone || "").trim();
    const password = String(req.body.password || "");
    const accessCode = String(req.body.accessCode || "");
    if (!identifier || !password) return res.status(400).json({ error: "Введите логин/номер телефона и пароль" });

    // Вход поддерживает и @username, и номер телефона. Email здесь не используется.
    const normalizedUsername = normalizeUsername(identifier);
    const looksLikePhone = /^[+0-9 ()-]{10,20}$/.test(identifier) && normalizePhone(identifier).length >= 10;
    if (!looksLikePhone && isBannedUsername(identifier)) return res.status(403).json({ error: "Этот логин запрещён" });
    if (!verifyProtectedCode(normalizedUsername, accessCode)) return res.status(403).json({ error: protectedError(normalizedUsername) });

    let row;
    if (looksLikePhone) {
      const phone = normalizePhone(identifier);
      if (await one("SELECT 1 FROM bot_banned_phones WHERE phone=$1", [phone])) return res.status(403).json({ error: "Этот номер навсегда заблокирован автоматической модерацией" });
      row = await one("SELECT * FROM users WHERE phone=$1 LIMIT 1", [phone]);
    } else {
      row = await one("SELECT * FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", [normalizedUsername]);
    }
    if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: "Неверный логин/номер телефона или пароль" });
    if (row.is_blocked) return res.status(403).json({ error: row.block_reason || "Аккаунт заблокирован" });
    const loginIp = requestIp(req);
    const loginIpBan = await one("SELECT id FROM admin_ip_bans WHERE ip=$1 AND (expires_at IS NULL OR expires_at>NOW())", [loginIp]);
    if (loginIpBan && !canManageAccounts(row.username)) return res.status(403).json({ error: "IP-адрес заблокирован" });
    const user = { id: row.id, username: row.username };
    res.json({ token: await issueToken(user, req), user });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Ошибка входа. Попробуйте ещё раз." });
  }
});

app.post("/api/logout", auth, async (req,res)=>{
  if(req.user?.jti) await query("UPDATE user_sessions SET revoked_at=NOW() WHERE jti=$1",[String(req.user.jti)]);
  res.json({ok:true});
});

app.get("/api/me", auth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
  let orange={oranges:0,badge:null,frame:null,achievements:[]};
  try{
    const wallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[user.id]);
    const badge=await one("SELECT badge_type,badge_value FROM user_profile_badges WHERE user_id=$1",[user.id]);
    const frame=await one("SELECT frame_id FROM user_profile_frames WHERE user_id=$1",[user.id]);
    const achievements=await many(`SELECT a.key,a.name,a.description,a.icon,a.badge,ua.obtained_at FROM user_orange_achievements ua JOIN orange_achievements a ON a.key=ua.achievement_key WHERE ua.user_id=$1 ORDER BY a.sort_order`,[user.id]);
    orange={oranges:Number(wallet?.oranges||0),badge:badge?{type:badge.badge_type,value:badge.badge_value}:null,frame:frame?{type:"frame",value:frame.frame_id,src:frame.frame_id==="capybara_orange_frame"?ORANGE_FRAME_SRC:null}:null,achievements};
  }catch(e){console.error("Own profile orange lookup failed:",e)}
  res.json({ ...user, verified: await isVerified(user.id), orange });
});

app.get("/api/profile", auth, async (req, res) => {
  const meUser = await currentUser(req);
  if (!meUser) return res.status(401).json({ error: "Аккаунт не найден в базе данных. Выйдите и войдите снова." });
  const user = await one("SELECT id,username,COALESCE(bio,'') AS bio,COALESCE(avatar,'') AS avatar,last_seen_at FROM users WHERE id=$1", [meUser.id]);
  if (!user) return res.status(404).json({ error: "Профиль не найден" });
  res.json(user);
});

app.patch("/api/profile", auth, async (req, res) => {
  const meUser = await currentUser(req);
  if (!meUser) return res.status(401).json({ error: "Аккаунт не найден в базе данных. Выйдите и войдите снова." });
  const username = String(req.body?.username ?? "").trim().replace(/^@+/, "");
  const accessCode = String(req.body?.accessCode ?? "");
  const usernameError = validateUsername(username);
  const currentUsername = String(meUser.username || "").trim();
  if (usernameError && !(usernameError === "Этот логин зарезервирован" && username.toLowerCase() === currentUsername.toLowerCase())) return res.status(400).json({ error: usernameError });
  if (RESERVED_USERNAME_KEYS.has(usernameSimilarityKey(username)) && username.toLowerCase() !== currentUsername.toLowerCase()) return res.status(400).json({ error: "Этот логин зарезервирован" });
  if (protectedAccount(username) && !verifyProtectedCode(username, accessCode)) return res.status(403).json({ error: protectedError(username) });
  const bio = String(req.body?.bio ?? "").trim().slice(0, 160);
  let avatar = String(req.body?.avatar ?? "").trim();
  if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8]|29|30|31)\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
  if (/^\/stickers\/(?:29|30|31)\.webp$/.test(avatar)) {
    const sid = Number(avatar.match(/\d+/)[0]);
    const ownedGift = await one("SELECT 1 FROM user_stickers WHERE user_id=$1 AND sticker_id=$2", [meUser.id, sid]);
    if (!ownedGift) avatar = "/stickers/1.webp";
  }
  const exists = await one("SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2", [username, meUser.id]);
  const usernameToSave = exists ? meUser.username : username;
  const updated = await one(`UPDATE users SET username=$1,bio=$2,avatar=$3 WHERE id=$4
    RETURNING id,username,COALESCE(bio,'') AS bio,COALESCE(avatar,'') AS avatar`, [usernameToSave, bio, avatar, meUser.id]);
  res.json(updated);
});

app.get("/api/users/search", auth, async (req, res) => {
  const meUser = await currentUser(req);
  const q = normalizeUsername(req.query.q);
  if (!meUser) return res.status(401).json({ error: "Аккаунт не найден в базе данных" });
  if (!q) return res.json([]);
  const users = await many(`
    SELECT u.id,u.username,COALESCE(u.bio,'') AS bio,COALESCE(u.avatar,'') AS avatar,
      EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified
    FROM users u WHERE u.id<>$1 AND LOWER(u.username) LIKE LOWER($2)
    ORDER BY CASE WHEN LOWER(u.username)=LOWER($3) THEN 0 WHEN LOWER(u.username) LIKE LOWER($4) THEN 1 ELSE 2 END, LOWER(u.username)
    LIMIT 50`, [meUser.id, `%${q}%`, q, `${q}%`]);
  res.set("Cache-Control", "no-store");
  const online=onlineUserIds();
  res.json(users.map(u => ({ ...u, online: online.has(Number(u.id)) })));
});

app.get("/api/users/by-username/:username", auth, async (req, res) => {
  const uid = await currentUserId(req);
  const q = normalizeUsername(req.params.username);
  if (!uid) return res.status(401).json({ error: "Сессия недействительна" });
  const user = await one(`SELECT u.id,u.username,COALESCE(u.bio,'') AS bio,COALESCE(u.avatar,'') AS avatar,
    EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified
    FROM users u WHERE LOWER(u.username)=$1`, [q]);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });
  res.json(user);
});

app.get("/api/users/:id/profile", auth, async (req, res) => {
  try {
    const rawId = String(req.params.id ?? "").trim();
    const userId = Number(rawId);
    if (!rawId || !Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Некорректный идентификатор пользователя" });
    }

    const user = await one(
      "SELECT id,username,COALESCE(bio,'') AS bio,COALESCE(avatar,'') AS avatar,last_seen_at FROM users WHERE id=$1",
      [userId]
    );
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    // Optional profile data is isolated: an unavailable auxiliary table must never
    // turn opening a profile into a 500/502/503 response.
    const [gifts, verified, wallet, badge, achievements, viewer] = await Promise.all([
      many(`SELECT sticker_id,added_at FROM profile_gifts WHERE user_id=$1 ORDER BY added_at DESC`, [userId]).catch(e => { console.error("Profile gifts lookup failed:", e); return []; }),
      isVerified(userId).catch(e => { console.error("Profile verification lookup failed:", e); return false; }),
      one("SELECT oranges FROM reward_wallets WHERE user_id=$1", [userId]).catch(e => { console.error("Profile wallet lookup failed:", e); return null; }),
      one("SELECT badge_type,badge_value FROM user_profile_badges WHERE user_id=$1", [userId]).catch(e => { console.error("Profile badge lookup failed:", e); return null; }),
      many(`SELECT a.key,a.name,a.description,a.icon,a.badge,ua.obtained_at FROM user_orange_achievements ua JOIN orange_achievements a ON a.key=ua.achievement_key WHERE ua.user_id=$1 ORDER BY a.sort_order`, [userId]).catch(e => { console.error("Profile achievements lookup failed:", e); return []; }),
      currentUser(req).catch(() => null)
    ]);

    let blocked = false, blockedByUser = false;
    if (viewer && Number(viewer.id) !== userId) {
      const relation = await one(`SELECT
          EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2) AS blocked,
          EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$2 AND blocked_id=$1) AS blocked_by_user`,
        [Number(viewer.id), userId]).catch(e => { console.error("Profile block lookup failed:", e); return null; });
      blocked = !!relation?.blocked;
      blockedByUser = !!relation?.blocked_by_user;
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      ...user,
      verified,
      gifts: gifts.map(g => ({ stickerId: Number(g.sticker_id), src: `/stickers/${Number(g.sticker_id)}.webp`, addedAt: g.added_at })),
      orange: {
        oranges: Number(wallet?.oranges || 0),
        badge: badge ? { type: badge.badge_type, value: badge.badge_value } : null,
        achievements
      },
      viewerRelation: { blocked, blockedByUser }
    });
  } catch (e) {
    console.error("Open user profile error:", e);
    // Never leak an upstream/DB error to the UI. The client has retry logic for transient 5xx/429.
    res.status(503).json({ error: "Профиль временно недоступен. Повторите попытку через несколько секунд.", retryable: true });
  }
});

app.delete("/api/account", auth, async (req, res) => {
  try {
    const actor = await currentUser(req);
    if (!actor) return res.status(404).json({ error: "Аккаунт не найден" });
    const userId = Number(actor.id);
    const target = await one("SELECT id, username, phone FROM users WHERE id=$1", [userId]);
    if (!target) return res.status(404).json({ error: "Аккаунт уже удалён" });

    // Remove uploaded status media belonging to this account as well as DB rows.
    const mediaRows = await many("SELECT media_url FROM statuses WHERE user_id=$1 AND media_url LIKE '/status-media/%'", [userId]);
    for (const row of mediaRows) {
      const fileName = path.basename(String(row.media_url || ""));
      if (fileName) {
        try { await fs.promises.unlink(path.join(statusMediaDir, fileName)); } catch (_) {}
      }
    }

    // Keep the username permanently reserved, but do NOT keep the phone number:
    // after deletion the same phone can be used for a new registration.
    const deleted = await one(`
      WITH removed AS (
        DELETE FROM users WHERE id=$1 RETURNING username
      )
      INSERT INTO deleted_usernames(username)
      SELECT username FROM removed
      ON CONFLICT (username) DO NOTHING
      RETURNING username`, [userId]);
    if (!deleted) return res.status(404).json({ error: "Аккаунт уже удалён" });

    push(userId, { type: "account-deleted", permanent: true, self: true });
    const socketsForUser = sockets.get(userId);
    if (socketsForUser) {
      for (const ws of [...socketsForUser]) {
        try { ws.close(4001, "Account permanently deleted"); } catch (_) {}
      }
      sockets.delete(userId);
    }
    res.json({ ok: true, permanentlyDeleted: true, phoneReusable: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось удалить аккаунт" });
  }
});

async function requireAdmin(req, res) {
  const actor = await currentUser(req);
  if (!actor || !canManageAccounts(actor.username)) { res.status(403).json({ error: "Доступ только для Brozi и Vlad" }); return null; }
  return actor;
}
async function adminLog(req, admin, action, targetUserId=null, targetUsername='', details={}) {
  await query(`INSERT INTO admin_action_logs(admin_id,action,target_user_id,target_username,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [Number(admin.id), action, targetUserId ? Number(targetUserId) : null, String(targetUsername || ''), JSON.stringify(details || {}), requestIp(req)]).catch(e=>console.error('Admin log error:',e));
}

app.get("/api/admin/me", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  res.json({ok:true,admin:{id:Number(actor.id),username:actor.username}});
});

app.get("/api/admin/stats", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const [users,blocked,groups,messages,reports,sessions]=await Promise.all([
    one("SELECT COUNT(*)::int AS n FROM users"),
    one("SELECT COUNT(*)::int AS n FROM users WHERE is_blocked=TRUE"),
    one("SELECT COUNT(*)::int AS n FROM groups"),
    one("SELECT COUNT(*)::int AS n FROM messages"),
    one("SELECT COUNT(*)::int AS n FROM reports WHERE status='open'"),
    one("SELECT COUNT(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL AND last_seen_at>NOW()-INTERVAL '30 days'")
  ]);
  res.json({users:Number(users.n),blocked:Number(blocked.n),groups:Number(groups.n),messages:Number(messages.n),openReports:Number(reports.n),sessions:Number(sessions.n)});
});

app.get("/api/admin/users", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const q=String(req.query.q||'').trim(); const limit=Math.min(Math.max(Number(req.query.limit)||50,1),100); const offset=Math.max(Number(req.query.offset)||0,0);
  const rows=await many(`SELECT u.id,u.username,u.phone,u.created_at,u.last_seen_at,u.last_login_ip,u.is_blocked,u.block_reason,u.is_bot,
      EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified,
      (SELECT COUNT(*)::int FROM user_sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS active_sessions,
      (SELECT COUNT(*)::int FROM reports r WHERE r.target_user_id=u.id AND r.status='open') AS open_reports
    FROM users u
    WHERE ($1='' OR u.username ILIKE '%'||$1||'%' OR COALESCE(u.phone,'') ILIKE '%'||$1||'%')
    ORDER BY u.id DESC LIMIT $2 OFFSET $3`,[q,limit,offset]);
  res.json(rows);
});

app.post("/api/admin/users/:id/block", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const id=Number(req.params.id); const target=await one("SELECT id,username,is_blocked FROM users WHERE id=$1",[id]);
  if(!target)return res.status(404).json({error:"Пользователь не найден"});
  if(canManageAccounts(target.username))return res.status(403).json({error:"Brozi и Vlad защищены от блокировки"});
  const reason=String(req.body?.reason||'Решение администратора').slice(0,500);
  await query("UPDATE users SET is_blocked=TRUE,block_reason=$1 WHERE id=$2",[reason,id]);
  await query("UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL",[id]);
  for(const ws of [...(sockets.get(id)||[])]){try{ws.close(4003,"Account blocked")}catch(_){}} sockets.delete(id);
  await adminLog(req,actor,'user_block',id,target.username,{reason});
  res.json({ok:true,blocked:true});
});

app.delete("/api/admin/users/:id/block", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const id=Number(req.params.id); const target=await one("SELECT id,username FROM users WHERE id=$1",[id]);
  if(!target)return res.status(404).json({error:"Пользователь не найден"});
  await query("UPDATE users SET is_blocked=FALSE,block_reason='' WHERE id=$1",[id]);
  await adminLog(req,actor,'user_unblock',id,target.username,{});
  res.json({ok:true,blocked:false});
});

app.get("/api/admin/groups", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const rows=await many(`SELECT g.id,g.name,g.created_at,g.owner_id,u.username AS owner_username,
    (SELECT COUNT(*)::int FROM group_members gm WHERE gm.group_id=g.id) AS members,
    (SELECT COUNT(*)::int FROM group_messages gm WHERE gm.group_id=g.id) AS messages
    FROM groups g LEFT JOIN users u ON u.id=g.owner_id ORDER BY g.id DESC`);
  res.json(rows);
});

app.post("/api/reports", auth, async (req,res)=>{
  const reporter=await currentUser(req); if(!reporter)return res.status(401).json({error:"Аккаунт не найден"});
  const targetUserId=Number(req.body?.targetUserId)||null; const groupId=Number(req.body?.groupId)||null; const messageId=Number(req.body?.messageId)||null;
  const reason=String(req.body?.reason||'Нарушение правил').trim().slice(0,120); const details=String(req.body?.details||'').trim().slice(0,2000);
  if(!targetUserId && !groupId && !messageId)return res.status(400).json({error:"Не указан объект жалобы"});
  const r=await one(`INSERT INTO reports(reporter_id,target_user_id,group_id,message_id,reason,details) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[reporter.id,targetUserId,groupId,messageId,reason,details]);
  await adminLog(req,reporter,'report_created',targetUserId,null,{reportId:Number(r.id),reason,groupId,messageId});
  res.json({ok:true,id:Number(r.id)});
});

app.get("/api/admin/reports", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const status=String(req.query.status||'open');
  const rows=await many(`SELECT r.*,ru.username reporter_username,tu.username target_username,g.name group_name
    FROM reports r LEFT JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id LEFT JOIN groups g ON g.id=r.group_id
    WHERE ($1='all' OR r.status=$1) ORDER BY r.created_at DESC LIMIT 200`,[status]);
  res.json(rows);
});

app.post("/api/admin/reports/:id/resolve", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const id=Number(req.params.id); const report=await one("SELECT id,target_user_id FROM reports WHERE id=$1",[id]); if(!report)return res.status(404).json({error:"Жалоба не найдена"});
  const status=['resolved','rejected'].includes(String(req.body?.status))?String(req.body.status):'resolved';
  await query("UPDATE reports SET status=$1,resolved_by=$2,resolved_at=NOW() WHERE id=$3",[status,actor.id,id]);
  await adminLog(req,actor,'report_'+status,report.target_user_id,null,{reportId:id});
  res.json({ok:true,status});
});

app.get("/api/admin/sessions", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const userId=Number(req.query.userId)||null;
  const rows=await many(`SELECT s.jti,s.user_id,u.username,s.ip,s.user_agent,s.created_at,s.last_seen_at,s.revoked_at
    FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE ($1::bigint IS NULL OR s.user_id=$1) ORDER BY s.last_seen_at DESC LIMIT 300`,[userId]);
  res.json(rows);
});

app.post("/api/admin/sessions/:jti/revoke", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const jti=String(req.params.jti); const s=await one("SELECT s.jti,s.user_id,u.username FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.jti=$1",[jti]);
  if(!s)return res.status(404).json({error:"Сессия не найдена"});
  await query("UPDATE user_sessions SET revoked_at=NOW() WHERE jti=$1",[jti]);
  await adminLog(req,actor,'session_revoke',s.user_id,s.username,{jti});
  res.json({ok:true});
});

app.get("/api/admin/ip-bans", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  res.json(await many("SELECT b.*,u.username created_by_username FROM admin_ip_bans b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC"));
});
app.post("/api/admin/ip-bans", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const ip=String(req.body?.ip||'').trim(); const reason=String(req.body?.reason||'Решение администратора').slice(0,500); const expiresAt=req.body?.expiresAt?new Date(req.body.expiresAt):null;
  if(!ip)return res.status(400).json({error:"Укажите IP"});
  if(expiresAt && Number.isNaN(expiresAt.getTime()))return res.status(400).json({error:"Некорректная дата окончания"});
  await query(`INSERT INTO admin_ip_bans(ip,reason,expires_at,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(ip) DO UPDATE SET reason=EXCLUDED.reason,expires_at=EXCLUDED.expires_at,created_by=EXCLUDED.created_by,created_at=NOW()`,[ip,reason,expiresAt,actor.id]);
  await adminLog(req,actor,'ip_ban',null,'',{ip,reason,expiresAt});
  res.json({ok:true});
});
app.delete("/api/admin/ip-bans/:id", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const row=await one("SELECT ip FROM admin_ip_bans WHERE id=$1",[Number(req.params.id)]); if(!row)return res.status(404).json({error:"IP-бан не найден"});
  await query("DELETE FROM admin_ip_bans WHERE id=$1",[Number(req.params.id)]); await adminLog(req,actor,'ip_unban',null,'',{ip:row.ip}); res.json({ok:true});
});

app.get("/api/admin/sartsna", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const defaults={enabled:'true',captcha_reward:'5',daily_bonus:'10',referral_reward:'50',referral_milestone_reward:'150'};
  const rows=await many("SELECT key,value,updated_at FROM admin_settings WHERE key LIKE 'sartsna.%' ORDER BY key");
  const out={...defaults}; for(const r of rows)out[r.key.replace(/^sartsna\./,'')]=r.value; res.json(out);
});
app.put("/api/admin/sartsna", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  const allowed=['enabled','captcha_reward','daily_bonus','referral_reward','referral_milestone_reward']; const changes={};
  for(const key of allowed){ if(req.body?.[key]!==undefined){ const value=String(req.body[key]).slice(0,100); await query(`INSERT INTO admin_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,['sartsna.'+key,value,actor.id]); changes[key]=value; }}
  await adminLog(req,actor,'sartsna_settings_update',null,'',changes); res.json({ok:true,changes});
});

app.get("/api/admin/logs", auth, async (req,res)=>{
  const actor=await requireAdmin(req,res); if(!actor)return;
  res.json(await many(`SELECT l.*,u.username admin_username FROM admin_action_logs l LEFT JOIN users u ON u.id=l.admin_id ORDER BY l.created_at DESC LIMIT 300`));
});

app.post("/api/admin/users/:id/delete", auth, async (req,res)=>{
  try {
    const actor=await requireAdmin(req,res); if(!actor)return;
    const userId=Number(req.params.id); if(!Number.isInteger(userId)||userId<=0)return res.status(400).json({error:"Некорректный ID пользователя"});
    if(userId===Number(actor.id))return res.status(400).json({error:"Нельзя удалить собственный аккаунт через админку"});
    const target=await one("SELECT id,username,phone FROM users WHERE id=$1",[userId]); if(!target)return res.status(404).json({error:"Пользователь не найден"});
    if(canManageAccounts(target.username))return res.status(403).json({error:"Аккаунты Brozi и Vlad защищены от удаления"});
    const confirm=String(req.body?.confirmUsername||'').trim();
    if(confirm.toLowerCase()!==String(target.username).toLowerCase())return res.status(400).json({error:"Для удаления введите точный логин пользователя"});
    const reason=String(req.body?.reason||'Удаление по решению администратора').slice(0,500);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO admin_action_logs(admin_id,action,target_user_id,target_username,details,ip) VALUES($1,'user_delete',$2,$3,$4::jsonb,$5)`,[actor.id,target.id,target.username,JSON.stringify({reason,confirmed:true}),requestIp(req)]);
      const mediaRows=await client.query("SELECT media_url FROM statuses WHERE user_id=$1 AND media_url LIKE '/status-media/%'",[userId]);
      for(const row of mediaRows.rows){const fileName=path.basename(String(row.media_url||''));if(fileName){try{await fs.promises.unlink(path.join(statusMediaDir,fileName))}catch(_){} }}
      await client.query(`INSERT INTO deleted_usernames(username) VALUES($1) ON CONFLICT(username) DO NOTHING`,[target.username]);
      await client.query("DELETE FROM users WHERE id=$1",[userId]);
      await client.query('COMMIT');
    } catch(e){try{await client.query('ROLLBACK')}catch(_){} throw e} finally{client.release()}
    const socketsForUser=sockets.get(userId); if(socketsForUser){for(const ws of [...socketsForUser]){try{ws.close(4001,'Account permanently deleted')}catch(_){}} sockets.delete(userId)}
    res.json({ok:true,permanentlyDeleted:true,username:target.username});
  } catch(e){console.error('Admin delete error:',e);res.status(500).json({error:'Не удалось удалить аккаунт'})}
});

app.post("/api/admin/verify/:id", auth, async (req, res) => {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  if (!adminId || Number(req.user.id) !== adminId) return res.status(403).json({ error: "Нет доступа" });
  const userId = Number(req.params.id);
  if (!(await one("SELECT id FROM users WHERE id=$1", [userId]))) return res.status(404).json({ error: "Пользователь не найден" });
  await query("INSERT INTO verified_users(user_id,verified_by) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET verified_by=EXCLUDED.verified_by,verified_at=NOW()", [userId, req.user.id]);
  res.json({ ok: true, verified: true });
});
app.delete("/api/admin/verify/:id", auth, async (req, res) => {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  if (!adminId || Number(req.user.id) !== adminId) return res.status(403).json({ error: "Нет доступа" });
  await query("DELETE FROM verified_users WHERE user_id=$1", [Number(req.params.id)]);
  res.json({ ok: true, verified: false });
});

async function isBlockedBetween(a, b) {
  const row = await one(`SELECT 1 FROM user_blocks
    WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)
    LIMIT 1`, [Number(a), Number(b)]);
  return !!row;
}

app.get("/api/users/:id/block-status", auth, async (req, res) => {
  const other = Number(req.params.id);
  if (!other || other === Number(req.user.id)) return res.status(400).json({ error: "Некорректный пользователь" });
  const target = await one("SELECT id,username FROM users WHERE id=$1", [other]);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });
  const mine = !!(await one("SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2", [req.user.id, other]));
  const theirs = !!(await one("SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2", [other, req.user.id]));
  res.json({ blocked: mine, blockedByUser: theirs, anyBlocked: mine || theirs });
});

app.post("/api/users/:id/block", auth, async (req, res) => {
  const other = Number(req.params.id);
  if (!other || other === Number(req.user.id)) return res.status(400).json({ error: "Нельзя заблокировать себя" });
  const target = await one("SELECT id,username FROM users WHERE id=$1", [other]);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });
  await query(`INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)
    ON CONFLICT(blocker_id,blocked_id) DO NOTHING`, [req.user.id, other]);
  res.json({ ok: true, blocked: true });
});

app.delete("/api/users/:id/block", auth, async (req, res) => {
  const other = Number(req.params.id);
  await query("DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2", [req.user.id, other]);
  res.json({ ok: true, blocked: false });
});

app.get("/api/statuses", auth, async (req, res) => {
  try {
    const expired = await many("DELETE FROM statuses WHERE expires_at <= NOW() RETURNING media_url");
    for (const row of expired) {
      if (row.media_url && row.media_url.startsWith("/status-media/")) {
        const file = path.join(statusMediaDir, path.basename(row.media_url));
        fs.unlink(file, () => {});
      }
    }
    const rows = await many(`SELECT s.id, s.user_id, u.username, u.avatar, s.text, s.media_url, s.created_at, s.expires_at
      FROM statuses s JOIN users u ON u.id=s.user_id
      WHERE s.expires_at > NOW()
        AND s.user_id <> $1
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id=$1 AND b.blocked_id=s.user_id)
             OR (b.blocker_id=s.user_id AND b.blocked_id=$1)
        )
      UNION ALL
      SELECT s.id, s.user_id, u.username, u.avatar, s.text, s.media_url, s.created_at, s.expires_at
      FROM statuses s JOIN users u ON u.id=s.user_id
      WHERE s.expires_at > NOW() AND s.user_id = $1
      ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "Не удалось загрузить статусы" }); }
});

app.post("/api/statuses/upload", auth, uploadStatusImage.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Не удалось получить фото. Разрешены JPG, PNG, WebP или GIF до 8 МБ." });
  res.json({ url: `/status-media/${req.file.filename}` });
});

app.post("/api/statuses", auth, async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
    const text = String(req.body.text || "").trim();
    const mediaUrl = String(req.body.mediaUrl || "").trim();
    if (text.length > 280) return res.status(400).json({ error: "Текст статуса — максимум 280 символов" });
    if (!text && !mediaUrl) return res.status(400).json({ error: "Добавьте текст или фото" });
    if (mediaUrl && !mediaUrl.startsWith("/status-media/")) return res.status(400).json({ error: "Некорректное фото" });
    await query("DELETE FROM statuses WHERE expires_at <= NOW()");
    const row = await one(`INSERT INTO statuses(user_id,text,media_url,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '24 hours')
      RETURNING id,user_id,text,media_url,created_at,expires_at`, [user.id, text, mediaUrl]);
    res.json({ ...row, username: user.username });
  } catch (e) { console.error(e); res.status(500).json({ error: "Не удалось сохранить статус" }); }
});

app.delete("/api/statuses/:id", auth, async (req, res) => {
  try {
    const uid = await currentUserId(req);
    const row = await one("DELETE FROM statuses WHERE id=$1 AND user_id=$2 RETURNING id,media_url", [Number(req.params.id), uid]);
    if (!row) return res.status(404).json({ error: "Статус не найден" });
    if (row.media_url && row.media_url.startsWith("/status-media/")) fs.unlink(path.join(statusMediaDir, path.basename(row.media_url)), () => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Не удалось удалить статус" }); }
});

app.get("/api/users", auth, async (req, res) => {
  const raw = String(req.query.q || "").trim().replace(/^@+/, "");
  if (!raw) {
    const chats = await many(`
      SELECT u.id,u.username,EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified,MAX(m.id) AS last_message_id
      FROM users u JOIN messages m ON (m.sender_id=u.id AND m.receiver_id=$1) OR (m.receiver_id=u.id AND m.sender_id=$2)
      WHERE u.id<>$3
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id=$3 AND b.blocked_id=u.id)
             OR (b.blocker_id=u.id AND b.blocked_id=$3)
        )
      GROUP BY u.id,u.username ORDER BY last_message_id DESC LIMIT 50`, [req.user.id, req.user.id, req.user.id]);
    res.set("Cache-Control", "no-store");
    const online=onlineUserIds();
    return res.json(chats.map(({ id, username, verified }) => ({ id, username, verified: !!verified, online: online.has(Number(id)) })));
  }
  const users = await many(`SELECT u.id,u.username,EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified
    FROM users u
    WHERE u.id<>$1
      AND LOWER(u.username) LIKE LOWER($2)
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks b
        WHERE (b.blocker_id=$1 AND b.blocked_id=u.id)
           OR (b.blocker_id=u.id AND b.blocked_id=$1)
      )
    ORDER BY LOWER(username) LIMIT 50`, [req.user.id, `%${raw}%`]);
  res.set("Cache-Control", "no-store");
  const online=onlineUserIds();
  res.json(users.map(u => ({ ...u, verified: !!u.verified, online: online.has(Number(u.id)) })));
});

app.get("/api/messages/:userId", auth, async (req, res) => {
  const other = Number(req.params.userId);
  if (await isBlockedBetween(req.user.id, other)) return res.json([]);
  const rows = await many(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,m.reply_to_id,m.edited_at,u.username sender_name,
    rm.text AS reply_text, ru.username AS reply_sender,
    COALESCE((SELECT json_agg(json_build_object('reaction',mr.reaction,'userId',mr.user_id)) FROM message_reactions mr WHERE mr.message_id=m.id),'[]'::json) AS reactions,
    EXISTS(SELECT 1 FROM message_favorites mf WHERE mf.message_id=m.id AND mf.user_id=$1) AS favorite,
    EXISTS(SELECT 1 FROM message_pins mp WHERE mp.message_id=m.id) AS pinned
    FROM messages m JOIN users u ON u.id=m.sender_id
    LEFT JOIN messages rm ON rm.id=m.reply_to_id LEFT JOIN users ru ON ru.id=rm.sender_id
    WHERE (m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$3 AND m.receiver_id=$4)
    ORDER BY m.id ASC`, [req.user.id, other, other, req.user.id]);
  res.json(rows);
});

app.post("/api/messages/:userId/read", auth, async (req, res) => {
  const other = Number(req.params.userId);
  if (!other || await isBlockedBetween(req.user.id, other)) return res.json({ ok:true, ids:[] });
  const rows = await many(`UPDATE messages SET read_at=NOW()
    WHERE sender_id=$1 AND receiver_id=$2 AND read_at IS NULL
    RETURNING id`, [other, req.user.id]);
  const ids=rows.map(r=>Number(r.id));
  if(ids.length) push(other,{type:"messages-read",messageIds:ids,readerId:Number(req.user.id)});
  res.json({ok:true,ids});
});

app.get("/api/referral", auth, async (req, res) => {
  try {
    const code=await ensureReferralCode(req.user.id);
    const row=await one("SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id=$1",[Number(req.user.id)]);
    const count=Number(row?.count||0);
    const nextAt=count===0?3:(Math.ceil(count/3)*3);
    res.json({code,count,nextAt,totalEarned:Math.floor(count/3)*150,rewardPerFriend:50,rewardPerThree:150});
  } catch(e){console.error(e);res.status(500).json({error:"Не удалось загрузить реферальную информацию"});}
});

app.get("/api/rewards", auth, async (req, res) => {
  const oranges = await grantRewardsForBalance(req.user.id, false);
  const rows = await many("SELECT sticker_id FROM user_stickers WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const gifts = await many("SELECT sticker_id FROM profile_gifts WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const owned = new Set(rows.map(r=>Number(r.sticker_id)));
  const profileGift = new Set(gifts.map(r=>Number(r.sticker_id)));
  res.json({
    oranges,
    rewards: [
      {stickerId:REWARD_STICKER_ID, stickerSrc:REWARD_STICKER_SRC, unlockAt:50, owned:owned.has(REWARD_STICKER_ID), profileGift:profileGift.has(REWARD_STICKER_ID), name:'Капибара'},
      {stickerId:REWARD_STICKER_150_ID, stickerSrc:REWARD_STICKER_150_SRC, unlockAt:150, owned:owned.has(REWARD_STICKER_150_ID), profileGift:profileGift.has(REWARD_STICKER_150_ID), name:'Королевская капибара'},
      {stickerId:REWARD_STICKER_300_ID, stickerSrc:REWARD_STICKER_300_SRC, unlockAt:300, owned:owned.has(REWARD_STICKER_300_ID), profileGift:profileGift.has(REWARD_STICKER_300_ID), name:'БКТ — Капибара и Туф'}
    ]
  });
});

app.get("/api/oranges", auth, async (req,res)=>{
  await ensureRewardWallet(req.user.id); await checkOrangeAchievements(req.user.id);
  const wallet=await one("SELECT oranges FROM reward_wallets WHERE user_id=$1",[req.user.id]);
  const daily=await getDailyOrangeStatus(req.user.id);
  const days=await one(`SELECT COUNT(*)::int AS count FROM daily_orange_bonus WHERE user_id=$1`,[req.user.id]);
  const achievements=await many(`SELECT a.key,a.name,a.description,a.icon,a.badge,a.sort_order,ua.obtained_at FROM orange_achievements a LEFT JOIN user_orange_achievements ua ON ua.achievement_key=a.key AND ua.user_id=$1 ORDER BY a.sort_order`,[req.user.id]);
  const badge=await one("SELECT badge_type,badge_value FROM user_profile_badges WHERE user_id=$1",[req.user.id]);
  const frame=await one("SELECT frame_id FROM user_profile_frames WHERE user_id=$1",[req.user.id]);
  res.json({
    oranges:Number(wallet?.oranges||0),
    daily:{...daily,days:Number(days?.count||0),cycleLength:20,minAmount:5,maxAmount:24},
    badge:badge?{type:badge.badge_type,value:badge.badge_value}:null,
    frame:frame?{type:"frame",value:frame.frame_id,src:frame.frame_id==="capybara_orange_frame"?ORANGE_FRAME_SRC:null}:null,
    achievements
  });
});
app.post("/api/oranges/daily", auth, async (req,res)=>{ try { const result=await claimDailyOrangeBonus(req.user.id); if(!result.claimed)return res.status(409).json({error:"Ежедневный бонус уже получен сегодня",...result}); res.json(result); } catch(e){ console.error(e); res.status(500).json({error:"Не удалось получить ежедневный бонус"}); } });
app.get("/api/oranges/history", auth, async (req,res)=>{
  const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));
  const rows=await many(`SELECT id,amount,balance_after,type,description,metadata,created_at FROM orange_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,[req.user.id,limit]);
  res.json(rows);
});
app.get("/api/oranges/leaderboard", auth, async (req,res)=>{
  const rows=await many(`SELECT u.id,u.username,u.avatar,r.oranges,EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified FROM reward_wallets r JOIN users u ON u.id=r.user_id WHERE u.is_blocked=FALSE ORDER BY r.oranges DESC,u.id ASC LIMIT 50`);
  res.json(rows.map((r,i)=>({...r,rank:i+1,oranges:Number(r.oranges||0)})));
});
app.get("/api/oranges/shop", auth, async (req,res)=>{
  const rows=await many(`SELECT i.id,i.name,i.description,i.icon,i.price,i.item_type,EXISTS(SELECT 1 FROM user_orange_items ui WHERE ui.user_id=$1 AND ui.item_id=i.id) AS owned FROM orange_shop_items i WHERE i.active=TRUE ORDER BY i.price,i.id`,[req.user.id]);
  res.json(rows.map(r=>({...r,price:Number(r.price),owned:!!r.owned,frameSrc:r.item_type==="frame" && r.id==="capybara_orange_frame"?ORANGE_FRAME_SRC:null})));
});
app.post("/api/oranges/shop/:id/buy", auth, async (req,res)=>{
  const item=await one("SELECT id,name,description,icon,price,item_type FROM orange_shop_items WHERE id=$1 AND active=TRUE",[String(req.params.id)]);
  if(!item)return res.status(404).json({error:"Предмет не найден"});
  const existing=await one("SELECT 1 FROM user_orange_items WHERE user_id=$1 AND item_id=$2",[req.user.id,item.id]);
  if(existing)return res.status(409).json({error:"Предмет уже куплен"});
  const balance=await spendOranges(req.user.id,Number(item.price),"shop_purchase",`Покупка: ${item.name}`,{itemId:item.id});
  if(balance===null)return res.status(400).json({error:`Недостаточно 🍊. Нужно ${item.price} 🍊.`});
  await query("INSERT INTO user_orange_items(user_id,item_id) VALUES($1,$2)",[req.user.id,item.id]);
  if(item.item_type==='badge') await query(`INSERT INTO user_profile_badges(user_id,badge_type,badge_value) VALUES($1,'shop',$2) ON CONFLICT(user_id) DO UPDATE SET badge_type=EXCLUDED.badge_type,badge_value=EXCLUDED.badge_value,updated_at=NOW()`,[req.user.id,item.id]);
  if(item.item_type==='frame') await query(`INSERT INTO user_profile_frames(user_id,frame_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET frame_id=EXCLUDED.frame_id,updated_at=NOW()`,[req.user.id,item.id]);
  await checkOrangeAchievements(req.user.id);
  res.json({ok:true,balance,item:{...item,price:Number(item.price),frameSrc:item.id==="capybara_orange_frame"?ORANGE_FRAME_SRC:null}});
});
app.post("/api/oranges/badge", auth, async (req,res)=>{
  const key=String(req.body?.achievementKey||"");
  const a=await one("SELECT key,badge FROM orange_achievements WHERE key=$1",[key]);
  const owned=await one("SELECT 1 FROM user_orange_achievements WHERE user_id=$1 AND achievement_key=$2",[req.user.id,key]);
  if(!a||!owned)return res.status(400).json({error:"Достижение ещё не получено"});
  await query(`INSERT INTO user_profile_badges(user_id,badge_type,badge_value) VALUES($1,'achievement',$2) ON CONFLICT(user_id) DO UPDATE SET badge_type='achievement',badge_value=EXCLUDED.badge_value,updated_at=NOW()`,[req.user.id,a.badge]);
  res.json({ok:true,badge:{type:'achievement',value:a.badge}});
});

app.post("/api/captcha/challenge", auth, async (req, res) => {
  const enabled=String(await getAdminSetting("sartsna.enabled","true")).toLowerCase()!=="false";
  if(!enabled)return res.status(403).json({error:"САРТСНА временно отключена администраторами"});
  await ensureRewardWallet(req.user.id);
  await query("DELETE FROM captcha_challenges WHERE user_id=$1 OR expires_at < NOW()", [req.user.id]);

  const mode = crypto.randomInt(0, 5);
  let expression = "";
  let answer = 0;
  if (mode === 0) {
    const a = crypto.randomInt(18, 65), b = crypto.randomInt(7, 28), c = crypto.randomInt(3, 16), d = crypto.randomInt(2, 12);
    answer = (a * b) + (c * d) - (a % d);
    expression = `(${a} × ${b}) + (${c} × ${d}) − (${a} mod ${d})`;
  } else if (mode === 1) {
    const a = crypto.randomInt(15, 50), b = crypto.randomInt(4, 20), c = crypto.randomInt(3, 15);
    answer = (a + b) * c - (a % c);
    expression = `(${a} + ${b}) × ${c} − (${a} mod ${c})`;
  } else if (mode === 2) {
    const a = crypto.randomInt(20, 90), b = crypto.randomInt(8, 25), c = crypto.randomInt(2, 10);
    answer = Math.floor((a * b) / c) + (a % c);
    expression = `⌊${a} × ${b} ÷ ${c}⌋ + (${a} mod ${c})`;
  } else if (mode === 3) {
    const a = crypto.randomInt(12, 45), b = crypto.randomInt(5, 19), c = crypto.randomInt(3, 12);
    const inner = a * b - c;
    answer = inner * inner - b;
    expression = `(${a} × ${b} − ${c})² − ${b}`;
  } else {
    const a = crypto.randomInt(10, 40), b = crypto.randomInt(3, 12), c = crypto.randomInt(2, 9);
    const left = (a + b) * c;
    const right = a * c + b * c;
    answer = left === right ? 1 : 0;
    expression = `Какой вариант верен?  A: (${a}+${b})×${c} = ${left}   B: ${a}×${c}+${b}×${c} = ${right}`;
  }

  const options = new Set([answer]);
  const spread = Math.max(7, Math.floor(Math.abs(answer) * 0.06));
  while (options.size < 5) {
    const delta = crypto.randomInt(-Math.max(25, spread * 2), Math.max(25, spread * 2) + 1) || 1;
    options.add(Math.max(0, answer + delta));
  }
  const shuffled = [...options].sort(() => crypto.randomInt(-1, 2));
  const token = crypto.randomBytes(24).toString("hex");
  await query("INSERT INTO captcha_challenges(token,user_id,answer,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '5 minutes')", [token, req.user.id, answer]);
  res.json({ token, expression, options: shuffled, difficulty:"hard", mode });
});

app.post("/api/captcha/verify", auth, async (req, res) => {
  const token = String(req.body?.token || "");
  const answer = Number(req.body?.answer);
  if (!token || !Number.isInteger(answer)) return res.status(400).json({ error: "Некорректная CAPTCHA" });
  const ch = await one("SELECT token,answer FROM captcha_challenges WHERE token=$1 AND user_id=$2 AND used=FALSE AND expires_at>NOW()", [token, req.user.id]);
  if (!ch || Number(ch.answer) !== answer) return res.status(400).json({ error: "Неверный ответ CAPTCHA" });
  await query("UPDATE captcha_challenges SET used=TRUE WHERE token=$1", [token]);
  const captchaReward=settingNumber(await getAdminSetting("sartsna.captcha_reward","5"),5);
  const oranges = await addOranges(req.user.id,captchaReward,"captcha","Правильная САРТСНА",{challenge:token});
  await grantRewardsForBalance(req.user.id, false);
  const rows = await many("SELECT sticker_id FROM user_stickers WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const owned = new Set(rows.map(r=>Number(r.sticker_id)));
  res.json({
    ok:true,
    oranges,
    rewards:[
      {stickerId:REWARD_STICKER_ID, stickerSrc:REWARD_STICKER_SRC, unlockAt:50, owned:owned.has(REWARD_STICKER_ID), name:'Капибара'},
      {stickerId:REWARD_STICKER_150_ID, stickerSrc:REWARD_STICKER_150_SRC, unlockAt:150, owned:owned.has(REWARD_STICKER_150_ID), name:'Королевская капибара'},
      {stickerId:REWARD_STICKER_300_ID, stickerSrc:REWARD_STICKER_300_SRC, unlockAt:300, owned:owned.has(REWARD_STICKER_300_ID), name:'БКТ — Капибара и Туф'}
    ]
  });
});

app.post("/api/stickers/:id/profile", auth, async (req, res) => {
  const stickerId = Number(req.params.id);
  if (!REWARD_STICKER_IDS.includes(stickerId)) return res.status(404).json({ error: "Стикер не найден" });
  const owned = await one("SELECT 1 FROM user_stickers WHERE user_id=$1 AND sticker_id=$2", [req.user.id, stickerId]);
  if (!owned) return res.status(403).json({ error: "Сначала получите этот стикер" });
  await query("INSERT INTO profile_gifts(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.user.id, stickerId]);
  res.json({ ok:true });
});

app.delete("/api/stickers/:id/profile", auth, async (req, res) => {
  const stickerId = Number(req.params.id);
  await query("DELETE FROM profile_gifts WHERE user_id=$1 AND sticker_id=$2", [req.user.id, stickerId]);
  res.json({ ok:true });
});

app.get("/api/gifts/catalog", auth, async (req, res) => {
  await ensureRewardWallet(req.user.id);
  const walletRow = await one("SELECT oranges FROM reward_wallets WHERE user_id=$1", [req.user.id]);
  const owned = await many("SELECT sticker_id FROM user_stickers WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, GIFT_CATALOG.map(g=>g.stickerId)]);
  const ownedSet = new Set(owned.map(r=>Number(r.sticker_id)));
  res.json({ oranges: Number(walletRow?.oranges || 0), gifts: GIFT_CATALOG.map(g=>({...g, owned: ownedSet.has(g.stickerId)})) });
});

app.post("/api/stickers/:id/send", auth, async (req, res) => {
  const stickerId = Number(req.params.id);
  const receiver = Number(req.body?.receiverId);
  const gift = GIFT_CATALOG.find(g => g.stickerId === stickerId);
  if (!gift || !receiver || receiver === Number(req.user.id)) return res.status(400).json({ error: "Некорректный подарок" });
  if (await isBlockedBetween(req.user.id, receiver)) return res.status(403).json({ error: "Пользователь заблокирован" });
  const target = await one("SELECT id,username FROM users WHERE id=$1", [receiver]);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });
  const balanceAfterSpend = await spendOranges(req.user.id,gift.price,"gift_send",`Подарок: ${gift.name}`,{stickerId:gift.stickerId,receiverId:receiver});
  if (balanceAfterSpend === null) return res.status(400).json({ error: `Недостаточно 🍊. Нужно ${gift.price} 🍊.` });
  await query("INSERT INTO user_stickers(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [receiver, stickerId]);
  await query("INSERT INTO profile_gifts(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [receiver, stickerId]);
  const inserted = await one("INSERT INTO messages(sender_id,receiver_id,text) VALUES($1,$2,$3) RETURNING id", [req.user.id, receiver, `[STICKER]${gift.src}`]);
  const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,u.username sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [inserted.id]);
  push(receiver, {type:"message",message});
  push(req.user.id, {type:"message",message});
  res.json({ ...message, oranges: Number(balanceAfterSpend), gift });
});

app.get("/api/users/:id/gifts", auth, async (req, res) => {
  const userId = Number(req.params.id);
  const gifts = await many(`SELECT sticker_id,added_at FROM profile_gifts WHERE user_id=$1 ORDER BY added_at DESC`, [userId]);
  res.json(gifts.map(g=>({stickerId:Number(g.sticker_id),src:`/stickers/${Number(g.sticker_id)}.webp`,addedAt:g.added_at})));
});

app.get("/api/push/public-key", auth, (req, res) => res.json({ publicKey: vapidKeys.publicKey }));
app.post("/api/push/subscribe", auth, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: "Некорректная push-подписка" });
  await query(`INSERT INTO push_subscriptions(user_id,endpoint,subscription_json) VALUES($1,$2,$3)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription_json=EXCLUDED.subscription_json`, [req.user.id, sub.endpoint, JSON.stringify(sub)]);
  res.json({ ok: true });
});
app.delete("/api/push/subscribe", auth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  if (endpoint) await query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [req.user.id, endpoint]);
  res.json({ ok: true });
});

async function addCallHistory(callerId, calleeId, callType) {
  const text = callType === "video" ? "📹 Видеозвонок" : "📞 Аудиозвонок";
  const message = await one(`INSERT INTO messages(sender_id,receiver_id,text) VALUES($1,$2,$3)
    RETURNING id,sender_id,receiver_id,text,created_at`, [callerId, calleeId, text]);
  return one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,u.username sender_name
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [message.id]);
}
function notifyCall(calleeId, callerUsername, callType, callId) {
  pushNotification(calleeId, { type: "incoming-call", title: callType === "video" ? "📹 Входящий видеозвонок" : "📞 Входящий аудиозвонок", body: `@${callerUsername} звонит вам`, callId, callerUsername, callType }).catch(() => {});
}

app.post("/api/messages", auth, async (req, res) => {
  try {
    const receiver = Number(req.body.receiverId);
    const text = String(req.body.text || "").trim();
    if (!receiver || !text || text.length > 4000) return res.status(400).json({ error: "Некорректное сообщение" });
    const target = await one("SELECT id,username FROM users WHERE id=$1", [receiver]);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });
    if (isAutomaticThreat(text)) {
      const result = await permanentlyBotBanUser(req.user.id, "Угроза насилия или угроза доксинга");
      if (result.protected) return res.status(403).json({ error: "Сообщение нарушает правила безопасности" });
      return res.status(403).json({ error: "Аккаунт заблокирован автоматической модерацией за угрозу. Все сообщения удалены, номер телефона заблокирован навсегда." });
    }
    if (await isBlockedBetween(req.user.id, receiver)) return res.status(403).json({ error: "Нельзя отправить сообщение: пользователь заблокирован" });
    const replyToId = Number(req.body?.replyToId || 0) || null;
    const inserted = await one("INSERT INTO messages(sender_id,receiver_id,text,reply_to_id) VALUES($1,$2,$3,$4) RETURNING id", [req.user.id, receiver, text, replyToId]);
    const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,m.reply_to_id,m.edited_at,u.username sender_name,
      rm.text AS reply_text, ru.username AS reply_sender,
      COALESCE((SELECT json_agg(json_build_object('reaction',mr.reaction,'userId',mr.user_id)) FROM message_reactions mr WHERE mr.message_id=m.id),'[]'::json) AS reactions,
      EXISTS(SELECT 1 FROM message_favorites mf WHERE mf.message_id=m.id AND mf.user_id=$2) AS favorite,
      EXISTS(SELECT 1 FROM message_pins mp WHERE mp.message_id=m.id) AS pinned
      FROM messages m JOIN users u ON u.id=m.sender_id
      LEFT JOIN messages rm ON rm.id=m.reply_to_id LEFT JOIN users ru ON ru.id=rm.sender_id
      WHERE m.id=$1`, [inserted.id, req.user.id]);
    const delivered = push(receiver, { type: "message", message });
    if (!delivered) pushNotification(receiver, { type: "message", title: message.sender_name || "Новое сообщение", body: message.text || "Новое сообщение", senderId: message.sender_id, message }).catch(() => {});
    push(req.user.id, { type: "message", message });
    res.json(message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
  }
});

app.patch("/api/messages/:id", auth, async (req, res) => {
  const id=Number(req.params.id), text=String(req.body?.text||'').trim();
  if(!id || !text || text.length>4000) return res.status(400).json({error:"Некорректный текст"});
  const msg=await one("SELECT id,sender_id FROM messages WHERE id=$1",[id]);
  if(!msg) return res.status(404).json({error:"Сообщение не найдено"});
  if(Number(msg.sender_id)!==Number(req.user.id)) return res.status(403).json({error:"Можно редактировать только своё сообщение"});
  const row=await one("UPDATE messages SET text=$1,edited_at=NOW() WHERE id=$2 RETURNING id,sender_id,receiver_id,text,created_at,read_at,reply_to_id,edited_at",[text,id]);
  const full=await one(`SELECT m.*,u.username sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`,[id]);
  push(full.receiver_id,{type:"message-edited",message:full}); push(full.sender_id,{type:"message-edited",message:full});
  res.json(full);
});

app.post("/api/messages/:id/reaction", auth, async (req,res)=>{
  const id=Number(req.params.id), reaction=String(req.body?.reaction||'').trim();
  const allowed=new Set(['👍','❤️','😂','😮','😢','🔥','👏','🎉']);
  if(!id || !allowed.has(reaction)) return res.status(400).json({error:"Недопустимая реакция"});
  const msg=await one("SELECT id,sender_id,receiver_id FROM messages WHERE id=$1",[id]);
  if(!msg) return res.status(404).json({error:"Сообщение не найдено"});
  const old=await one("SELECT reaction FROM message_reactions WHERE message_id=$1 AND user_id=$2",[id,req.user.id]);
  if(old?.reaction===reaction) await query("DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2",[id,req.user.id]);
  else await query("INSERT INTO message_reactions(message_id,user_id,reaction) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=EXCLUDED.reaction,created_at=NOW()",[id,req.user.id,reaction]);
  const reactions=await many("SELECT user_id AS \"userId\",reaction FROM message_reactions WHERE message_id=$1",[id]);
  push(msg.sender_id,{type:"message-reactions",messageId:id,reactions}); push(msg.receiver_id,{type:"message-reactions",messageId:id,reactions});
  res.json({ok:true,reactions});
});

app.post("/api/messages/:id/favorite", auth, async (req,res)=>{
  const id=Number(req.params.id); if(!id)return res.status(400).json({error:"Некорректное сообщение"});
  const exists=await one("SELECT 1 FROM message_favorites WHERE user_id=$1 AND message_id=$2",[req.user.id,id]);
  if(exists) await query("DELETE FROM message_favorites WHERE user_id=$1 AND message_id=$2",[req.user.id,id]);
  else await query("INSERT INTO message_favorites(user_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.user.id,id]);
  res.json({favorite:!exists});
});

app.post("/api/messages/:id/pin", auth, async (req,res)=>{
  const id=Number(req.params.id); const msg=await one("SELECT id,sender_id,receiver_id FROM messages WHERE id=$1",[id]);
  if(!msg)return res.status(404).json({error:"Сообщение не найдено"});
  if(Number(msg.sender_id)!==Number(req.user.id) && Number(msg.receiver_id)!==Number(req.user.id))return res.status(403).json({error:"Нет доступа"});
  const exists=await one("SELECT 1 FROM message_pins WHERE message_id=$1",[id]);
  if(exists)await query("DELETE FROM message_pins WHERE message_id=$1",[id]);
  else await query("INSERT INTO message_pins(message_id,pinned_by) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.user.id]);
  res.json({pinned:!exists});
});

app.get("/api/messages/search", auth, async (req,res)=>{
  const q=String(req.query.q||'').trim(); const other=Number(req.query.userId||0);
  if(q.length<2)return res.json([]);
  const rows=await many(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.edited_at,u.username sender_name\n    FROM messages m JOIN users u ON u.id=m.sender_id\n    WHERE ((m.sender_id=$1 AND m.receiver_id=$2) OR (m.sender_id=$2 AND m.receiver_id=$1)) AND m.text ILIKE $3\n    ORDER BY m.id DESC LIMIT 100`,[req.user.id,other,'%'+q+'%']);
  res.json(rows);
});

app.delete("/api/messages/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const msg = await one("SELECT id,sender_id,receiver_id,text FROM messages WHERE id=$1", [id]);
  if (!msg) return res.status(404).json({ error: "Сообщение не найдено" });
  if (Number(msg.sender_id) !== Number(req.user.id)) return res.status(403).json({ error: "Можно удалить только своё сообщение" });
  await query("DELETE FROM messages WHERE id=$1", [id]);
  const mediaMatch = String(msg.text || "").match(/^\[(?:VOICE|VIDEO_NOTE)\](\/media\/[^?\s]+)$/);
  if (mediaMatch) {
    const file = path.join(mediaDir, path.basename(mediaMatch[1]));
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
  push(msg.receiver_id, { type: "message-deleted", messageId: id });
  push(msg.sender_id, { type: "message-deleted", messageId: id });
  res.json({ ok: true });
});

app.post("/api/media", auth, uploadMedia.single("media"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Файл не получен" });
    const receiverId = Number(req.body.receiverId);
    const kind = String(req.body.kind || "");
    if (!receiverId || !["audio", "video", "image"].includes(kind)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Некорректные параметры" });
    }
    const receiver = await one("SELECT id,username FROM users WHERE id=$1", [receiverId]);
    if (!receiver) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Пользователь не найден" });
    }
    const url = `/media/${req.file.filename}`;
    const text = kind === "audio" ? `[VOICE]${url}` : kind === "image" ? `[IMAGE]${url}` : `[VIDEO]${url}`;
    const inserted = await one("INSERT INTO messages(sender_id,receiver_id,text) VALUES($1,$2,$3) RETURNING id", [req.user.id, receiverId, text]);
    const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,m.reply_to_id,m.edited_at,u.username sender_name,
      NULL AS reply_text, NULL AS reply_sender, '[]'::json AS reactions, FALSE AS favorite, FALSE AS pinned
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [inserted.id]);
    push(receiverId, { type: "message", message });
    push(req.user.id, { type: "message", message });
    res.json(message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось сохранить медиа" });
  }
});

app.post("/api/groups", auth, async (req, res) => {
  const meUser = await currentUser(req);
  if (!meUser) return res.status(401).json({ error: "Сессия недействительна" });
  const name = String(req.body?.name || "").trim();
  const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(Number).filter(Number.isInteger) : [];
  if (!name || name.length > 80) return res.status(400).json({ error: "Введите название группы" });
  if (name.toLowerCase() === "бкт сообщество".toLowerCase()) return res.status(409).json({ error: "Эта группа создаётся автоматически" });
  const uniqueMembers = [...new Set([Number(meUser.id), ...memberIds])].slice(0, 100);
  const client = await pool.connect();
  let groupId;
  try {
    await client.query("BEGIN");
    const groupResult = await client.query("INSERT INTO groups(name,owner_id) VALUES($1,$2) RETURNING id", [name, meUser.id]);
    groupId = Number(groupResult.rows[0].id);
    for (const uid of uniqueMembers) {
      const exists = await client.query("SELECT id FROM users WHERE id=$1", [uid]);
      if (exists.rowCount) await client.query("INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id) DO NOTHING", [groupId, uid, uid === Number(meUser.id) ? "owner" : "member"]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const group = await one("SELECT id,name,owner_id,created_at FROM groups WHERE id=$1", [groupId]);
  const members = await many(`SELECT u.id,u.username,gm.role FROM group_members gm JOIN users u ON u.id=gm.user_id
    WHERE gm.group_id=$1 ORDER BY CASE gm.role WHEN 'owner' THEN 0 ELSE 1 END,u.username`, [groupId]);
  for (const m of members) push(m.id, { type: "group-created", group, members });
  res.json({ ...group, members });
});

app.get("/api/groups", auth, async (req, res) => {
  const groups = await many(`SELECT g.id,g.name,g.owner_id,g.created_at FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE gm.user_id=$1 ORDER BY g.created_at DESC`, [req.user.id]);
  const result = [];
  for (const g of groups) {
    const members = await many(`SELECT u.id,u.username,gm.role FROM group_members gm JOIN users u ON u.id=gm.user_id
      WHERE gm.group_id=$1 ORDER BY u.username`, [g.id]);
    result.push({ ...g, members });
  }
  res.set("Cache-Control", "no-store");
  res.json(result);
});

app.post("/api/groups/:id/members", auth, async (req, res) => {
  const groupId = Number(req.params.id), userId = Number(req.body.userId);
  const group = await one("SELECT id,owner_id FROM groups WHERE id=$1", [groupId]);
  if (!group || Number(group.owner_id) !== Number(req.user.id)) return res.status(403).json({ error: "Только создатель группы может добавлять участников" });
  if (!(await one("SELECT id FROM users WHERE id=$1", [userId]))) return res.status(404).json({ error: "Пользователь не найден" });
  await query("INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(group_id,user_id) DO NOTHING", [groupId, userId]);
  res.json({ ok: true });
});

app.delete("/api/groups/:id/members/:userId", auth, async (req, res) => {
  const groupId = Number(req.params.id), userId = Number(req.params.userId);
  const group = await one("SELECT id,owner_id FROM groups WHERE id=$1", [groupId]);
  if (!group || Number(group.owner_id) !== Number(req.user.id)) return res.status(403).json({ error: "Нет доступа" });
  if (userId === Number(group.owner_id)) return res.status(400).json({ error: "Нельзя удалить создателя" });
  await query("DELETE FROM group_members WHERE group_id=$1 AND user_id=$2", [groupId, userId]);
  res.json({ ok: true });
});

app.get("/api/groups/:id/messages", auth, async (req, res) => {
  const groupId = Number(req.params.id);
  if (!(await isGroupMember(groupId, req.user.id))) return res.status(403).json({ error: "Нет доступа" });
  const messages = await many(`SELECT gm.id,gm.group_id,gm.sender_id,gm.text,gm.created_at,u.username sender_name
    FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.group_id=$1 ORDER BY gm.id ASC`, [groupId]);
  res.json(messages);
});

app.delete("/api/groups/messages/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const msg = await one("SELECT id,group_id,sender_id FROM group_messages WHERE id=$1", [id]);
  if (!msg) return res.status(404).json({ error: "Сообщение не найдено" });
  if (Number(msg.sender_id) !== Number(req.user.id)) return res.status(403).json({ error: "Можно удалить только своё сообщение" });
  await query("DELETE FROM group_messages WHERE id=$1", [id]);
  const members = await many("SELECT user_id FROM group_members WHERE group_id=$1", [msg.group_id]);
  for (const m of members) push(m.user_id, { type: "group-message-deleted", messageId: id });
  res.json({ ok: true });
});

app.post("/api/groups/:id/messages", auth, async (req, res) => {
  const groupId = Number(req.params.id);
  const text = String(req.body.text || "").trim();
  if (!(await isGroupMember(groupId, req.user.id))) return res.status(403).json({ error: "Нет доступа" });
  if (await isCommunityGroup(groupId) && !canPostInCommunity(req.user.username)) {
    return res.status(403).json({ error: "В группе «БКТ Сообщество» могут писать только Brozi и Vlad" });
  }
  if (!text || text.length > 5000) return res.status(400).json({ error: "Некорректное сообщение" });
  if (isAutomaticThreat(text)) {
    const result = await permanentlyBotBanUser(req.user.id, "Угроза насилия или угроза доксинга");
    if (result.protected) return res.status(403).json({ error: "Сообщение нарушает правила безопасности" });
    return res.status(403).json({ error: "Аккаунт заблокирован автоматической модерацией за угрозу. Все сообщения удалены, номер телефона заблокирован навсегда." });
  }
  const group = await one("SELECT id,name FROM groups WHERE id=$1", [groupId]);
  const inserted = await one("INSERT INTO group_messages(group_id,sender_id,text) VALUES($1,$2,$3) RETURNING id", [groupId, req.user.id, text]);
  const msg = await one(`SELECT gm.id,gm.group_id,gm.sender_id,gm.text,gm.created_at,u.username sender_name
    FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.id=$1`, [inserted.id]);
  const members = await many("SELECT user_id FROM group_members WHERE group_id=$1", [groupId]);
  for (const m of members) {
    const delivered = push(m.user_id, { type: "group-message", message: msg });
    if (!delivered) pushNotification(m.user_id, { type: "group-message", title: group?.name || "Новое сообщение", body: msg.text || "Новое сообщение", groupId, message: msg }).catch(() => {});
  }
  res.json(msg);
});

app.get("/api/calls/:id/state", auth, async (req, res) => {
  try {
    const callId = String(req.params.id || "");
    if (!callId) return res.status(400).json({error:"Некорректный звонок"});
    const call = await one(`SELECT id,caller_id,callee_id,call_type,offer_json,answer_json,status,created_at
      FROM call_sessions WHERE id=$1 AND (caller_id=$2 OR callee_id=$2)`, [callId, Number(req.user.id)]);
    if (!call) return res.status(404).json({error:"Звонок не найден"});
    const candidates = await many(`SELECT sender_id,candidate_json FROM call_ice_candidates
      WHERE call_id=$1 AND sender_id<>$2 ORDER BY id`, [callId, Number(req.user.id)]);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      id: call.id, callerId: Number(call.caller_id), calleeId: Number(call.callee_id),
      callType: call.call_type, status: call.status,
      offer: call.offer_json ? JSON.parse(call.offer_json) : null,
      answer: call.answer_json ? JSON.parse(call.answer_json) : null,
      iceCandidates: candidates.map(x => JSON.parse(x.candidate_json))
    });
  } catch (e) { console.error("call state error:", e); res.status(500).json({error:"Не удалось получить состояние звонка"}); }
});

app.get("/api/calls/pending", auth, async (req, res) => {
  const rows = await many(`SELECT c.id,c.caller_id,c.callee_id,c.call_type,c.offer_json,c.created_at,u.username caller_username
    FROM call_sessions c JOIN users u ON u.id=c.caller_id WHERE c.callee_id=$1 AND c.status='ringing'
      AND c.created_at > NOW() - INTERVAL '90 seconds'
    ORDER BY c.created_at DESC LIMIT 5`, [Number(req.user.id)]);
  const out=[];
  for(const r of rows){
    const candidates=await many(`SELECT candidate_json FROM call_ice_candidates WHERE call_id=$1 ORDER BY id`, [r.id]);
    out.push({ ...r, offer: JSON.parse(r.offer_json), iceCandidates:candidates.map(x=>JSON.parse(x.candidate_json)) });
  }
  res.json(out);
});

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const user = jwt.verify(url.searchParams.get("token") || "", JWT_SECRET);
    const dbUser=await one("SELECT id,username,is_blocked FROM users WHERE id=$1",[Number(user.id)]);
    if(!dbUser || dbUser.is_blocked) throw new Error("blocked account");
    if(user.jti && !(await one("SELECT jti FROM user_sessions WHERE jti=$1 AND user_id=$2 AND revoked_at IS NULL",[String(user.jti),Number(user.id)]))) throw new Error("revoked session");
    const wsIp=requestIp(req);
    if(await one("SELECT id FROM admin_ip_bans WHERE ip=$1 AND (expires_at IS NULL OR expires_at>NOW())",[wsIp]) && !canManageAccounts(dbUser.username)) throw new Error("banned ip");
    const wasOnline=hasLiveSocket(user.id);
    await query("UPDATE users SET last_seen_at=NOW() WHERE id=$1", [Number(user.id)]).catch(()=>{});
    addSocket(Number(user.id), ws);
    if(!wasOnline) broadcastPresence(user.id,true);
    ws.send(JSON.stringify({ type: "connected", onlineUserIds:[...onlineUserIds()] }));

    ws.on("message", async raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "typing" && data.toUserId) {
          const toUserId=Number(data.toUserId);
          if(!await isBlockedBetween(user.id,toUserId)) push(toUserId,{type:"typing",userId:Number(user.id),active:!!data.active});
          return;
        }
        if (data.type === "call-signal" && data.toUserId) {
          const toUserId = Number(data.toUserId);
          const callType = data.callType || "audio";
          if (await isBlockedBetween(user.id, toUserId)) {
            ws.send(JSON.stringify({ type: "call-signal", signalType: "blocked", toUserId }));
            return;
          }
          if (data.signalType === "offer") {
            const callId = String(data.callId || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await query(`INSERT INTO call_sessions(id,caller_id,callee_id,call_type,offer_json,status)
              VALUES($1,$2,$3,$4,$5,'ringing')`, [callId, user.id, toUserId, callType, JSON.stringify(data.signal)]);
            const message = await addCallHistory(user.id, toUserId, callType);
            push(user.id, { type: "call-history", message });
            push(toUserId, { type: "call-history", message });
            notifyCall(toUserId, user.username, callType, callId);
            sendSignal(user.id, { callId, toUserId, signalType: "call-created" });
            if (hasLiveSocket(toUserId)) sendSignal(toUserId, { callId, fromUserId: user.id, fromUsername: user.username, signalType: "offer", signal: data.signal, callType });
            else ws.send(JSON.stringify({ type: "call-signal", signalType: "ringing", toUserId, callId }));
            return;
          }

          if (data.signalType === "ice" && data.callId && data.signal) {
            await query(`INSERT INTO call_ice_candidates(call_id,sender_id,candidate_json) VALUES($1,$2,$3)`, [data.callId, user.id, JSON.stringify(data.signal)]).catch(()=>{});
          }
          if (data.signalType === "answer" && data.callId) await query("UPDATE call_sessions SET status='accepted', answer_json=$2 WHERE id=$1", [data.callId, JSON.stringify(data.signal)]);
          if (data.signalType === "hangup" && data.callId) {
            await query("UPDATE call_sessions SET status='ended' WHERE id=$1", [data.callId]);
            await query("DELETE FROM call_ice_candidates WHERE call_id=$1", [data.callId]).catch(()=>{});
          }

          // ICE can arrive before the other device reconnects. Store it above;
          // do not immediately fail the call just because the phone WebSocket is sleeping.
          if (data.signalType === "ice" && !hasLiveSocket(toUserId)) return;
          if ((data.signalType === "answer" || data.signalType === "hangup") && !hasLiveSocket(toUserId)) {
            ws.send(JSON.stringify({ type: "call-signal", signalType: "unavailable", toUserId }));
            return;
          }
          sendSignal(toUserId, { callId: data.callId, fromUserId: user.id, fromUsername: user.username, signalType: data.signalType, signal: data.signal, callType });
        }
      } catch (e) {
        console.error("WebSocket message error:", e);
      }
    });
    ws.on("close", async () => {
      removeSocket(Number(user.id), ws);
      if(!hasLiveSocket(user.id)) { await query("UPDATE users SET last_seen_at=NOW() WHERE id=$1", [Number(user.id)]).catch(()=>{}); broadcastPresence(user.id,false); }
    });
  } catch {
    ws.close();
  }
});

// Keep WebSocket connections alive on Render and mobile networks.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);
wss.on("close", () => clearInterval(wsHeartbeat));
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

(async () => {
  try {
    await initDb();
    await ensureBotAccount();
    setInterval(botHeartbeat, 120000);
    server.listen(PORT, "0.0.0.0", () => console.log(`БКТ Messenger: http://0.0.0.0:${PORT}`));
  } catch (e) {
    console.error("PostgreSQL initialization failed:", e);
    process.exit(1);
  }
})();

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
process.on("SIGINT", async () => { await pool.end(); process.exit(0); });
