const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcrypt");

const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

app.use(express.json());
app.use(express.static(__dirname));

const adapter = new JSONFile("db.json");
const db = new Low(adapter, { users: [], messages: [], dms: [] });

let onlineUsers = {};

async function initDB() {
  await db.read();
  await db.write();
}
initDB();

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  await db.read();

  if (db.data.users.find(u => u.username === username)) {
    return res.json({ success: false, message: "Ce pseudo est déjà pris" });
  }

  const hash = await bcrypt.hash(password, 10);
  db.data.users.push({ username, password: hash });
  await db.write();
  res.json({ success: true, message: "Compte créé !" });
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  await db.read();

  const user = db.data.users.find(u => u.username === username);
  if (!user) return res.json({ success: false, message: "Utilisateur introuvable" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.json({ success: false, message: "Mot de passe incorrect" });

  res.json({ success: true });
});

// ================= USERS ENDPOINT =================
app.get("/users", async (req, res) => {
  await db.read();
  res.json(db.data.users.map(u => u.username));
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
  socket.on("chat message", async (msg) => {
    await db.read();
    const message = {
      user: msg.user,
      text: msg.text,
      time: new Date().toISOString()
    };
    db.data.messages.push(message);
    await db.write();
    io.emit("chat message", message);
  });

  socket.on("load messages", async () => {
    await db.read();
    socket.emit("load messages", db.data.messages);
  });

  // ================= DM PRIVÉ =================
  socket.on("private message", async (data) => {
    await db.read();
    const dm = {
      from: data.from,
      to: data.to,
      text: data.text,
      time: new Date().toISOString()
    };
    db.data.dms.push(dm);
    await db.write();

    const targetSocket = onlineUsers[data.to];
    if (targetSocket) {
      io.to(targetSocket).emit("private message", dm);
    }
    socket.emit("private message", dm);
  });

  socket.on("load dms", async (user) => {
    await db.read();
    const dms = db.data.dms.filter(dm => dm.from === user || dm.to === user);
    socket.emit("load dms", dms);
  });

});

http.listen(3000, () => {
  console.log("http://localhost:3000");
});