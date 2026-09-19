const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");
const multer = require("multer");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";

const db = new Database(path.join(__dirname, "bkt.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(sender_id) REFERENCES users(id),
  FOREIGN KEY(receiver_id) REFERENCES users(id)
);
`);

const app = express();
const mediaDir = path.join(__dirname, "uploads", "media");
fs.mkdirSync(mediaDir, { recursive: true });

const mediaStorage = multer.diskStorage({
  destination: mediaDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const sockets = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(mediaDir));

function tokenFor(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
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

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]{3,24}$/.test(username))
    return res.status(400).json({ error: "Логин: 3–24 символа, буквы, цифры или _" });
  if (password.length < 6)
    return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run(username, hash);
    const user = { id: result.lastInsertRowid, username };
    res.json({ token: tokenFor(user), user });
  } catch {
    res.status(409).json({ error: "Такой пользователь уже существует" });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const row = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!row || !(await bcrypt.compare(password, row.password_hash)))
    return res.status(401).json({ error: "Неверный логин или пароль" });
  const user = { id: row.id, username: row.username };
  res.json({ token: tokenFor(user), user });
});


// --- BKT groups & verified developer features ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS verified_users (
      user_id INTEGER PRIMARY KEY,
      verified_by INTEGER,
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.error("Feature migration error:", e);
}

function isVerified(userId) {
  return !!db.prepare("SELECT 1 FROM verified_users WHERE user_id=?").get(Number(userId));
}

function isGroupMember(groupId, userId) {
  return !!db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(Number(groupId), Number(userId));
}


try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"); } catch {}

app.get("/api/me", auth, (req, res) => res.json(req.user));



app.get("/api/profile", auth, (req,res) => {
  const user = db.prepare("SELECT id,username,bio,avatar FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({error:"Пользователь не найден"});
  res.json(user);
});

app.patch("/api/profile", auth, (req,res) => {
  const username = String(req.body.username ?? "").trim();
  const bio = String(req.body.bio ?? "").trim().slice(0,160);
  const avatar = String(req.body.avatar ?? "").trim().slice(0,500);
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]{3,24}$/.test(username))
    return res.status(400).json({error:"Логин: 3–32 символа, буквы, цифры, _, ., -"});
  const exists = db.prepare("SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?").get(username, req.user.id);
  if (exists) return res.status(409).json({error:"Этот логин уже занят"});
  db.prepare("UPDATE users SET username=?,bio=?,avatar=? WHERE id=?").run(username,bio,avatar,req.user.id);
  const updated = db.prepare("SELECT id,username,bio,avatar FROM users WHERE id=?").get(req.user.id);
  res.json({ ...updated, token: tokenFor({id:updated.id, username:updated.username}) });
});

app.get("/api/users/:id/profile", auth, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare("SELECT id, username FROM users WHERE id=?").get(userId);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });
  res.json({ ...user, verified: isVerified(userId) });
});

// Admin-side helper. Set ADMIN_USER_ID in Render Environment Variables.
app.post("/api/admin/verify/:id", auth, (req, res) => {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  if (!adminId || Number(req.user.id) !== adminId)
    return res.status(403).json({ error: "Нет доступа" });

  const userId = Number(req.params.id);
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(userId);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  db.prepare("INSERT OR REPLACE INTO verified_users(user_id, verified_by) VALUES(?,?)")
    .run(userId, req.user.id);

  res.json({ ok: true, verified: true });
});

app.delete("/api/admin/verify/:id", auth, (req, res) => {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  if (!adminId || Number(req.user.id) !== adminId)
    return res.status(403).json({ error: "Нет доступа" });

  db.prepare("DELETE FROM verified_users WHERE user_id=?").run(Number(req.params.id));
  res.json({ ok: true, verified: false });
});

app.get("/api/users", auth, (req, res) => {
  const raw = String(req.query.q || "").trim().replace(/^@+/, "");

  // Без поискового запроса показываем только людей, с которыми уже есть переписка.
  if (!raw) {
    const chats = db.prepare(`
      SELECT u.id, u.username, EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified, MAX(m.id) AS last_message_id
      FROM users u
      JOIN messages m ON (m.sender_id=u.id AND m.receiver_id=?)
                     OR (m.receiver_id=u.id AND m.sender_id=?)
      WHERE u.id<>?
      GROUP BY u.id, u.username
      ORDER BY last_message_id DESC
      LIMIT 50
    `).all(req.user.id, req.user.id, req.user.id);
    res.set("Cache-Control", "no-store");
    return res.json(chats.map(({id, username, verified}) => ({id, username, verified: !!verified})));
  }

  // При поиске показываем только найденных пользователей.
  const users = db.prepare(`
    SELECT u.id, u.username, EXISTS(SELECT 1 FROM verified_users v WHERE v.user_id=u.id) AS verified
    FROM users u
    WHERE u.id<>? AND LOWER(u.username) LIKE LOWER(?)
    ORDER BY username COLLATE NOCASE
    LIMIT 50
  `).all(req.user.id, `%${raw}%`);
  res.set("Cache-Control", "no-store");
  res.json(users.map(u => ({...u, verified: !!u.verified})));
});

app.get("/api/messages/:userId", auth, (req, res) => {
  const other = Number(req.params.userId);
  const rows = db.prepare(`
    SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,u.username sender_name
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)
    ORDER BY m.id ASC LIMIT 500
  `).all(req.user.id, other, other, req.user.id);
  res.json(rows);
});

function push(userId, payload) {
  const ws = sockets.get(Number(userId));
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

app.post("/api/messages", auth, (req, res) => {
  const receiver = Number(req.body.receiverId);
  const text = String(req.body.text || "").trim();
  if (!receiver || !text || text.length > 4000) return res.status(400).json({ error: "Некорректное сообщение" });
  const target = db.prepare("SELECT id,username FROM users WHERE id=?").get(receiver);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });

  const result = db.prepare("INSERT INTO messages(sender_id,receiver_id,text) VALUES(?,?,?)")
    .run(req.user.id, receiver, text);
  const message = db.prepare(`
    SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,u.username sender_name
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
  `).get(result.lastInsertRowid);

  push(receiver, { type: "message", message });
  push(req.user.id, { type: "message", message });
  res.json(message);
});

function sendSignal(toUserId, payload) {
  push(Number(toUserId), { type: "call-signal", ...payload });
}


app.post("/api/media", auth, uploadMedia.single("media"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Файл не получен" });

    const receiverId = Number(req.body.receiverId);
    const kind = String(req.body.kind || "");
    if (!receiverId || !["audio", "video"].includes(kind)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Некорректные параметры" });
    }

    const receiver = db.prepare("SELECT id,username FROM users WHERE id=?").get(receiverId);
    if (!receiver) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const url = `/media/${req.file.filename}`;
    const text = kind === "audio" ? `[VOICE]${url}` : `[VIDEO_NOTE]${url}`;

    const result = db.prepare(
      "INSERT INTO messages(sender_id,receiver_id,text) VALUES(?,?,?)"
    ).run(req.user.id, receiverId, text);

    const message = db.prepare(`
      SELECT m.id,m.sender_id,m.receiver_id,m.text,m.created_at,u.username sender_name
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
    `).get(result.lastInsertRowid);

    push(receiverId, { type: "message", message });
    push(req.user.id, { type: "message", message });
    res.json(message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось сохранить медиа" });
  }
});


app.post("/api/groups", auth, (req, res) => {
  const name = String(req.body.name || "").trim();
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(Number).filter(Boolean) : [];
  if (!name || name.length > 80) return res.status(400).json({ error: "Некорректное название группы" });

  const uniqueMembers = [...new Set([Number(req.user.id), ...memberIds])];
  if (uniqueMembers.length > 100) return res.status(400).json({ error: "Максимум 100 участников" });

  const tx = db.transaction(() => {
    const group = db.prepare("INSERT INTO groups(name, owner_id) VALUES(?,?)").run(name, req.user.id);
    const add = db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?,?)");
    add.run(group.lastInsertRowid, req.user.id, "owner");
    for (const uid of uniqueMembers) {
      if (uid === Number(req.user.id)) continue;
      if (db.prepare("SELECT id FROM users WHERE id=?").get(uid)) add.run(group.lastInsertRowid, uid, "member");
    }
    return Number(group.lastInsertRowid);
  });

  const groupId = tx();
  const group = db.prepare("SELECT id,name,owner_id,created_at FROM groups WHERE id=?").get(groupId);
  const members = db.prepare(`
    SELECT u.id,u.username,gm.role
    FROM group_members gm JOIN users u ON u.id=gm.user_id
    WHERE gm.group_id=? ORDER BY CASE gm.role WHEN 'owner' THEN 0 ELSE 1 END,u.username COLLATE NOCASE
  `).all(groupId);

  for (const m of members) push(m.id, { type:"group-created", group, members });
  res.json({ ...group, members });
});

app.get("/api/groups", auth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id,g.name,g.owner_id,g.created_at
    FROM groups g JOIN group_members gm ON gm.group_id=g.id
    WHERE gm.user_id=? ORDER BY g.created_at DESC
  `).all(req.user.id);

  const result = groups.map(g => ({
    ...g,
    members: db.prepare(`
      SELECT u.id,u.username,gm.role
      FROM group_members gm JOIN users u ON u.id=gm.user_id
      WHERE gm.group_id=? ORDER BY u.username COLLATE NOCASE
    `).all(g.id)
  }));
  res.set("Cache-Control","no-store");
  res.json(result);
});

app.post("/api/groups/:id/members", auth, (req, res) => {
  const groupId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const group = db.prepare("SELECT id,owner_id FROM groups WHERE id=?").get(groupId);
  if (!group || Number(group.owner_id) !== Number(req.user.id))
    return res.status(403).json({ error:"Только создатель группы может добавлять участников" });

  if (!db.prepare("SELECT id FROM users WHERE id=?").get(userId))
    return res.status(404).json({ error:"Пользователь не найден" });

  db.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,role) VALUES(?,?,?)")
    .run(groupId,userId,"member");
  res.json({ ok:true });
});

app.delete("/api/groups/:id/members/:userId", auth, (req, res) => {
  const groupId=Number(req.params.id), userId=Number(req.params.userId);
  const group=db.prepare("SELECT id,owner_id FROM groups WHERE id=?").get(groupId);
  if (!group || Number(group.owner_id)!==Number(req.user.id))
    return res.status(403).json({error:"Нет доступа"});
  if (userId===Number(group.owner_id))
    return res.status(400).json({error:"Нельзя удалить создателя"});
  db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(groupId,userId);
  res.json({ok:true});
});

app.get("/api/groups/:id/messages", auth, (req,res) => {
  const groupId=Number(req.params.id);
  if (!isGroupMember(groupId,req.user.id)) return res.status(403).json({error:"Нет доступа"});
  const messages=db.prepare(`
    SELECT gm.id,gm.group_id,gm.sender_id,gm.text,gm.created_at,u.username sender_name
    FROM group_messages gm JOIN users u ON u.id=gm.sender_id
    WHERE gm.group_id=? ORDER BY gm.id ASC LIMIT 500
  `).all(groupId);
  res.json(messages);
});

app.post("/api/groups/:id/messages", auth, (req,res) => {
  const groupId=Number(req.params.id);
  const text=String(req.body.text||"").trim();
  if(!isGroupMember(groupId,req.user.id)) return res.status(403).json({error:"Нет доступа"});
  if(!text || text.length>5000) return res.status(400).json({error:"Некорректное сообщение"});
  const result=db.prepare("INSERT INTO group_messages(group_id,sender_id,text) VALUES(?,?,?)").run(groupId,req.user.id,text);
  const msg=db.prepare(`
    SELECT gm.id,gm.group_id,gm.sender_id,gm.text,gm.created_at,u.username sender_name
    FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.id=?
  `).get(result.lastInsertRowid);
  const members=db.prepare("SELECT user_id FROM group_members WHERE group_id=?").all(groupId);
  for(const m of members) push(m.user_id,{type:"group-message",message:msg});
  res.json(msg);
});


wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const user = jwt.verify(url.searchParams.get("token") || "", JWT_SECRET);
    sockets.set(user.id, ws);
    ws.send(JSON.stringify({ type: "connected" }));

    ws.on("message", raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "call-signal" && data.toUserId) {
          sendSignal(data.toUserId, {
            fromUserId: user.id,
            fromUsername: user.username,
            signalType: data.signalType,
            signal: data.signal
          });
        }
      } catch (e) {
        console.error("WebSocket message error:", e);
      }
    });

    ws.on("close", () => { if (sockets.get(user.id) === ws) sockets.delete(user.id); });
  } catch {
    ws.close();
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`БКТ Messenger: http://0.0.0.0:${PORT}`));
