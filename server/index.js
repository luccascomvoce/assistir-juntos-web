const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["polling", "websocket"],
  pingInterval: 10000,
  pingTimeout: 30000,
  connectTimeout: 30000,
  allowEIO3: true,
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

server.timeout = 600000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// ── Tokens ──
const TOKENS_PATH = process.env.TOKENS_PATH || path.join(__dirname, "..", "data", "tokens.json");
let validTokens = {};

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      validTokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
      console.log("[AUTH] Loaded " + Object.keys(validTokens).length + " tokens");
    } else {
      const defaultTokens = {
        [crypto.randomUUID().slice(0, 8)]: "Admin",
        [crypto.randomUUID().slice(0, 8)]: "Amigo1",
        [crypto.randomUUID().slice(0, 8)]: "Amigo2",
      };
      const envTokens = process.env.TOKENS;
      if (envTokens) {
        try { Object.assign(defaultTokens, JSON.parse(envTokens)); } catch (e) {}
      }
      validTokens = defaultTokens;
      const dir = path.dirname(TOKENS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(validTokens, null, 2));
      console.log("[AUTH] Generated " + Object.keys(validTokens).length + " tokens:");
      for (const [t, n] of Object.entries(validTokens)) console.log("  " + n + " → token: " + t);
    }
  } catch (e) { console.error("[AUTH] Error:", e.message); validTokens = {}; }
}
loadTokens();

// ── Uploads ──
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, "..", "videos");
// Also serve media from the root-level uploads folder (legacy support)
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
[VIDEOS_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const storage = multer.diskStorage({
  destination: VIDEOS_DIR,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ── Middleware ──
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-auth-token",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Auth endpoints ──
app.get("/api/tokens", (req, res) => {
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return res.json(validTokens);
  res.status(403).json({ error: "Apenas acesso local" });
});
app.post("/api/tokens", express.json(), (req, res) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) return res.status(403).json({ error: "Apenas acesso local" });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Nome obrigatório" });
  const token = crypto.randomUUID().slice(0, 8);
  validTokens[token] = name;
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(validTokens, null, 2));
  res.json({ token, name });
});

// ── Socket.io Auth ──
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Token de acesso não fornecido."));
  if (!validTokens[token]) return next(new Error("Token inválido ou expirado."));
  socket.nickname = validTokens[token];
  socket.authToken = token;
  next();
});

// ── Serve videos with range support ──
function serveFileWithRange(filePath, contentType, req, res) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.writeHead(206, {
        "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Cache-Control": "no-cache" });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) { res.status(404).send("File not found"); }
}

function getContentType(fn) {
  const m = { ".mp4":"video/mp4", ".webm":"video/webm", ".ogg":"video/ogg", ".mkv":"video/x-matroska",
    ".avi":"video/x-msvideo", ".mov":"video/quicktime", ".m4v":"video/mp4", ".m4a":"audio/mp4",
    ".mp3":"audio/mpeg", ".aac":"audio/aac" };
  return m[path.extname(fn).toLowerCase()] || "application/octet-stream";
}

// Serve any video from videos/ or uploads/
function findVideoFile(filename) {
  for (const dir of [VIDEOS_DIR, UPLOADS_DIR]) {
    const p = path.join(dir, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get("/media/:filename", (req, res) => {
  const fp = findVideoFile(req.params.filename);
  if (!fp) return res.status(404).send("Not found");
  serveFileWithRange(fp, getContentType(fp), req, res);
});

// Upload
app.post("/upload", (req, res) => {
  const token = req.query.token || req.headers["x-auth-token"];
  if (!token || !validTokens[token]) return res.status(401).json({ error: "Não autorizado." });
  upload.single("video")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Arquivo muito grande. Limite: 2GB." });
        return res.status(400).json({ error: "Erro: " + err.message });
      }
      return res.status(500).json({ error: "Erro interno." });
    }
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo." });
    res.json({ ok: true, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
  });
});

// List videos (agnostic — all videos from both dirs)
app.delete("/api/videos/:filename", (req, res) => {
  const token = req.query.token || req.headers["x-auth-token"];
  if (!token || !validTokens[token] || validTokens[token] !== "Admin") {
    return res.status(403).json({ error: "Apenas Admin pode deletar." });
  }
  const fp = findVideoFile(req.params.filename);
  if (!fp) return res.status(404).json({ error: "Arquivo não encontrado." });
  try {
    fs.unlinkSync(fp);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao deletar." });
  }
});

app.get("/api/videos", (req, res) => {
  try {
    const files = [];
    for (const dir of [VIDEOS_DIR, UPLOADS_DIR]) {
      if (!fs.existsSync(dir)) continue;
      fs.readdirSync(dir)
        .filter(f => /\.(mp4|webm|ogg|mkv|avi|mov|m4v)$/i.test(f))
        .forEach(f => {
          const s = fs.statSync(path.join(dir, f));
          files.push({ filename: f, size: s.size, uploadedAt: s.mtime });
        });
    }
    files.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(files);
  } catch (e) { res.json([]); }
});

// ── Room state ──
const rooms = {};
const DC_TIMEOUT = 15000;

function bcastUserList(room) {
  if (!rooms[room]) return;
  io.to(room).emit("userList", Object.entries(rooms[room].users).map(([sid, u]) => ({
    nickname: u.nickname, id: sid, status: u.status || "online"
  })));
}

function getRoomState(room) {
  if (!rooms[room]) return null;
  const r = rooms[room];
  return {
    paused: r.paused,
    currentTime: r.currentTime,
    currentVideo: r.currentVideo,
    currentVideoName: r.currentVideoName,
    mediaType: r.mediaType || "file",
    screenSharer: r.screenSharer || null,
    screenSharerName: r.screenSharerName || null,
  };
}

io.on("connection", (socket) => {
  console.log("connect: " + socket.id + " (" + socket.nickname + ")");

  socket.on("join", (room) => {
    socket.join(room);
    socket.currentRoom = room;
    if (!rooms[room]) {
      rooms[room] = { users: {}, paused: true, currentTime: 0, lastSyncTime: Date.now(), currentVideo: null, currentVideoName: "Nenhum vídeo selecionado" };
    }
    if (rooms[room].users[socket.id] && rooms[room].users[socket.id]._dcTimer) {
      clearTimeout(rooms[room].users[socket.id]._dcTimer);
    }
    rooms[room].users[socket.id] = { nickname: socket.nickname, status: "online" };
    socket.emit("roomState", {
      paused: rooms[room].paused,
      currentTime: rooms[room].currentTime,
      currentVideo: rooms[room].currentVideo,
      currentVideoName: rooms[room].currentVideoName,
      mediaType: rooms[room].mediaType || "file",
      screenSharer: rooms[room].screenSharer || null,
      screenSharerName: rooms[room].screenSharerName || null,
      myId: socket.id,
    });
    bcastUserList(room);
    socket.to(room).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " entrou.", system: true });
  });

  socket.on("setNickname", (nickname) => {
    socket.nickname = nickname;
    const r = socket.currentRoom;
    if (r && rooms[r] && rooms[r].users[socket.id]) { rooms[r].users[socket.id].nickname = nickname; bcastUserList(r); }
  });

  socket.on("chatMessage", (msg) => {
    const r = socket.currentRoom;
    if (!r) return;
    io.to(r).emit("chatMessage", { id: socket.id, from: socket.nickname || "User", text: msg, system: false, time: Date.now() });
  });

  socket.on("switchVideo", (data) => {
    const r = socket.currentRoom;
    if (!r || !rooms[r]) return;
    rooms[r].currentVideo = data.src;
    rooms[r].currentVideoName = data.name;
    rooms[r].currentTime = 0;
    rooms[r].paused = true;
    rooms[r].lastSyncTime = Date.now();
    io.to(r).emit("videoSwitch", data);
    io.to(r).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " selecionou: " + data.name, system: true });
  });

  socket.on("play", (t) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].paused = false; rooms[r].currentTime = t; rooms[r].lastSyncTime = Date.now(); socket.to(r).emit("remotePlay", t); } });
  socket.on("pause", (t) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].paused = true; rooms[r].currentTime = t; socket.to(r).emit("remotePause", t); } });
  socket.on("seek", (t) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].currentTime = t; rooms[r].lastSyncTime = Date.now(); socket.to(r).emit("remoteSeek", t); } });

  socket.on("requestSync", () => {
    const r = socket.currentRoom;
    if (!r || !rooms[r]) return;
    const state = getRoomState(r);
    let t = state.currentTime;
    if (!state.paused && state.mediaType !== "screen") t += (Date.now() - rooms[r].lastSyncTime) / 1000;
    socket.emit("sync", {
      ...state,
      currentTime: t,
      myId: socket.id,
    });
  });

  // ── Screen Share ──
  socket.on("startScreenShare", () => {
    const r = socket.currentRoom;
    if (!r || !rooms[r]) return;
    // Only one screen share at a time
    if (rooms[r].mediaType === "screen") {
      socket.emit("screenShareError", { message: "Já existe um compartilhamento de tela ativo na sala." });
      return;
    }
    rooms[r].mediaType = "screen";
    rooms[r].screenSharer = socket.id;
    rooms[r].screenSharerName = socket.nickname;
    rooms[r].paused = false;
    rooms[r].currentVideo = null;
    rooms[r].currentVideoName = "Tela de " + socket.nickname;
    // Exclude sender: they already handle their own screen share locally
    socket.to(r).emit("screenShareStarted", {
      screenSharer: socket.id,
      screenSharerName: socket.nickname,
    });
    io.to(r).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " começou a compartilhar a tela.", system: true });
  });

  socket.on("stopScreenShare", () => {
    const r = socket.currentRoom;
    if (!r || !rooms[r]) return;
    if (rooms[r].screenSharer !== socket.id) {
      socket.emit("screenShareError", { message: "Apenas quem iniciou o compartilhamento pode encerrá-lo." });
      return;
    }
    rooms[r].mediaType = "file";
    rooms[r].screenSharer = null;
    rooms[r].screenSharerName = null;
    rooms[r].currentVideoName = "Nenhum vídeo selecionado";
    rooms[r].paused = true;
    rooms[r].currentTime = 0;
    // Exclude sender: sender already cleaned up locally
    socket.to(r).emit("screenShareStopped", { screenSharer: socket.id });
    io.to(r).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " encerrou o compartilhamento de tela.", system: true });
  });

  // ── WebRTC Signaling ──
  socket.on("webrtc-offer", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    // Forward offer to a specific peer using io.to(socketId) for direct delivery
    if (data.target) {
      io.to(data.target).emit("webrtc-offer", { from: socket.id, sdp: data.sdp });
    } else {
      socket.to(r).emit("webrtc-offer", { from: socket.id, sdp: data.sdp });
    }
  });

  socket.on("webrtc-answer", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    if (data.target) {
      io.to(data.target).emit("webrtc-answer", { from: socket.id, sdp: data.sdp });
    } else {
      socket.to(r).emit("webrtc-answer", { from: socket.id, sdp: data.sdp });
    }
  });

  socket.on("webrtc-ice-candidate", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    if (data.target) {
      io.to(data.target).emit("webrtc-ice-candidate", { from: socket.id, candidate: data.candidate });
    } else {
      socket.to(r).emit("webrtc-ice-candidate", { from: socket.id, candidate: data.candidate });
    }
  });

  // ── Camera WebRTC Signaling ──
  socket.on("camera-webrtc-offer", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    if (data.target) {
      io.to(data.target).emit("camera-webrtc-offer", { from: socket.id, nickname: socket.nickname, sdp: data.sdp });
    }
  });

  socket.on("camera-webrtc-answer", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    if (data.target) {
      io.to(data.target).emit("camera-webrtc-answer", { from: socket.id, sdp: data.sdp });
    }
  });

  // ── Mic & Camera State ──
  socket.on("micStateChanged", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    socket.to(r).emit("micStateChanged", { id: socket.id, nickname: socket.nickname, muted: data.muted });
  });

  socket.on("cameraStateChanged", (data) => {
    const r = socket.currentRoom;
    if (!r) return;
    socket.to(r).emit("cameraStateChanged", { id: socket.id, nickname: socket.nickname, active: data.active });
  });

  socket.on("disconnect", () => {
    const r = socket.currentRoom;
    if (r && rooms[r]) {
      // Notify others that this user's camera stopped
      socket.to(r).emit("cameraStateChanged", { id: socket.id, nickname: socket.nickname, active: false });
      // If screen sharer disconnects, clean up screen share state
      if (rooms[r].screenSharer === socket.id) {
        rooms[r].mediaType = "file";
        rooms[r].screenSharer = null;
        rooms[r].screenSharerName = null;
        rooms[r].currentVideoName = "Nenhum vídeo selecionado";
        rooms[r].paused = true;
        rooms[r].currentTime = 0;
        io.to(r).emit("screenShareStopped", { screenSharer: socket.id });
        io.to(r).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " saiu e seu compartilhamento de tela foi encerrado.", system: true });
      }
    }
    if (r && rooms[r] && rooms[r].users[socket.id]) {
      rooms[r].users[socket.id].status = "reconnecting";
      bcastUserList(r);
      rooms[r].users[socket.id]._dcTimer = setTimeout(() => {
        if (rooms[r] && rooms[r].users[socket.id] && rooms[r].users[socket.id].status === "reconnecting") {
          rooms[r].users[socket.id].status = "disconnected";
          bcastUserList(r);
          socket.to(r).emit("chatMessage", { id: null, from: "Sistema", text: socket.nickname + " saiu.", system: true });
          setTimeout(() => {
            if (rooms[r] && rooms[r].users[socket.id] && rooms[r].users[socket.id].status === "disconnected") {
              delete rooms[r].users[socket.id];
              bcastUserList(r);
              if (Object.keys(rooms[r].users).length === 0) delete rooms[r];
            }
          }, 60000);
        }
      }, DC_TIMEOUT);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server: http://localhost:" + PORT));