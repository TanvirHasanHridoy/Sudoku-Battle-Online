import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { advanceRoomCountdown, createRoom, getRoom, getRoomForDevice, updateNotes, joinRoom, markPlayerDisconnected, reconnectRoom, rematchRoom, spectateRoom, setPlayerReady, submitCell, sweepExpiredRooms, } from "./gameStore.js";
import { getDeviceStats } from "./statsStore.js";
const app = express();
const httpServer = createServer(app);
const clientDistPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const io = new Server(httpServer, {
    cors: {
        origin: true,
        credentials: true,
    },
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.get("/api/health", (_request, response) => {
    response.json({ ok: true, timestamp: Date.now() });
});
app.get("/api/stats/:deviceId", async (request, response) => {
    const displayName = typeof request.query.displayName === "string"
        ? request.query.displayName
        : "Player";
    const stats = await getDeviceStats(request.params.deviceId, displayName);
    response.json({ stats });
});
app.get("/api/rooms/:roomCode", (request, response) => {
    const room = getRoom(request.params.roomCode.toUpperCase());
    if (!room) {
        response.status(404).json({ error: "Room not found" });
        return;
    }
    response.json({ room });
});
app.use(express.static(clientDistPath));
app.get("*", (_request, response) => {
    response.sendFile(path.join(clientDistPath, "index.html"));
});
async function emitRoomUpdate(roomCode) {
    const sockets = await io.in(roomCode).fetchSockets();
    for (const roomSocket of sockets) {
        const roomState = getRoomForDevice(roomCode, roomSocket.data.deviceId ?? "");
        if (roomState) {
            roomSocket.emit("room:updated", roomState);
        }
    }
}
async function emitVoiceSignal(payload) {
    const sockets = await io.in(payload.roomCode).fetchSockets();
    const targetSocket = sockets.find((roomSocket) => roomSocket.data.deviceId === payload.toDeviceId);
    if (!targetSocket) {
        throw new Error("The target player is not available.");
    }
    targetSocket.emit("voice:signal", payload);
}
io.on("connection", (socket) => {
    socket.on("room:create", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.displayName = payload.displayName;
            const result = await createRoom(payload);
            socket.join(result.room.roomCode);
            socket.data.roomCode = result.room.roomCode;
            socket.emit("stats:updated", result.stats);
            callback(result);
            await emitRoomUpdate(result.room.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to create room.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("room:join", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.displayName = payload.displayName;
            const result = await joinRoom(payload);
            socket.join(result.room.roomCode);
            socket.data.roomCode = result.room.roomCode;
            socket.emit("stats:updated", result.stats);
            callback(result);
            await emitRoomUpdate(result.room.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to join room.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("room:reconnect", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.displayName = payload.displayName;
            const result = await reconnectRoom(payload);
            socket.join(result.room.roomCode);
            socket.data.roomCode = result.room.roomCode;
            socket.emit("stats:updated", result.stats);
            callback(result);
            await emitRoomUpdate(result.room.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to reconnect to room.";
            callback({ error: message });
        }
    });
    socket.on("cell:submit", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.roomCode = payload.roomCode;
            const result = await submitCell(payload);
            socket.emit("stats:updated", result.stats);
            callback({ ok: true, ...result });
            await emitRoomUpdate(result.room.roomCode);
            if (result.room.phase === "finished") {
                const sockets = await io.in(result.room.roomCode).fetchSockets();
                for (const roomSocket of sockets) {
                    const roomState = getRoomForDevice(result.room.roomCode, roomSocket.data.deviceId ?? payload.deviceId);
                    if (roomState) {
                        roomSocket.emit("room:ended", roomState);
                    }
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to submit value.";
            socket.emit("room:error", message);
            callback({ ok: false, error: message });
        }
    });
    socket.on("room:ready", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.roomCode = payload.roomCode;
            const room = await setPlayerReady(payload);
            const roomState = getRoomForDevice(payload.roomCode, payload.deviceId);
            callback({ room: roomState ?? room });
            await emitRoomUpdate(payload.roomCode);
        }
        catch (error) {
            const message = error instanceof Error
                ? error.message
                : "Unable to update ready state.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("room:spectate", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.roomCode = payload.roomCode;
            const room = await spectateRoom(payload.roomCode, payload.deviceId, payload.targetDeviceId);
            callback({ room });
            await emitRoomUpdate(payload.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to spectate room.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("room:rematch", async (payload, callback) => {
        try {
            socket.data.deviceId = payload.deviceId;
            socket.data.roomCode = payload.roomCode;
            const room = await rematchRoom(payload.roomCode, payload.deviceId);
            callback({ room });
            await emitRoomUpdate(payload.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to start rematch.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("voice:signal", async (payload, callback) => {
        try {
            if (!payload.roomCode || payload.fromDeviceId !== socket.data.deviceId) {
                throw new Error("That voice message cannot be sent.");
            }
            const room = getRoomForDevice(payload.roomCode, payload.fromDeviceId);
            if (!room || !room.players[payload.toDeviceId]) {
                throw new Error("That player is not in your room.");
            }
            await emitVoiceSignal(payload);
            callback({ ok: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to send voice signal.";
            socket.emit("room:error", message);
            callback({ error: message });
        }
    });
    socket.on("voice:audio", async (payload) => {
        try {
            if (!payload.roomCode || payload.fromDeviceId !== socket.data.deviceId) {
                throw new Error("That voice message cannot be sent.");
            }
            const room = getRoomForDevice(payload.roomCode, payload.fromDeviceId);
            if (!room || !room.players[payload.fromDeviceId]) {
                throw new Error("That player is not in your room.");
            }
            socket.to(payload.roomCode).emit("voice:audio", payload);
        }
        catch {
            // ignore transient voice relay failures
        }
    });
    socket.on("notes:update", async (payload, callback) => {
        try {
            if (!payload.roomCode || payload.deviceId !== socket.data.deviceId) {
                throw new Error("That notes message cannot be accepted.");
            }
            const updated = await updateNotes(payload.roomCode, payload.deviceId, payload.notes);
            callback?.({ room: updated });
            await emitRoomUpdate(payload.roomCode);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unable to update notes.";
            socket.emit("room:error", message);
            callback?.({ error: message });
        }
    });
    socket.on("game:leave", async (payload) => {
        await markPlayerDisconnected(payload.roomCode, payload.deviceId);
        await emitRoomUpdate(payload.roomCode);
        socket.leave(payload.roomCode);
    });
    socket.on("disconnect", async () => {
        const roomCode = socket.data.roomCode;
        const deviceId = socket.data.deviceId;
        if (!roomCode || !deviceId) {
            return;
        }
        await markPlayerDisconnected(roomCode, deviceId);
        await emitRoomUpdate(roomCode);
    });
});
const sweepTimer = setInterval(async () => {
    const lobbyRooms = Array.from(new Set(io.sockets.adapter.rooms.keys()));
    for (const roomCode of lobbyRooms) {
        const startedRoom = await advanceRoomCountdown(roomCode);
        if (startedRoom) {
            await emitRoomUpdate(roomCode);
        }
    }
    const endedRooms = await sweepExpiredRooms();
    for (const room of endedRooms) {
        const sockets = await io.in(room.roomCode).fetchSockets();
        for (const roomSocket of sockets) {
            const roomState = getRoomForDevice(room.roomCode, roomSocket.data.deviceId ?? "");
            if (roomState) {
                roomSocket.emit("room:ended", roomState);
            }
        }
    }
}, 1000);
sweepTimer.unref();
const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => {
    console.log(`Sudoku Remote server running on http://localhost:${port}`);
});
