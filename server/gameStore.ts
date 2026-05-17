import {
  BATTLE_COUNTDOWN_SECONDS,
  DEFAULT_TIMER_BY_DIFFICULTY,
  type Board,
  type CellMoveOutcome,
  type CreateRoomPayload,
  type Difficulty,
  type FinishReason,
  type JoinRoomPayload,
  type ReadyRoomPayload,
  type PlayerState,
  type ReconnectPayload,
  type RealDifficulty,
  type RoomState,
  type SubmitCellPayload,
  isRealDifficulty,
} from "../shared/game.js";
import {
  getDeviceStats,
  recordCorrectPlacement,
  recordLoss,
  recordMistake,
  recordRoomCreated,
  recordRoomJoined,
  recordWin,
} from "./statsStore.js";
import { generateSudokuPuzzle } from "./sudoku.js";

interface InternalRoom extends Omit<RoomState, "notes"> {
  solution: Board;
  boards: Record<string, Board>;
  notes: Record<string, Record<number, number[]>>;
}

const rooms = new Map<string, InternalRoom>();

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  while (code.length < 6) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  if (!rooms.has(code)) {
    return code;
  }

  return makeRoomCode();
}

function pickDifficulty(difficulty: Difficulty): RealDifficulty {
  if (isRealDifficulty(difficulty)) {
    return difficulty;
  }

  const options: RealDifficulty[] = ["easy", "medium", "hard", "expert"];
  return options[Math.floor(Math.random() * options.length)];
}

function getBoardForDevice(room: InternalRoom, deviceId?: string) {
  if (deviceId) {
    const player = room.players[deviceId];
    if (player?.outcome === "active" && room.boards[deviceId]) {
      return room.boards[deviceId];
    }

    const activeOpponent = Object.values(room.players).find(
      (otherPlayer) =>
        otherPlayer.deviceId !== deviceId &&
        otherPlayer.outcome === "active" &&
        room.boards[otherPlayer.deviceId],
    );

    if (activeOpponent) {
      return room.boards[activeOpponent.deviceId];
    }

    if (room.boards[deviceId]) {
      return room.boards[deviceId];
    }
  }

  const firstBoard = Object.values(room.boards)[0];
  return firstBoard ?? room.puzzle;
}

function cloneRoom(room: InternalRoom, deviceId?: string): RoomState {
  const {
    solution: _solution,
    boards: _boards,
    notes: _notes,
    ...publicRoom
  } = room;
  const cloned = structuredClone(publicRoom);
  cloned.board = structuredClone(getBoardForDevice(room, deviceId));
  // include a tailored notes view for the requesting device
  (cloned as RoomState).notes = structuredClone(
    getNotesForDevice(room, deviceId),
  );
  // compute spectators as display names of players who are not active but connected
  (cloned as RoomState).spectators = Object.values(room.players)
    .filter((p) => p.outcome !== "active" && p.connected)
    .map((p) => p.displayName);
  return cloned;
}

function createPlayer(deviceId: string, displayName: string): PlayerState {
  return {
    deviceId,
    displayName,
    connected: true,
    ready: false,
    mistakes: 0,
    outcome: "active",
    joinedAt: Date.now(),
    lastMoveAt: null,
    score: 0,
  };
}

function ensurePlayer(
  room: InternalRoom,
  deviceId: string,
  displayName: string,
) {
  const existing = room.players[deviceId];

  if (!existing) {
    room.players[deviceId] = createPlayer(deviceId, displayName);
    return room.players[deviceId];
  }

  existing.displayName = displayName;
  existing.connected = true;
  if (!room.boards[deviceId]) {
    room.boards[deviceId] = [...room.puzzle];
  }
  if (!room.notes) {
    room.notes = {};
  }
  if (!room.notes[deviceId]) {
    room.notes[deviceId] = {};
  }
  return existing;
}

function ensureBoard(room: InternalRoom, deviceId: string) {
  if (!room.boards[deviceId]) {
    room.boards[deviceId] = [...room.puzzle];
  }

  return room.boards[deviceId];
}

function countActivePlayers(room: InternalRoom) {
  return Object.values(room.players).filter(
    (player) => player.outcome === "active",
  ).length;
}

function hasAllConnectedPlayersReady(room: InternalRoom) {
  const connectedActivePlayers = Object.values(room.players).filter(
    (player) => player.connected && player.outcome === "active",
  );

  return (
    connectedActivePlayers.length > 0 &&
    connectedActivePlayers.every((player) => player.ready)
  );
}

function clearBattleCountdown(room: InternalRoom) {
  room.countdownEndsAt = null;
}

function prepareRoomForStart(room: InternalRoom, now = Date.now()) {
  room.phase = "active";
  room.startedAt = now;

  if (room.timerSeconds === null) {
    room.expiresAt = Number.MAX_SAFE_INTEGER;
  } else {
    room.expiresAt = now + room.timerSeconds * 1000;
  }
}

async function finishRoom(
  room: InternalRoom,
  reason: FinishReason,
  winnerDeviceId: string | null,
) {
  if (room.phase === "finished") {
    return cloneRoom(room);
  }

  const now = Date.now();
  room.phase = "finished";
  room.finishReason = reason;
  room.winnerDeviceId = winnerDeviceId;
  room.solvedAt = now;
  room.countdownEndsAt = null;

  const solveTimeMs = now - room.startedAt;

  if (reason === "solved" && winnerDeviceId) {
    const winner = room.players[winnerDeviceId];
    if (winner) {
      winner.outcome = "won";
      // award win bonus and time-left bonus for timed games
      const baseBonus = 100;
      let timeLeftBonus = 0;
      const largeThreshold = Date.now() + 100 * 365 * 24 * 3600 * 1000;
      if (Number.isFinite(room.expiresAt) && room.expiresAt < largeThreshold) {
        timeLeftBonus = Math.max(0, Math.floor((room.expiresAt - now) / 1000));
      }
      const bonus = baseBonus + timeLeftBonus;
      winner.score = (winner.score ?? 0) + bonus;
      await recordWin(winner.deviceId, winner.displayName, solveTimeMs, bonus);
    }

    for (const player of Object.values(room.players)) {
      if (player.deviceId === winnerDeviceId || player.outcome !== "active") {
        continue;
      }

      player.outcome = "lost";
      await recordLoss(player.deviceId, player.displayName);
    }
  }

  if (reason === "timeout" || reason === "all-eliminated") {
    for (const player of Object.values(room.players)) {
      if (player.outcome !== "active") {
        continue;
      }

      player.outcome = "lost";
      await recordLoss(player.deviceId, player.displayName);
    }
  }

  return cloneRoom(room);
}

function isSolvedBoard(board: Board, solution: Board) {
  return board.every((value, index) => value === solution[index]);
}

export async function createRoom(payload: CreateRoomPayload) {
  const roomCode = makeRoomCode();
  const difficulty = pickDifficulty(payload.difficulty);
  const puzzle = generateSudokuPuzzle(difficulty);
  const now = Date.now();
  const timerSeconds = Object.prototype.hasOwnProperty.call(
    payload,
    "timerSeconds",
  )
    ? payload.timerSeconds
    : undefined;
  let expiresAt: number;

  if (timerSeconds === null) {
    expiresAt = Number.MAX_SAFE_INTEGER;
  } else if (typeof timerSeconds === "number") {
    expiresAt = now + Math.max(0, Math.floor(timerSeconds)) * 1000;
  } else {
    expiresAt = now + DEFAULT_TIMER_BY_DIFFICULTY[difficulty] * 1000;
  }

  const room: InternalRoom = {
    roomCode,
    mode: payload.mode,
    difficulty,
    createdAt: now,
    startedAt: payload.mode === "solo" ? now : 0,
    expiresAt,
    phase: payload.mode === "solo" ? "active" : "lobby",
    countdownEndsAt: payload.mode === "solo" ? null : null,
    timerSeconds:
      timerSeconds === null
        ? null
        : typeof timerSeconds === "number"
          ? Math.max(0, Math.floor(timerSeconds))
          : DEFAULT_TIMER_BY_DIFFICULTY[difficulty],
    finishReason: null,
    winnerDeviceId: null,
    solvedAt: null,
    puzzle: puzzle.puzzle,
    board: [...puzzle.puzzle],
    boards: {
      [payload.deviceId]: [...puzzle.puzzle],
    },
    notes: {
      [payload.deviceId]: {},
    },
    players: {
      [payload.deviceId]: createPlayer(payload.deviceId, payload.displayName),
    },
    solution: puzzle.solution,
  };

  if (room.mode === "battle") {
    room.expiresAt = Number.MAX_SAFE_INTEGER;
  }

  rooms.set(roomCode, room);
  await recordRoomCreated(payload.deviceId, payload.displayName);
  const stats = await getDeviceStats(payload.deviceId, payload.displayName);

  return {
    room: cloneRoom(room, payload.deviceId),
    stats,
  };
}

function getNotesForDevice(room: InternalRoom, deviceId?: string) {
  if (!room.notes) return {};

  const viewer = deviceId ? room.players[deviceId] : null;

  // If the requesting device is still active, only show their own notes
  if (viewer && viewer.outcome === "active") {
    return room.notes[deviceId!] ?? {};
  }

  // Spectators: merge notes from all players into a single view
  const merged: Record<number, number[]> = {};

  for (const playerNotes of Object.values(room.notes)) {
    for (const [indexText, vals] of Object.entries(playerNotes)) {
      const idx = Number(indexText);
      const existing = new Set(merged[idx] ?? []);
      for (const v of vals) existing.add(v);
      merged[idx] = Array.from(existing).sort((a, b) => a - b);
    }
  }

  return merged;
}

export async function updateNotes(
  roomCode: string,
  deviceId: string,
  notes: Record<number, number[]>,
) {
  const room = rooms.get(roomCode);
  if (!room) throw new Error("Room not found");

  if (!room.notes) room.notes = {};
  room.notes[deviceId] = notes;

  return cloneRoom(room, deviceId);
}

export async function joinRoom(payload: JoinRoomPayload) {
  const room = rooms.get(payload.roomCode);

  if (!room) {
    throw new Error("That room does not exist anymore.");
  }

  // If this is a solo game and there's already an active player, new joiners become spectators
  const isJoiningActiveSoloGame =
    room.mode === "solo" && room.phase === "active";
  const shouldBeSpectator =
    isJoiningActiveSoloGame &&
    Object.values(room.players).some((p) => p.outcome === "active");

  const player = ensurePlayer(room, payload.deviceId, payload.displayName);
  if (shouldBeSpectator) {
    player.outcome = "lost"; // spectators use "lost" as non-active outcome
  }
  player.connected = true;
  player.ready = false;
  ensureBoard(room, payload.deviceId);
  await recordRoomJoined(payload.deviceId, payload.displayName);
  const stats = await getDeviceStats(payload.deviceId, payload.displayName);

  if (room.mode === "battle") {
    clearBattleCountdown(room);
  }

  return {
    room: cloneRoom(room, payload.deviceId),
    stats,
  };
}

export async function reconnectRoom(payload: ReconnectPayload) {
  const room = rooms.get(payload.roomCode);

  if (!room) {
    throw new Error("That room does not exist anymore.");
  }

  const player = ensurePlayer(room, payload.deviceId, payload.displayName);
  player.connected = true;
  player.ready = false;
  ensureBoard(room, payload.deviceId);
  const stats = await getDeviceStats(payload.deviceId, payload.displayName);

  return {
    room: cloneRoom(room, payload.deviceId),
    stats,
  };
}

export async function submitCell(payload: SubmitCellPayload) {
  const room = rooms.get(payload.roomCode);

  if (!room) {
    throw new Error("The room could not be found.");
  }

  if (room.phase !== "active") {
    throw new Error("This game already ended.");
  }

  const player = room.players[payload.deviceId];

  if (!player) {
    throw new Error("You are not part of this room.");
  }

  if (player.outcome !== "active") {
    throw new Error("You have already lost this round.");
  }

  if (
    payload.row < 0 ||
    payload.row > 8 ||
    payload.col < 0 ||
    payload.col > 8
  ) {
    throw new Error("That cell is outside the board.");
  }

  const index = payload.row * 9 + payload.col;

  if (room.puzzle[index] !== null) {
    throw new Error("That square is locked.");
  }

  const board = ensureBoard(room, payload.deviceId);

  if (payload.value === null) {
    board[index] = null;
    player.lastMoveAt = Date.now();
    const stats = await getDeviceStats(payload.deviceId, payload.displayName);

    return {
      room: cloneRoom(room, payload.deviceId),
      stats,
      moveOutcome: {
        type: "cleared",
        index,
        value: null,
      } satisfies CellMoveOutcome,
    };
  }

  if (payload.value === board[index]) {
    const stats = await getDeviceStats(payload.deviceId, payload.displayName);

    return {
      room: cloneRoom(room, payload.deviceId),
      stats,
      moveOutcome: {
        type: "same",
        index,
        value: payload.value,
      } satisfies CellMoveOutcome,
    };
  }

  if (payload.value === room.solution[index]) {
    board[index] = payload.value;
    player.lastMoveAt = Date.now();
    await recordCorrectPlacement(payload.deviceId, payload.displayName);
    player.score = (player.score ?? 0) + 10;
    const stats = await getDeviceStats(payload.deviceId, payload.displayName);

    if (isSolvedBoard(board, room.solution)) {
      const finishedRoom = await finishRoom(room, "solved", payload.deviceId);
      return {
        room: finishedRoom,
        stats,
      };
    }

    return {
      room: cloneRoom(room, payload.deviceId),
      stats,
      moveOutcome: {
        type: "correct",
        index,
        value: payload.value,
      } satisfies CellMoveOutcome,
    };
  }

  player.mistakes += 1;
  player.lastMoveAt = Date.now();
  await recordMistake(payload.deviceId, payload.displayName);
  player.score = (player.score ?? 0) - 5;
  const stats = await getDeviceStats(payload.deviceId, payload.displayName);

  if (player.mistakes >= 3) {
    player.outcome = "lost";
    player.ready = false;
    await recordLoss(payload.deviceId, payload.displayName);

    if (countActivePlayers(room) === 0) {
      const finishedRoom = await finishRoom(room, "all-eliminated", null);
      return {
        room: finishedRoom,
        stats,
      };
    }
  }

  return {
    room: cloneRoom(room, payload.deviceId),
    stats,
    moveOutcome: {
      type: "wrong",
      index,
      value: payload.value,
    } satisfies CellMoveOutcome,
  };
}

export async function markPlayerDisconnected(
  roomCode: string,
  deviceId: string,
) {
  const room = rooms.get(roomCode);

  if (!room) {
    return null;
  }

  const player = room.players[deviceId];

  if (player) {
    player.connected = false;
    player.ready = false;
  }

  if (room.mode === "battle" && room.phase === "lobby") {
    clearBattleCountdown(room);
  }

  return cloneRoom(room);
}

export async function setPlayerReady(payload: ReadyRoomPayload) {
  const room = rooms.get(payload.roomCode);

  if (!room) {
    throw new Error("That room does not exist anymore.");
  }

  if (room.phase === "finished") {
    throw new Error("This game already ended.");
  }

  const player = room.players[payload.deviceId];

  if (!player) {
    throw new Error("You are not part of this room.");
  }

  if (player.outcome !== "active") {
    throw new Error("You cannot ready up after being eliminated.");
  }

  player.ready = payload.ready;

  if (room.mode === "battle") {
    if (
      hasAllConnectedPlayersReady(room) &&
      Object.values(room.players).filter(
        (player) => player.connected && player.outcome === "active",
      ).length >= 2
    ) {
      const now = Date.now();
      room.countdownEndsAt =
        room.countdownEndsAt ?? now + BATTLE_COUNTDOWN_SECONDS * 1000;
    } else {
      clearBattleCountdown(room);
    }
  }

  return cloneRoom(room, payload.deviceId);
}

export async function advanceRoomCountdown(roomCode: string) {
  const room = rooms.get(roomCode);

  if (!room || room.phase !== "lobby" || room.mode !== "battle") {
    return null;
  }

  if (!room.countdownEndsAt || Date.now() < room.countdownEndsAt) {
    return null;
  }

  prepareRoomForStart(room);
  room.countdownEndsAt = null;
  return cloneRoom(room);
}

export async function sweepExpiredRooms(now = Date.now()) {
  const endedRooms: RoomState[] = [];

  for (const room of rooms.values()) {
    if (room.phase !== "active") {
      continue;
    }

    if (now < room.expiresAt) {
      continue;
    }

    endedRooms.push(await finishRoom(room, "timeout", null));
  }

  return endedRooms;
}

export function getRoom(roomCode: string) {
  const room = rooms.get(roomCode);
  return room ? cloneRoom(room) : null;
}

export function getRoomForDevice(roomCode: string, deviceId: string) {
  const room = rooms.get(roomCode);
  return room ? cloneRoom(room, deviceId) : null;
}
