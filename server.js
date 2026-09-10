const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Class app running at http://localhost:${server.address().port}`);
});

const io = new Server(server);

const EMPTY_CLASS_TTL_MS = 6 * 60 * 60 * 1000; // drop empty classes after 6h of inactivity

// Lobby world — must match the WORLD_WIDTH/HEIGHT/RADIUS in public/index.html
const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 600;
const BLOB_RADIUS = 24;

// code -> { members: Map(name -> { salt, hash, socketId, x, y }), lastActivity }
const classes = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (classes.has(code));
  return code;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, { salt, hash }) {
  const attempt = crypto.scryptSync(password || "", salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(attempt, "hex"), Buffer.from(hash, "hex"));
}

function randomSpawn() {
  return {
    x: BLOB_RADIUS + Math.random() * (WORLD_WIDTH - 2 * BLOB_RADIUS),
    y: BLOB_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * BLOB_RADIUS),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function connectedMembers(cls) {
  return Array.from(cls.members.entries())
    .filter(([, m]) => m.socketId)
    .map(([name, m]) => ({ name, x: m.x, y: m.y }));
}

function touch(cls) {
  cls.lastActivity = Date.now();
}

function kickSocket(socketId, reason) {
  const old = io.sockets.sockets.get(socketId);
  if (!old) return;
  old.emit("kicked", reason);
  old.leave(old.data.classCode);
  old.data.classCode = null;
  old.data.name = null;
}

function leaveCurrentClass(socket) {
  const code = socket.data.classCode;
  if (!code) return;
  const cls = classes.get(code);
  if (cls) {
    const member = cls.members.get(socket.data.name);
    if (member && member.socketId === socket.id) {
      member.socketId = null;
    }
    socket.leave(code);
    touch(cls);
    io.to(code).emit("members", connectedMembers(cls));
  }
  socket.data.classCode = null;
  socket.data.name = null;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, cls] of classes) {
    if (connectedMembers(cls).length === 0 && now - cls.lastActivity > EMPTY_CLASS_TTL_MS) {
      classes.delete(code);
    }
  }
}, 30 * 60 * 1000);

io.on("connection", (socket) => {
  socket.on("createClass", ({ name, password, deviceId }, ack) => {
    name = (name || "").trim().slice(0, 30) || "Anonymous";
    password = (password || "").trim().slice(0, 100);
    deviceId = (deviceId || "").trim().slice(0, 100) || null;
    leaveCurrentClass(socket);

    const code = generateCode();
    const cls = { members: new Map(), lastActivity: Date.now() };
    cls.members.set(name, {
      ...(password ? hashPassword(password) : { salt: null, hash: null }),
      socketId: socket.id,
      deviceId,
      ...randomSpawn(),
    });
    classes.set(code, cls);

    socket.join(code);
    socket.data.classCode = code;
    socket.data.name = name;

    ack({ ok: true, code, members: connectedMembers(cls), world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, radius: BLOB_RADIUS } });
  });

  socket.on("joinClass", ({ code, name, password, deviceId }, ack) => {
    code = (code || "").trim().toUpperCase();
    name = (name || "").trim().slice(0, 30) || "Anonymous";
    password = (password || "").trim().slice(0, 100);
    deviceId = (deviceId || "").trim().slice(0, 100) || null;

    const cls = classes.get(code);
    if (!cls) {
      ack({ ok: false, error: "No class with that code." });
      return;
    }

    const existing = cls.members.get(name);
    if (existing) {
      const connectedNow = existing.socketId && io.sockets.sockets.has(existing.socketId);
      // A page reload doesn't always get a chance to cleanly close the old
      // WebSocket, so the server can lag behind on noticing it's gone. A
      // matching deviceId (a random id this browser persists locally) is
      // treated as proof it's the same browser reconnecting, so it can
      // reclaim the name immediately instead of waiting on that timeout.
      const sameDevice = deviceId && existing.deviceId && deviceId === existing.deviceId;

      if (existing.hash) {
        if (!password || !verifyPassword(password, existing)) {
          ack({
            ok: false,
            code: "WRONG_PASSWORD",
            error: "That name is password-protected in this class. Enter the correct password, or use a different name.",
          });
          return;
        }
        if (connectedNow && existing.socketId !== socket.id) {
          kickSocket(existing.socketId, "You joined this class from another tab or device.");
        }
      } else if (connectedNow && !sameDevice) {
        ack({
          ok: false,
          code: "NAME_IN_USE",
          error: "Someone is already using that name in this class right now. Choose a different name.",
        });
        return;
      } else if (connectedNow) {
        kickSocket(existing.socketId, "You reconnected in another tab or window.");
      } else if (password) {
        // Reclaiming an unprotected, currently-empty name: let them protect it going forward.
        Object.assign(existing, hashPassword(password));
      }

      leaveCurrentClass(socket);
      existing.socketId = socket.id;
      existing.deviceId = deviceId || existing.deviceId;
      if (typeof existing.x !== "number") Object.assign(existing, randomSpawn());
    } else {
      leaveCurrentClass(socket);
      cls.members.set(name, {
        ...(password ? hashPassword(password) : { salt: null, hash: null }),
        socketId: socket.id,
        deviceId,
        ...randomSpawn(),
      });
    }

    socket.join(code);
    socket.data.classCode = code;
    socket.data.name = name;
    touch(cls);

    const members = connectedMembers(cls);
    ack({ ok: true, code, members, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, radius: BLOB_RADIUS } });
    socket.to(code).emit("members", members);
  });

  socket.on("move", ({ x, y }) => {
    const code = socket.data.classCode;
    if (!code || typeof x !== "number" || typeof y !== "number") return;
    const cls = classes.get(code);
    if (!cls) return;
    const member = cls.members.get(socket.data.name);
    if (!member || member.socketId !== socket.id) return;

    member.x = clamp(x, BLOB_RADIUS, WORLD_WIDTH - BLOB_RADIUS);
    member.y = clamp(y, BLOB_RADIUS, WORLD_HEIGHT - BLOB_RADIUS);
    touch(cls);
    socket.to(code).emit("playerMoved", { name: socket.data.name, x: member.x, y: member.y });
  });

  socket.on("leaveClass", () => {
    leaveCurrentClass(socket);
  });

  socket.on("disconnect", () => {
    leaveCurrentClass(socket);
  });
});
