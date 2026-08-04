const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["polling", "websocket"],
  pingInterval: 10000,
  pingTimeout: 30000,
  connectTimeout: 30000,
  allowEIO3: true,
});

server.timeout = 600000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Upload logging
const LOG_FILE = path.join(__dirname, "upload.log");
function logUpload(msg) {
  const ts = new Date().toISOString();
  const line = "[" + ts + "] " + msg + "\n";
  fs.appendFileSync(LOG_FILE, line);
  console.log("[UPLOAD] " + msg);
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// Anti-cache
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Helper: serve file with range request support
function serveFileWithRange(filePath, contentType, req, res) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Cache-Control": "no-cache" });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(404).send("File not found");
  }
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
    ".m4v": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".aac": "audio/aac",
  };
  return mimeMap[ext] || "application/octet-stream";
}

app.get("/video", (req, res) => {
  serveFileWithRange(path.join(__dirname, "Backrooms (2026) Dual 1080p.mp4"), "video/mp4", req, res);
});
app.get("/media/:filename", (req, res) => {
  serveFileWithRange(path.join(uploadsDir, req.params.filename), getContentType(req.params.filename), req, res);
});
app.post("/upload", (req, res) => {
  const startTime = Date.now();
  upload.single("video")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        logUpload("Multer error: " + err.code + " - " + err.message);
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Arquivo muito grande. Limite: 2GB." });
        return res.status(400).json({ error: "Erro no upload: " + err.message });
      }
      logUpload("Unknown upload error: " + err.message);
      return res.status(500).json({ error: "Erro interno: " + err.message });
    }
    if (!req.file) { logUpload("No file received"); return res.status(400).json({ error: "Nenhum arquivo enviado." }); }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeMB = (req.file.size / 1024 / 1024).toFixed(1);
    logUpload("OK: " + req.file.originalname + " (" + sizeMB + " MB) in " + elapsed + "s");
    res.json({ ok: true, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
  });
});
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Arquivo muito grande." });
  next(err);
});
app.get("/api/videos", (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter((f) => /\.(mp4|webm|ogg|mkv|avi|mov|m4v)$/i.test(f))
      .map((f) => { const s = fs.statSync(path.join(uploadsDir, f)); return { filename: f, size: s.size, uploadedAt: s.mtime }; })
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json(files);
  } catch (err) { res.json([]); }
});

// Room state with user status tracking
const rooms = {};
const DISCONNECT_TIMEOUT = 15000; // 15s before marking as truly disconnected

// Helper: broadcast user list with statuses
function broadcastUserList(room) {
  if (!rooms[room]) return;
  const users = [];
  for (const [sid, u] of Object.entries(rooms[room].users)) {
    users.push({ nickname: u.nickname, id: sid, status: u.status || "online" });
  }
  io.to(room).emit("userList", users);
}

io.on("connection", (socket) => {
  console.log("connect: " + socket.id);

  socket.on("join", (room) => {
    socket.join(room);
    socket.currentRoom = room;
    if (!socket.nickname) socket.nickname = "User-" + socket.id.slice(0, 4);

    if (!rooms[room]) {
      rooms[room] = {
        users: {},
        paused: true,
        currentTime: 0,
        lastSyncTime: Date.now(),
        currentVideo: "/video",
        currentVideoName: "Backrooms (2026) Dual 1080p.mp4",
      };
    }

    // Cancel any pending disconnect timer for this socket
    if (rooms[room].users[socket.id] && rooms[room].users[socket.id]._dcTimer) {
      clearTimeout(rooms[room].users[socket.id]._dcTimer);
    }

    rooms[room].users[socket.id] = { nickname: socket.nickname, status: "online" };

    socket.emit("roomState", {
      paused: rooms[room].paused,
      currentTime: rooms[room].currentTime,
      currentVideo: rooms[room].currentVideo,
      currentVideoName: rooms[room].currentVideoName,
      myId: socket.id,
    });

    broadcastUserList(room);

    socket.to(room).emit("chatMessage", {
      id: null, from: "Sistema",
      text: socket.nickname + " entrou.", system: true,
    });

    console.log(socket.nickname + " -> " + room);
  });

  socket.on("setNickname", (nickname) => {
    socket.nickname = nickname;
    const room = socket.currentRoom;
    if (room && rooms[room] && rooms[room].users[socket.id]) {
      rooms[room].users[socket.id].nickname = nickname;
      broadcastUserList(room);
    }
  });

  socket.on("chatMessage", (msg) => {
    const room = socket.currentRoom;
    if (!room) return;
    io.to(room).emit("chatMessage", {
      id: socket.id, from: socket.nickname || "User",
      text: msg, system: false, time: Date.now(),
    });
  });

  socket.on("switchVideo", (data) => {
    const room = socket.currentRoom;
    if (!room || !rooms[room]) return;
    rooms[room].currentVideo = data.src;
    rooms[room].currentVideoName = data.name;
    rooms[room].currentTime = 0;
    rooms[room].paused = true;
    rooms[room].lastSyncTime = Date.now();
    io.to(room).emit("videoSwitch", { src: data.src, name: data.name });
    io.to(room).emit("chatMessage", {
      id: null, from: "Sistema",
      text: socket.nickname + " trocou para: " + data.name, system: true,
    });
  });

  socket.on("play", (time) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].paused = false; rooms[r].currentTime = time; rooms[r].lastSyncTime = Date.now(); socket.to(r).emit("remotePlay", time); } });
  socket.on("pause", (time) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].paused = true; rooms[r].currentTime = time; socket.to(r).emit("remotePause", time); } });
  socket.on("seek", (time) => { const r = socket.currentRoom; if (r && rooms[r]) { rooms[r].currentTime = time; rooms[r].lastSyncTime = Date.now(); socket.to(r).emit("remoteSeek", time); } });

  socket.on("requestSync", () => {
    const room = socket.currentRoom;
    if (!room || !rooms[room]) return;
    let t = rooms[room].currentTime;
    if (!rooms[room].paused) t += (Date.now() - rooms[room].lastSyncTime) / 1000;
    socket.emit("sync", {
      paused: rooms[room].paused, currentTime: t,
      currentVideo: rooms[room].currentVideo,
      currentVideoName: rooms[room].currentVideoName,
      myId: socket.id,
    });
  });

  // ── Disconnect / Reconnect logic ──
  socket.on("disconnect", () => {
    console.log("disconnect: " + socket.id);
    const room = socket.currentRoom;
    if (room && rooms[room] && rooms[room].users[socket.id]) {
      rooms[room].users[socket.id].status = "reconnecting";
      broadcastUserList(room);

      // Set a timer — if no reconnect within 15s, mark as disconnected
      rooms[room].users[socket.id]._dcTimer = setTimeout(() => {
        if (rooms[room] && rooms[room].users[socket.id] && rooms[room].users[socket.id].status === "reconnecting") {
          rooms[room].users[socket.id].status = "disconnected";
          broadcastUserList(room);
          socket.to(room).emit("chatMessage", {
            id: null, from: "Sistema",
            text: (rooms[room].users[socket.id].nickname || "User") + " saiu.", system: true,
          });
          // Remove after some time
          setTimeout(() => {
            if (rooms[room] && rooms[room].users[socket.id] && rooms[room].users[socket.id].status === "disconnected") {
              delete rooms[room].users[socket.id];
              broadcastUserList(room);
              if (Object.keys(rooms[room].users).length === 0) delete rooms[room];
            }
          }, 60000);
        }
      }, DISCONNECT_TIMEOUT);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server: http://localhost:" + PORT);
});