const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");

const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

app.use(express.json());
app.use(express.static(__dirname));

const adapter = new FileSync("db.json");
const db = low(adapter);
db.defaults({ users: [], messages: [], dms: [] }).write();

let onlineUsers = {};

// ================= REGISTER =================
app.post("/register", (req, res) => {
  const { username, password } = req.body;

  const exists = db.get("users").find({ username }).value();
  if (exists) {
    return res.json({ success: false, message: "Ce pseudo est déjà pris" });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.get("users").push({ username, password: hash }).write();
  res.json({ success: true, message: "Compte créé !" });
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

// ================= USERS ENDPOINT =================
app.get("/users", (req, res) => {
  const users = db.get("users").map("username").value();
  res.json(users);
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
      const targetSocket = onlineUsers[chat];
      if (targetSocket) {
        io.to(targetSocket).emit("typing", { user, chat: user });
      }
    }
  });

  socket.on("stop typing", ({ user, chat }) => {
    if (chat === "global") {
      socket.broadcast.emit("stop typing", { user, chat });
    } else {
      const targetSocket = onlineUsers[chat];
      if (targetSocket) {
        io.to(targetSocket).emit("stop typing", { user, chat: user });
      }
    }
  });

  // ================= CHAT GLOBAL =================
  socket.on("chat message", (msg) => {
    const message = {
      user: msg.user,
      text: msg.text,
      time: new Date().toISOString()
    };
    db.get("messages").push(message).write();
    io.emit("chat message", message);
  });

  socket.on("load messages", () => {
    const messages = db.get("messages").value();
    socket.emit("load messages", messages);
  });

  // ================= DM PRIVÉ =================
  socket.on("private message", (data) => {
    const dm = {
      from: data.from,
      to: data.to,
      text: data.text,
      time: new Date().toISOString()
    };
    db.get("dms").push(dm).write();

    const targetSocket = onlineUsers[data.to];
    if (targetSocket) {
      io.to(targetSocket).emit("private message", dm);
    }
    socket.emit("private message", dm);
  });

  socket.on("load dms", (user) => {
    const dms = db.get("dms")
      .filter(dm => dm.from === user || dm.to === user)
      .value();
    socket.emit("load dms", dms);
  });

});

http.listen(3000, () => {
  console.log("http://localhost:3000");
});