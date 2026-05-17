export const DIFFICULTIES = [
  "random",
  "easy",
  "medium",
  "hard",
  "expert",
] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];
export type RealDifficulty = Exclude<Difficulty, "random">;
export type RoomMode = "solo" | "battle";
export type RoomPhase = "lobby" | "active" | "finished";
export type PlayerOutcome = "active" | "won" | "lost";
export type FinishReason = "solved" | "timeout" | "all-eliminated";

export type CellValue = number | null;
export type Board = CellValue[];

export interface PlayerState {
  deviceId: string;
  displayName: string;
  connected: boolean;
  ready: boolean;
  mistakes: number;
  outcome: PlayerOutcome;
  joinedAt: number;
  lastMoveAt: number | null;
  score?: number;
}

export interface RoomState {
  roomCode: string;
  mode: RoomMode;
  difficulty: RealDifficulty;
  createdAt: number;
  startedAt: number;
  expiresAt: number;
  phase: RoomPhase;
  countdownEndsAt: number | null;
  timerSeconds: number | null;
  finishReason: FinishReason | null;
  winnerDeviceId: string | null;
  solvedAt: number | null;
  puzzle: Board;
  board: Board;
  players: Record<string, PlayerState>;
  // optional notes view tailored for the requesting device (populated by server)
  notes?: Record<number, number[]>;
  // list of spectator display names (players who are not active)
  spectators?: string[];
}

export interface DeviceStats {
  deviceId: string;
  displayName: string;
  gamesPlayed: number;
  roomsCreated: number;
  roomsJoined: number;
  wins: number;
  losses: number;
  mistakes: number;
  correctPlacements: number;
  wrongPlacements: number;
  totalScore: number;
  fastestSolveMs: number | null;
  bestWinStreak: number;
  currentWinStreak: number;
  lastSeenAt: number;
  updatedAt: number;
}

export interface CreateRoomPayload {
  deviceId: string;
  displayName: string;
  difficulty: Difficulty;
  timerSeconds?: number | null;
  mode: RoomMode;
}

export interface JoinRoomPayload {
  roomCode: string;
  deviceId: string;
  displayName: string;
}

export interface ReadyRoomPayload {
  roomCode: string;
  deviceId: string;
  ready: boolean;
}

export interface VoiceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type VoiceSignalKind = "offer" | "answer" | "candidate" | "hangup";

export interface VoiceSignalPayload {
  roomCode: string;
  fromDeviceId: string;
  toDeviceId: string;
  kind: VoiceSignalKind;
  sdp?: string;
  candidate?: VoiceCandidatePayload;
}

export interface SubmitCellPayload {
  roomCode: string;
  deviceId: string;
  displayName: string;
  row: number;
  col: number;
  value: CellValue;
}

export interface CellMoveOutcome {
  type: "cleared" | "same" | "correct" | "wrong";
  index: number;
  value: CellValue;
}

export interface CellSubmitResult {
  room: RoomState;
  stats: DeviceStats;
  moveOutcome?: CellMoveOutcome;
}

export interface ReconnectPayload {
  roomCode: string;
  deviceId: string;
  displayName: string;
}

export interface ClientToServerEvents {
  "room:create": (
    payload: CreateRoomPayload,
    callback: (
      response: { room: RoomState; stats: DeviceStats } | { error: string },
    ) => void,
  ) => void;
  "room:join": (
    payload: JoinRoomPayload,
    callback: (
      response: { room: RoomState; stats: DeviceStats } | { error: string },
    ) => void,
  ) => void;
  "room:reconnect": (
    payload: ReconnectPayload,
    callback: (
      response: { room: RoomState; stats: DeviceStats } | { error: string },
    ) => void,
  ) => void;
  "room:ready": (
    payload: ReadyRoomPayload,
    callback: (response: { room: RoomState } | { error: string }) => void,
  ) => void;
  "notes:update": (
    payload: {
      roomCode: string;
      deviceId: string;
      notes: Record<number, number[]>;
    },
    callback?: (response: { room: RoomState } | { error: string }) => void,
  ) => void;
  "voice:signal": (
    payload: VoiceSignalPayload,
    callback: (response: { ok: true } | { error: string }) => void,
  ) => void;
  "cell:submit": (
    payload: SubmitCellPayload,
    callback: (
      response:
        | {
            ok: true;
            room: RoomState;
            stats: DeviceStats;
            moveOutcome?: CellMoveOutcome;
          }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "game:leave": (payload: { roomCode: string; deviceId: string }) => void;
}

export interface ServerToClientEvents {
  "room:updated": (room: RoomState) => void;
  "room:ended": (room: RoomState) => void;
  "stats:updated": (stats: DeviceStats) => void;
  "voice:signal": (payload: VoiceSignalPayload) => void;
  "room:error": (message: string) => void;
}

export interface InterServerEvents {}
export interface SocketData {
  deviceId?: string;
  displayName?: string;
  roomCode?: string;
}

export const DEFAULT_TIMER_BY_DIFFICULTY: Record<RealDifficulty, number> = {
  easy: 15 * 60,
  medium: 12 * 60,
  hard: 9 * 60,
  expert: 6 * 60,
};

export const DEFAULT_BLANKS_BY_DIFFICULTY: Record<RealDifficulty, number> = {
  easy: 38,
  medium: 46,
  hard: 53,
  expert: 58,
};

export const BATTLE_COUNTDOWN_SECONDS = 5;

export function isRealDifficulty(value: Difficulty): value is RealDifficulty {
  return value !== "random";
}

export function createEmptyStats(
  deviceId: string,
  displayName: string,
  now = Date.now(),
): DeviceStats {
  return {
    deviceId,
    displayName,
    gamesPlayed: 0,
    roomsCreated: 0,
    roomsJoined: 0,
    wins: 0,
    losses: 0,
    mistakes: 0,
    correctPlacements: 0,
    wrongPlacements: 0,
    totalScore: 0,
    fastestSolveMs: null,
    bestWinStreak: 0,
    currentWinStreak: 0,
    lastSeenAt: now,
    updatedAt: now,
  };
}
