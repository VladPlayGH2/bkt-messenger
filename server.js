const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

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
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const sockets = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/me", auth, (req, res) => res.json(req.user));

app.get("/api/users", auth, (req, res) => {
  const q = `%${String(req.query.q || "").trim()}%`;
  const users = db.prepare("SELECT id,username FROM users WHERE id<>? AND username LIKE ? ORDER BY username LIMIT 50")
    .all(req.user.id, q);
  res.json(users);
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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const user = jwt.verify(url.searchParams.get("token") || "", JWT_SECRET);
    sockets.set(user.id, ws);
    ws.send(JSON.stringify({ type: "connected" }));
    ws.on("close", () => { if (sockets.get(user.id) === ws) sockets.delete(user.id); });
  } catch {
    ws.close();
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`БКТ Messenger: http://0.0.0.0:${PORT}`));
