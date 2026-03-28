const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");

const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

const adapter = new FileSync("db.json");
const db = low(adapter);
db.defaults({ users: [], messages: [], dms: [] }).write();

let onlineUsers = {};

// ================= REGISTER =================
app.post("/register", (req, res) => {
  const { username, password } = req.body;
  const exists = db.get("users").find({ username }).value();
  if (exists) return res.json({ success: false, message: "Ce pseudo est déjà pris" });
  const hash = bcrypt.hashSync(password, 10);
  db.get("users").push({ username, password: hash, avatar: null, bio: "" }).write();
  res.json({ success: true });
});

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.get("users").find({ username }).value();
  if (!user) return res.json({ success: false, message: "Utilisateur introuvable" });
  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.json({ success: false, message: "Mot de passe incorrect" });
  res.json({ success: true });
});

// ================= USERS =================
app.get("/users", (req, res) => {
  res.json(db.get("users").map("username").value());
});

// ================= PROFILE GET =================
app.get("/profile/:username", (req, res) => {
  const user = db.get("users").find({ username: req.params.username }).value();
  if (!user) return res.status(404).json({ error: "Introuvable" });
  res.json({ username: user.username, avatar: user.avatar || null, bio: user.bio || "" });
});

// ================= PROFILE UPDATE =================
app.post("/profile/update", (req, res) => {
  const { username, newUsername, avatar, bio } = req.body;
  const user = db.get("users").find({ username }).value();
  if (!user) return res.json({ success: false, message: "Utilisateur introuvable" });

  // Check new username uniqueness
  if (newUsername && newUsername !== username) {
    const taken = db.get("users").find({ username: newUsername }).value();
    if (taken) return res.json({ success: false, message: "Ce pseudo est déjà pris" });

    // Update all messages & DMs with new username
    db.get("messages")
      .filter(m => m.user === username)
      .each(m => { m.user = newUsername; })
      .value();
    db.get("dms")
      .filter(d => d.from === username)
      .each(d => { d.from = newUsername; })
      .value();
    db.get("dms")
      .filter(d => d.to === username)
      .each(d => { d.to = newUsername; })
      .value();

    db.get("users").find({ username }).assign({ username: newUsername }).value();
  }

  const finalUsername = newUsername || username;
  if (avatar !== undefined) db.get("users").find({ username: finalUsername }).assign({ avatar }).value();
  if (bio !== undefined) db.get("users").find({ username: finalUsername }).assign({ bio }).value();
  db.write();

  if (newUsername && newUsername !== username) {
    io.emit("username changed", { oldUsername: username, newUsername });
  }

  res.json({ success: true, newUsername: finalUsername });
});

// ================= DELETE ACCOUNT =================
app.post("/delete-account", (req, res) => {
  const { username, password } = req.body;
  const user = db.get("users").find({ username }).value();
  if (!user) return res.json({ success: false, message: "Utilisateur introuvable" });
  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.json({ success: false, message: "Mot de passe incorrect" });

  db.get("users").remove({ username }).write();
  db.get("messages").remove({ user: username }).write();
  db.get("dms").remove(d => d.from === username || d.to === username).write();

  io.emit("account deleted", { username });
  res.json({ success: true });
});

// ================= SOCKET =================
io.on("connection", (socket) => {

  socket.on("join", (username) => {
    onlineUsers[username] = socket.id;
    io.emit("users", Object.keys(onlineUsers));
  });

  socket.on("disconnect", () => {
    for (let user in onlineUsers) {
      if (onlineUsers[user] === socket.id) {
        delete onlineUsers[user];
        io.emit("stop typing", { user, chat: "global" });
      }
    }
    io.emit("users", Object.keys(onlineUsers));
  });

  // ================= TYPING =================
  socket.on("typing", ({ user, chat }) => {
    if (chat === "global") {
      socket.broadcast.emit("typing", { user, chat });
    } else {
      const t = onlineUsers[chat];
      if (t) io.to(t).emit("typing", { user, chat: user });
    }
  });

  socket.on("stop typing", ({ user, chat }) => {
    if (chat === "global") {
      socket.broadcast.emit("stop typing", { user, chat });
    } else {
      const t = onlineUsers[chat];
      if (t) io.to(t).emit("stop typing", { user, chat: user });
    }
  });

  // ================= CHAT GLOBAL =================
  socket.on("chat message", (msg) => {
    const message = {
      id: Date.now().toString(),
      user: msg.user,
      text: msg.text,
      time: new Date().toISOString()
    };
    db.get("messages").push(message).write();
    io.emit("chat message", message);
  });

  socket.on("load messages", () => {
    socket.emit("load messages", db.get("messages").value());
  });

  // ================= DELETE MESSAGE =================
  socket.on("delete message", ({ id, user, chat }) => {
    if (chat === "global") {
      const msg = db.get("messages").find({ id }).value();
      if (msg && msg.user === user) {
        db.get("messages").remove({ id }).write();
        io.emit("message deleted", { id, chat: "global" });
      }
    } else {
      const dm = db.get("dms").find({ id }).value();
      if (dm && dm.from === user) {
        db.get("dms").remove({ id }).write();
        io.emit("message deleted", { id, chat });
      }
    }
  });

  // ================= DM =================
  socket.on("private message", (data) => {
    const dm = {
      id: Date.now().toString(),
      from: data.from,
      to: data.to,
      text: data.text,
      time: new Date().toISOString()
    };
    db.get("dms").push(dm).write();
    const t = onlineUsers[data.to];
    if (t) io.to(t).emit("private message", dm);
    socket.emit("private message", dm);
  });

  socket.on("load dms", (user) => {
    const dms = db.get("dms").filter(dm => dm.from === user || dm.to === user).value();
    socket.emit("load dms", dms);
  });

});

http.listen(3000, () => console.log("http://localhost:3000"));