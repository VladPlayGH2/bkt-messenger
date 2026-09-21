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
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", err => console.error("PostgreSQL pool error:", err));

async function query(text, params = []) {
  return pool.query(text, params);
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

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bio TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS deleted_usernames (
      username TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS captcha_challenges (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE
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

  for (const protectedName of ["brozi", "vlad", "vladmobile"]) {
    const account = await one("SELECT id FROM users WHERE LOWER(username)=LOWER($1)", [protectedName]);
    if (account) {
      await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [account.id]);
    }
  }
  await query("ALTER TABLE statuses ADD COLUMN IF NOT EXISTS media_url TEXT NOT NULL DEFAULT ''");
  await query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ");
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT");
  await query("DROP INDEX IF EXISTS idx_users_email_lower");
  await query("ALTER TABLE users DROP COLUMN IF EXISTS email");
  await query("ALTER TABLE phone_verifications DROP COLUMN IF EXISTS email");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL");
  await query("CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, sender_id, read_at, id)");
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
const REWARD_STICKER_IDS = [REWARD_STICKER_ID, REWARD_STICKER_150_ID];

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
    }
  }
}

const app = express();

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

function tokenFor(user) {
  return jwt.sign({ id: Number(user.id), username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}
function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    req.user = jwt.verify(raw, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Требуется авторизация" });
  }
}
function normalizeUsername(v) {
  return String(v ?? "").trim().replace(/^@+/, "").toLowerCase();
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

app.get("/api/rtc-config", auth, (req, res) => {
  // STUN discovers public addresses. A self-hosted coturn TURN server is used
  // when a direct PC↔phone WebRTC path is impossible. TURN credentials are
  // short-lived and are generated server-side from TURN_SECRET.
  const iceServers = [
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478"
    ] }
  ];

  const turnHost = String(process.env.TURN_HOST || "").trim();
  const turnUrls = String(process.env.TURN_URLS || process.env.TURN_URL || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const turnSecret = String(process.env.TURN_SECRET || "");
  if (turnUrls.length && turnSecret && turnHost) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expires}:${String(req.user.id)}`;
    const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  } else if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    // Backwards-compatible static credentials. Prefer TURN_SECRET for production.
    iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({ iceServers });
});

app.post("/api/register/request-code", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const phoneRaw = String(req.body.phone || "").trim();
    const accessCode = String(req.body.accessCode || "");
    let avatar = String(req.body.avatar || "/stickers/1.webp").trim();
    const usernameError = validateUsername(username);
    if (usernameError) return res.status(400).json({ error: usernameError });
    if (!/^\+?[0-9 ()-]{10,20}$/.test(phoneRaw)) return res.status(400).json({ error: "Введите корректный номер телефона" });
    const phone = normalizePhone(phoneRaw);
    if (phone.length < 10 || phone.length > 15) return res.status(400).json({ error: "Введите корректный номер телефона" });
    if (!verifyProtectedCode(username, accessCode)) return res.status(403).json({ error: protectedError(username) });
    if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    if (await one("SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)", [username])) return res.status(409).json({ error: "Такой пользователь уже существует" });
    if (await one("SELECT 1 FROM users WHERE phone=$1", [phone])) return res.status(409).json({ error: "Этот номер уже привязан к аккаунту" });
    if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8])\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
    const verificationToken = crypto.randomBytes(24).toString("hex");
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const passwordHash = await bcrypt.hash(password, 10);
    await query("DELETE FROM phone_verifications WHERE phone=$1 OR expires_at<NOW()", [phone]);
    await query(`INSERT INTO phone_verifications(token,phone,username,password_hash,avatar,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes')`, [verificationToken, phone, username, passwordHash, avatar, codeHash]);
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
    const user = await one("INSERT INTO users(username,password_hash,avatar,phone) VALUES($1,$2,$3,$4) RETURNING id,username,avatar", [pending.username, pending.password_hash, pending.avatar, pending.phone]);
    await query("UPDATE phone_verifications SET used=TRUE WHERE token=$1", [token]);
    if (["brozi", "vlad", "vladmobile"].includes(pending.username.toLowerCase())) await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [user.id]);
    await addUserToCommunityGroup(user.id);
    await ensureRewardWallet(user.id);
    if (pending.username.toLowerCase() === 'brozi') await query("UPDATE reward_wallets SET oranges=1000000, updated_at=NOW() WHERE user_id=$1", [user.id]);
    if (['brozi','vlad'].includes(pending.username.toLowerCase())) { await grantRewardSticker(user.id, REWARD_STICKER_ID, true); await grantRewardSticker(user.id, REWARD_STICKER_150_ID, true); }
    res.json({ token: tokenFor(user), user });
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
    if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8])\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await one("INSERT INTO users(username,password_hash,avatar) VALUES($1,$2,$3) RETURNING id,username,avatar", [username, passwordHash, avatar]);
    if (["brozi", "vlad", "vladmobile"].includes(username.toLowerCase())) await query("INSERT INTO verified_users(user_id, verified_by) VALUES($1, NULL) ON CONFLICT(user_id) DO NOTHING", [user.id]);
    await addUserToCommunityGroup(user.id);
    await ensureRewardWallet(user.id);
    if (username.toLowerCase() === 'brozi') await query("UPDATE reward_wallets SET oranges=1000000, updated_at=NOW() WHERE user_id=$1", [user.id]);
    if (['brozi','vlad'].includes(username.toLowerCase())) { await grantRewardSticker(user.id, REWARD_STICKER_ID, true); await grantRewardSticker(user.id, REWARD_STICKER_150_ID, true); }
    res.json({ token: tokenFor(user), user });
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
      row = await one("SELECT * FROM users WHERE phone=$1 LIMIT 1", [phone]);
    } else {
      row = await one("SELECT * FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", [normalizedUsername]);
    }
    if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: "Неверный логин/номер телефона или пароль" });
    const user = { id: row.id, username: row.username };
    res.json({ token: tokenFor(user), user });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Ошибка входа. Попробуйте ещё раз." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
  res.json({ ...user, verified: await isVerified(user.id) });
});

app.get("/api/profile", auth, async (req, res) => {
  const meUser = await currentUser(req);
  if (!meUser) return res.status(401).json({ error: "Аккаунт не найден в базе данных. Выйдите и войдите снова." });
  const user = await one("SELECT id,username,COALESCE(bio,'') AS bio,COALESCE(avatar,'') AS avatar FROM users WHERE id=$1", [meUser.id]);
  if (!user) return res.status(404).json({ error: "Профиль не найден" });
  res.json(user);
});

app.patch("/api/profile", auth, async (req, res) => {
  const meUser = await currentUser(req);
  if (!meUser) return res.status(401).json({ error: "Аккаунт не найден в базе данных. Выйдите и войдите снова." });
  const username = String(req.body?.username ?? "").trim().replace(/^@+/, "");
  const accessCode = String(req.body?.accessCode ?? "");
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (protectedAccount(username) && !verifyProtectedCode(username, accessCode)) return res.status(403).json({ error: protectedError(username) });
  const bio = String(req.body?.bio ?? "").trim().slice(0, 160);
  let avatar = String(req.body?.avatar ?? "").trim();
  if (!/^\/stickers\/(?:[1-9]|1[0-9]|2[0-8])\.webp$/.test(avatar)) avatar = "/stickers/1.webp";
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
  const userId = Number(req.params.id);
  const user = await one("SELECT id,username,COALESCE(bio,'') AS bio,COALESCE(avatar,'') AS avatar FROM users WHERE id=$1", [userId]);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });
  const gifts = await many(`SELECT sticker_id,added_at FROM profile_gifts WHERE user_id=$1 ORDER BY added_at DESC`, [userId]);
  res.json({ ...user, verified: await isVerified(userId), gifts: gifts.map(g=>({stickerId:Number(g.sticker_id),src:`/stickers/${Number(g.sticker_id)}.webp`,addedAt:g.added_at})) });
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

app.delete("/api/admin/users/:id", auth, async (req, res) => {
  try {
    const actor = await currentUser(req);
    if (!actor || !canManageAccounts(actor.username)) return res.status(403).json({ error: "Удалять аккаунты могут только Brozi и Vlad" });
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "Некорректный ID пользователя" });
    if (userId === Number(actor.id)) return res.status(400).json({ error: "Нельзя удалить собственный аккаунт через это действие" });
    const target = await one("SELECT id, username FROM users WHERE id=$1", [userId]);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });
    if (canManageAccounts(target.username)) return res.status(403).json({ error: "Аккаунты Brozi и Vlad защищены от удаления" });
    const deleted = await one(`
      WITH removed AS (
        DELETE FROM users WHERE id=$1 RETURNING username
      )
      INSERT INTO deleted_usernames(username)
      SELECT username FROM removed
      ON CONFLICT (username) DO NOTHING
      RETURNING username`, [userId]);
    if (!deleted) return res.status(404).json({ error: "Пользователь уже удалён" });
    push(userId, { type: "account-deleted", permanent: true });
    const socketsForUser = sockets.get(userId);
    if (socketsForUser) { for (const ws of [...socketsForUser]) { try { ws.close(4001, "Account permanently deleted"); } catch (_) {} } sockets.delete(userId); }
    res.json({ ok: true, permanentlyDeleted: true, username: deleted.username });
  } catch (e) { console.error(e); res.status(500).json({ error: "Не удалось удалить аккаунт" }); }
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
    await query("DELETE FROM statuses WHERE user_id=$1 OR expires_at <= NOW()", [user.id]);
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
  const rows = await many(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,u.username sender_name
    FROM messages m JOIN users u ON u.id=m.sender_id
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

app.get("/api/rewards", auth, async (req, res) => {
  const oranges = await grantRewardsForBalance(req.user.id, false);
  const rows = await many("SELECT sticker_id FROM user_stickers WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const gifts = await many("SELECT sticker_id FROM profile_gifts WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const owned = new Set(rows.map(r=>Number(r.sticker_id)));
  const profileGift = new Set(gifts.map(r=>Number(r.sticker_id)));
  res.json({
    oranges,
    rewards: [
      {stickerId:REWARD_STICKER_ID, stickerSrc:REWARD_STICKER_SRC, unlockAt:50, owned:owned.has(REWARD_STICKER_ID), profileGift:profileGift.has(REWARD_STICKER_ID)},
      {stickerId:REWARD_STICKER_150_ID, stickerSrc:REWARD_STICKER_150_SRC, unlockAt:150, owned:owned.has(REWARD_STICKER_150_ID), profileGift:profileGift.has(REWARD_STICKER_150_ID)}
    ]
  });
});

app.post("/api/captcha/challenge", auth, async (req, res) => {
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
  const wallet = await one(`INSERT INTO reward_wallets(user_id,oranges) VALUES($1,5) ON CONFLICT(user_id) DO UPDATE SET oranges=reward_wallets.oranges+5,updated_at=NOW() RETURNING oranges`, [req.user.id]);
  const oranges = Number(wallet.oranges);
  await grantRewardsForBalance(req.user.id, false);
  const rows = await many("SELECT sticker_id FROM user_stickers WHERE user_id=$1 AND sticker_id = ANY($2::int[])", [req.user.id, REWARD_STICKER_IDS]);
  const owned = new Set(rows.map(r=>Number(r.sticker_id)));
  res.json({
    ok:true,
    oranges,
    rewards:[
      {stickerId:REWARD_STICKER_ID, stickerSrc:REWARD_STICKER_SRC, unlockAt:50, owned:owned.has(REWARD_STICKER_ID)},
      {stickerId:REWARD_STICKER_150_ID, stickerSrc:REWARD_STICKER_150_SRC, unlockAt:150, owned:owned.has(REWARD_STICKER_150_ID)}
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

app.post("/api/stickers/:id/send", auth, async (req, res) => {
  const stickerId = Number(req.params.id);
  const receiver = Number(req.body?.receiverId);
  if (!REWARD_STICKER_IDS.includes(stickerId) || !receiver || receiver === Number(req.user.id)) return res.status(400).json({ error: "Некорректный подарок" });
  const owned = await one("SELECT 1 FROM user_stickers WHERE user_id=$1 AND sticker_id=$2", [req.user.id, stickerId]);
  if (!owned) return res.status(403).json({ error: "Сначала получите этот стикер" });
  if (await isBlockedBetween(req.user.id, receiver)) return res.status(403).json({ error: "Пользователь заблокирован" });
  const target = await one("SELECT id,username FROM users WHERE id=$1", [receiver]);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });
  await query("INSERT INTO user_stickers(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [receiver, stickerId]);
  await query("INSERT INTO profile_gifts(user_id,sticker_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [receiver, stickerId]);
  const inserted = await one("INSERT INTO messages(sender_id,receiver_id,text) VALUES($1,$2,$3) RETURNING id", [req.user.id, receiver, `[STICKER]${REWARD_STICKER_SRC}`]);
  const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,u.username sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [inserted.id]);
  push(receiver, {type:"message",message});
  push(req.user.id, {type:"message",message});
  res.json(message);
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
    if (await isBlockedBetween(req.user.id, receiver)) return res.status(403).json({ error: "Нельзя отправить сообщение: пользователь заблокирован" });
    const inserted = await one("INSERT INTO messages(sender_id,receiver_id,text) VALUES($1,$2,$3) RETURNING id", [req.user.id, receiver, text]);
    const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,u.username sender_name
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [inserted.id]);
    const delivered = push(receiver, { type: "message", message });
    if (!delivered) pushNotification(receiver, { type: "message", title: message.sender_name || "Новое сообщение", body: message.text || "Новое сообщение", senderId: message.sender_id, message }).catch(() => {});
    push(req.user.id, { type: "message", message });
    res.json(message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось сохранить сообщение" });
  }
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
    const message = await one(`SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,m.read_at,u.username sender_name
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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const user = jwt.verify(url.searchParams.get("token") || "", JWT_SECRET);
    const wasOnline=hasLiveSocket(user.id);
    addSocket(Number(user.id), ws);
    if(!wasOnline) broadcastPresence(user.id,true);
    ws.send(JSON.stringify({ type: "connected", onlineUserIds:[...onlineUserIds()] }));

    ws.on("message", async raw => {
      try {
        const data = JSON.parse(raw.toString());
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
          if (data.signalType === "answer" && data.callId) await query("UPDATE call_sessions SET status='accepted' WHERE id=$1", [data.callId]);
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
    ws.on("close", () => {
      removeSocket(Number(user.id), ws);
      if(!hasLiveSocket(user.id)) broadcastPresence(user.id,false);
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

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

(async () => {
  try {
    await initDb();
    server.listen(PORT, "0.0.0.0", () => console.log(`БКТ Messenger: http://0.0.0.0:${PORT}`));
  } catch (e) {
    console.error("PostgreSQL initialization failed:", e);
    process.exit(1);
  }
})();

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
process.on("SIGINT", async () => { await pool.end(); process.exit(0); });
