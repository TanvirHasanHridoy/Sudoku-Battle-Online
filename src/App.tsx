import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Board } from "@/components/Board";
import {
  clearActiveRoomCode,
  getActiveRoomCode,
  getDeviceId,
  getDisplayName,
  normalizeRoomCode,
  setActiveRoomCode,
  setDisplayName,
} from "@/lib/device";
import { fetchDeviceStats } from "@/lib/api";
import { createGameSocket, type GameSocket } from "@/lib/socket";
import {
  DIFFICULTIES,
  type CellValue,
  type DeviceStats,
  type Difficulty,
  type RoomMode,
  type RoomState,
  type VoiceCandidatePayload,
  type VoiceSignalPayload,
} from "@shared/game";

const difficultyLabels: Record<Difficulty, string> = {
  random: "Random",
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  expert: "Expert",
};

const difficultyDescriptions: Record<Exclude<Difficulty, "random">, string> = {
  easy: "Calm pace and generous timer.",
  medium: "Balanced race for most groups.",
  hard: "Sharper clues with less time.",
  expert: "Fast round for serious players.",
};

type UndoAction =
  | { kind: "note-toggle"; index: number; digit: number }
  | { kind: "note-clear"; index: number; digits: number[] }
  | { kind: "value"; index: number; previousValue: CellValue };

type AckEventName =
  | "room:create"
  | "room:join"
  | "room:reconnect"
  | "room:ready"
  | "voice:signal"
  | "cell:submit";

type ThemeMode = "system" | "dark" | "light";
type ToastTone = "neutral" | "success" | "danger";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface VoicePeerState {
  pc: RTCPeerConnection;
  audioSender: RTCRtpSender | null;
  remoteStream: MediaStream | null;
  pendingCandidates: VoiceCandidatePayload[];
}

function formatTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) {
    return "n/a";
  }

  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes <= 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function firstEditableCell(room: RoomState) {
  return room.board.findIndex(
    (value, index) => value === null && room.puzzle[index] === null,
  );
}

function getFinishedDigits(board: CellValue[]) {
  const counts = new Map<number, number>();

  for (const value of board) {
    if (typeof value === "number") {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count >= 9)
      .map(([digit]) => digit),
  );
}

function pruneNotesForRoom(notes: Record<number, number[]>, room: RoomState) {
  const finishedDigits = getFinishedDigits(room.board);
  let changed = false;
  const nextNotes: Record<number, number[]> = {};

  for (const [indexText, values] of Object.entries(notes)) {
    const filtered = values.filter((digit) => !finishedDigits.has(digit));
    if (filtered.length !== values.length) {
      changed = true;
    }

    if (filtered.length > 0) {
      nextNotes[Number(indexText)] = filtered;
    } else if (values.length > 0) {
      changed = true;
    }
  }

  return changed ? nextNotes : notes;
}

function outcomeLabel(outcome: RoomState["players"][string]["outcome"]) {
  if (outcome === "won") {
    return "Won";
  }

  if (outcome === "lost") {
    return "Lost";
  }

  return "Playing";
}

function outcomeTone(outcome: RoomState["players"][string]["outcome"]) {
  if (outcome === "won") {
    return "border-emerald-400/40 bg-emerald-400/10 text-emerald-100";
  }

  if (outcome === "lost") {
    return "border-rose-400/40 bg-rose-400/10 text-rose-100";
  }

  return "border-white/10 bg-white/5 text-slate-200";
}

function mergeRoomState(nextRoom: RoomState | null) {
  return nextRoom;
}

function getDifficultyHint(difficulty: Difficulty) {
  if (difficulty === "random") {
    return "Server picks a fresh difficulty when the room is created.";
  }

  return difficultyDescriptions[difficulty];
}

function getVoiceTargetIds(room: RoomState | null, selfDeviceId: string) {
  if (!room || room.mode !== "battle") {
    return [];
  }

  return Object.values(room.players)
    .filter((player) => player.deviceId !== selfDeviceId && player.connected)
    .map((player) => player.deviceId);
}

function buildRoomInviteUrl(roomCode: string) {
  if (typeof window === "undefined") {
    return "";
  }

  return `${window.location.origin}/?room=${encodeURIComponent(roomCode)}`;
}

function getStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }

  const stored = window.localStorage.getItem("sudoku-theme-mode");
  if (stored === "dark" || stored === "light" || stored === "system") {
    return stored;
  }

  return "system";
}

export default function App() {
  const [deviceId] = useState(() => getDeviceId());
  const [displayNameDraft, setDisplayNameDraft] = useState(() =>
    getDisplayName(),
  );
  const [roomCodeDraft, setRoomCodeDraft] = useState(() =>
    normalizeRoomCode(getActiveRoomCode()),
  );
  const [difficulty, setDifficulty] = useState<Difficulty>("random");
  const [roomMode, setRoomMode] = useState<RoomMode>("battle");
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [room, setRoom] = useState<RoomState | null>(null);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [statusMessage, setStatusMessage] = useState(
    "Create a room or join one on the same Wi-Fi.",
  );
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, number[]>>({});
  const [noteMode, setNoteMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<
    "idle" | "starting" | "active" | "error"
  >("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceStreams, setVoiceStreams] = useState<
    Record<string, MediaStream | null>
  >({});

  useEffect(() => {
    if (!room) return;
    try {
      socketRef.current?.emit("notes:update", {
        roomCode: room.roomCode,
        deviceId,
        notes,
      });
    } catch (e) {
      // no-op
    }
  }, [notes, room?.roomCode, deviceId]);
  const [wrongMove, setWrongMove] = useState<{
    index: number;
    value: number;
  } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [finishModal, setFinishModal] = useState<{
    visible: boolean;
    outcome: "won" | "lost" | null;
    score: number;
  }>({ visible: false, outcome: null, score: 0 });
  const prevRoomRef = useRef<RoomState | null>(null);
  const wrongMoveTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const toastIdRef = useRef(0);
  const undoHistoryRef = useRef<UndoAction[]>([]);
  const isReplayingUndoRef = useRef(false);
  const prevScoreRef = useRef<number | null>(null);
  const lastFinishedRoomRef = useRef<string | null>(null);
  const [createTimerOption, setCreateTimerOption] = useState<
    "default" | "none" | "custom"
  >("default");
  const [createTimerSeconds, setCreateTimerSeconds] = useState<number>(300);
  const [now, setNow] = useState(() => Date.now());
  const [isBusy, setIsBusy] = useState(false);
  const [socketReady, setSocketReady] = useState(false);
  const socketRef = useRef<GameSocket | null>(null);
  const initialRoomAction = useRef<"join" | "reconnect" | null>(null);
  const autoJoinAttempted = useRef(false);
  const voiceLocalStreamRef = useRef<MediaStream | null>(null);
  const voicePeersRef = useRef<Record<string, VoicePeerState>>({});
  const voiceTargetIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const queryRoom = normalizeRoomCode(url.searchParams.get("room") ?? "");
    const storedRoom = normalizeRoomCode(getActiveRoomCode());
    const savedName = getDisplayName();

    if (savedName) {
      setDisplayNameDraft(savedName);
    }

    if (queryRoom) {
      setRoomCodeDraft(queryRoom);
      initialRoomAction.current = "join";
    } else if (storedRoom) {
      setRoomCodeDraft(storedRoom);
      initialRoomAction.current = "reconnect";
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemPreference = () => {
      setSystemPrefersDark(media.matches);
    };

    updateSystemPreference();

    if (media.addEventListener) {
      media.addEventListener("change", updateSystemPreference);
      return () => media.removeEventListener("change", updateSystemPreference);
    }

    media.addListener(updateSystemPreference);
    return () => media.removeListener(updateSystemPreference);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const resolvedTheme =
      themeMode === "system"
        ? systemPrefersDark
          ? "dark"
          : "light"
        : themeMode;

    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    window.localStorage.setItem("sudoku-theme-mode", themeMode);
  }, [themeMode, systemPrefersDark]);

  useEffect(() => {
    if (!room || room.phase !== "finished") {
      return;
    }

    if (lastFinishedRoomRef.current === room.roomCode) {
      return;
    }

    lastFinishedRoomRef.current = room.roomCode;

    const outcome = room.players[deviceId]?.outcome;
    const score = room.players[deviceId]?.score ?? 0;

    // Show modal for this player's outcome
    if (outcome === "won" || outcome === "lost") {
      setFinishModal({
        visible: true,
        outcome,
        score,
      });
    }

    if (outcome === "won") {
      pushToast("You won this round.", "success");
      playSound("win");
    } else if (outcome === "lost") {
      pushToast("You lost this round.", "danger");
      playSound("loss");
    } else {
      pushToast("Round finished.", "neutral");
    }
  }, [deviceId, room]);

  useEffect(() => {
    // play sounds when the player's score changes (per-move or on win)
    const prev = prevScoreRef.current ?? stats?.totalScore ?? 0;
    const current = room
      ? (room.players[deviceId]?.score ?? 0)
      : (stats?.totalScore ?? 0);
    const delta = current - prev;
    if (delta !== 0) {
      if (delta > 0) {
        playSound("correct");
      } else {
        playSound("wrong");
      }
    }
    prevScoreRef.current = current;
  }, [room, stats, deviceId]);

  useEffect(() => {
    if (!socketRef.current) {
      socketRef.current = createGameSocket();
    }

    const socket = socketRef.current;

    const handleRoomUpdated = (nextRoom: RoomState) => {
      // remove notes affected by newly placed numbers
      const prev = prevRoomRef.current;
      if (prev) {
        for (let i = 0; i < 81; i++) {
          const before = prev.board[i];
          const after = nextRoom.board[i];
          if (
            (before === null || before === undefined) &&
            typeof after === "number"
          ) {
            const placed = after;
            setNotes((prevNotes) => {
              const copy: Record<number, number[]> = {};
              for (const k of Object.keys(prevNotes)) {
                const idx = Number(k);
                copy[idx] = [...(prevNotes[idx] ?? [])];
              }

              const row = Math.floor(i / 9);
              const col = i % 9;
              for (let r = 0; r < 9; r++) {
                const idx = row * 9 + r;
                copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
              }
              for (let r = 0; r < 9; r++) {
                const idx = r * 9 + col;
                copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
              }
              const boxRow = Math.floor(row / 3) * 3;
              const boxCol = Math.floor(col / 3) * 3;
              for (let rr = 0; rr < 3; rr++) {
                for (let cc = 0; cc < 3; cc++) {
                  const idx = (boxRow + rr) * 9 + (boxCol + cc);
                  copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
                }
              }

              // ensure no empty arrays are kept
              for (const k of Object.keys(copy)) {
                const idx = Number(k);
                if (!copy[idx] || copy[idx].length === 0) {
                  delete copy[idx];
                }
              }

              return copy;
            });
          }
        }
      }

      const previousRoom = prevRoomRef.current;

      // detect outcome change for local player
      const prevOutcome = previousRoom?.players?.[deviceId]?.outcome ?? null;
      const nextOutcome = nextRoom.players?.[deviceId]?.outcome ?? null;

      if (prevOutcome === "active" && nextOutcome && nextOutcome !== "active") {
        setFinishModal({
          visible: true,
          outcome: nextOutcome,
          score: nextRoom.players[deviceId]?.score ?? 0,
        });
      }

      // notify when other players finish (toast)
      if (previousRoom) {
        for (const [id, player] of Object.entries(nextRoom.players)) {
          const prevPlayer = previousRoom.players[id];
          if (!prevPlayer) continue;
          if (
            prevPlayer.outcome === "active" &&
            player.outcome !== "active" &&
            id !== deviceId
          ) {
            const message =
              player.outcome === "won"
                ? `${player.displayName} solved the board!`
                : `${player.displayName} was eliminated.`;
            pushToast(message, player.outcome === "won" ? "success" : "danger");
          }
        }

        // notify when players leave
        for (const [id, prevPlayer] of Object.entries(previousRoom.players)) {
          const nextPlayer = nextRoom.players[id];
          if (!nextPlayer && id !== deviceId) {
            pushToast(`${prevPlayer.displayName} left the game.`, "neutral");
          }
        }
      }

      prevRoomRef.current = nextRoom;
      setRoom(mergeRoomState(nextRoom));
      if (nextRoom.phase === "finished") {
        void syncStats();
      }
    };

    const handleRoomEnded = (nextRoom: RoomState) => {
      setRoom(nextRoom);
      void syncStats();
    };

    const handleStatsUpdated = (nextStats: DeviceStats) => {
      setStats(nextStats);
    };

    const handleRoomError = (message: string) => {
      setStatusMessage(message);
    };

    const handleVoiceSignalEvent = (payload: VoiceSignalPayload) => {
      void handleVoiceSignal(payload);
    };

    const handleConnect = () => {
      setSocketReady(true);
    };

    socket.on("room:updated", handleRoomUpdated);
    socket.on("room:ended", handleRoomEnded);
    socket.on("stats:updated", handleStatsUpdated);
    socket.on("room:error", handleRoomError);
    socket.on("voice:signal", handleVoiceSignalEvent);
    socket.on("connect", handleConnect);
    socket.connect();

    return () => {
      socket.off("room:updated", handleRoomUpdated);
      socket.off("room:ended", handleRoomEnded);
      socket.off("stats:updated", handleStatsUpdated);
      socket.off("room:error", handleRoomError);
      socket.off("voice:signal", handleVoiceSignalEvent);
      socket.off("connect", handleConnect);
      socket.disconnect();
    };
  }, [deviceId, displayNameDraft]);

  useEffect(() => {
    if (!socketReady || room || autoJoinAttempted.current || !roomCodeDraft) {
      return;
    }

    autoJoinAttempted.current = true;

    if (initialRoomAction.current === "reconnect") {
      void reconnectToRoom(roomCodeDraft);
      return;
    }

    void joinExistingRoom(roomCodeDraft);
  }, [room, roomCodeDraft, socketReady]);

  useEffect(() => {
    if (!room) {
      setSelectedIndex(null);
      return;
    }

    const currentPlayer = room.players[deviceId];
    const canInteract =
      room.phase === "active" && currentPlayer?.outcome === "active";

    if (!canInteract) {
      setSelectedIndex(null);
      return;
    }

    if (selectedIndex === null) {
      setSelectedIndex(firstEditableCell(room));
    }
  }, [deviceId, room, selectedIndex]);

  useEffect(() => {
    if (!room) {
      setNotes({});
      return;
    }

    setNotes((current) => pruneNotesForRoom(current, room));
  }, [room]);

  useEffect(() => {
    const nextTargetIds = getVoiceTargetIds(room, deviceId);
    const previousTargetIds = voiceTargetIdsRef.current;
    voiceTargetIdsRef.current = nextTargetIds;

    const removedTargets = previousTargetIds.filter(
      (targetId) => !nextTargetIds.includes(targetId),
    );
    const addedTargets = nextTargetIds.filter(
      (targetId) => !previousTargetIds.includes(targetId),
    );

    for (const targetId of removedTargets) {
      void cleanupVoicePeer(targetId);
    }

    if (voiceStatus !== "active" && voiceStatus !== "starting") {
      return;
    }

    if (!room || room.mode !== "battle") {
      return;
    }

    for (const targetId of addedTargets) {
      void attachLocalAudio(targetId)
        .then(() => {
          if (!voicePeersRef.current[targetId]) {
            return;
          }

          if (voiceLocalStreamRef.current) {
            void createVoiceOffer(targetId);
          }
        })
        .catch((error) => {
          setVoiceError(
            error instanceof Error ? error.message : "Voice chat failed.",
          );
          setVoiceStatus("error");
        });
    }
  }, [deviceId, room, voiceStatus]);

  useEffect(() => {
    const currentPlayer = room?.players[deviceId];
    const canInteract =
      room?.phase === "active" && currentPlayer?.outcome === "active";

    if (!room || !canInteract) {
      return;
    }

    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      ) {
        return;
      }

      if (room.phase !== "active" || !canInteract) {
        return;
      }

      if (event.key === "Escape") {
        setSelectedIndex(null);
        return;
      }

      if (selectedIndex === null) {
        return;
      }

      const row = Math.floor(selectedIndex / 9);

      if (event.key === "ArrowUp") {
        setSelectedIndex(Math.max(0, selectedIndex - 9));
        return;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex(Math.min(80, selectedIndex + 9));
        return;
      }

      if (event.key === "ArrowLeft") {
        setSelectedIndex(Math.max(row * 9, selectedIndex - 1));
        return;
      }

      if (event.key === "ArrowRight") {
        setSelectedIndex(Math.min(row * 9 + 8, selectedIndex + 1));
        return;
      }

      if (
        event.key === "Backspace" ||
        event.key === "Delete" ||
        event.key === "0"
      ) {
        void submitValue(null);
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        void submitValue(Number(event.key));
      }
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [deviceId, noteMode, room, selectedIndex]);

  useEffect(() => {
    void syncStats();
  }, [deviceId, displayNameDraft]);

  async function syncStats() {
    try {
      const updatedStats = await fetchDeviceStats(deviceId, displayNameDraft);
      setStats(updatedStats);
    } catch {
      // ignore transient API failures; the socket callbacks will retry on the next action
    }
  }

  function pushToast(
    message: string,
    tone: ToastTone = "neutral",
    autoDismiss = false,
    dismissTimeMs = 2600,
  ) {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current, { id, message, tone }]);
    if (autoDismiss) {
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, dismissTimeMs);
    }
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function playSound(
    kind: "tap" | "correct" | "wrong" | "win" | "loss" | "clear" | "undo",
  ) {
    if (typeof window === "undefined") {
      return;
    }

    const AudioCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor) {
      return;
    }

    const context = audioContextRef.current ?? new AudioCtor();
    audioContextRef.current = context;

    if (context.state === "suspended") {
      void context.resume();
    }

    const startAt = context.currentTime + 0.01;
    const gain = context.createGain();
    gain.gain.value = 0.0001;
    gain.connect(context.destination);

    const scheduleTone = (
      frequency: number,
      start: number,
      duration: number,
      volume: number,
      type: OscillatorType = "sine",
    ) => {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    };

    switch (kind) {
      case "correct":
        scheduleTone(660, startAt, 0.12, 0.08);
        scheduleTone(990, startAt + 0.06, 0.12, 0.07);
        break;
      case "wrong":
        scheduleTone(180, startAt, 0.12, 0.1, "square");
        scheduleTone(140, startAt + 0.1, 0.16, 0.08, "square");
        break;
      case "win":
        scheduleTone(523.25, startAt, 0.12, 0.08);
        scheduleTone(659.25, startAt + 0.12, 0.12, 0.08);
        scheduleTone(783.99, startAt + 0.24, 0.18, 0.08);
        break;
      case "loss":
        scheduleTone(392, startAt, 0.16, 0.08);
        scheduleTone(311.13, startAt + 0.16, 0.18, 0.08);
        break;
      case "clear":
        scheduleTone(440, startAt, 0.07, 0.05);
        break;
      case "undo":
        scheduleTone(554.37, startAt, 0.08, 0.05);
        break;
      default:
        scheduleTone(830, startAt, 0.05, 0.04);
        break;
    }
  }

  function updateRoomLocation(roomCode: string) {
    if (typeof window === "undefined") {
      return;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("room", roomCode);
    window.history.replaceState(
      {},
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
  }

  function handleDisplayNameChange(value: string) {
    const trimmed = value.slice(0, 24);
    setDisplayNameDraft(trimmed);
    setDisplayName(trimmed || "Player");
  }

  function handleRoomCodeChange(value: string) {
    setRoomCodeDraft(normalizeRoomCode(value));
  }

  function emitWithAck<TResponse>(eventName: AckEventName, payload: unknown) {
    const socket = socketRef.current;
    if (!socket) {
      return Promise.reject(new Error("Socket is not ready yet."));
    }

    return new Promise<TResponse>((resolve, reject) => {
      (socket as GameSocket & { emit: (...args: unknown[]) => void }).emit(
        eventName,
        payload,
        (response: TResponse | { error: string }) => {
          if (response && typeof response === "object" && "error" in response) {
            reject(new Error(response.error));
            return;
          }

          resolve(response as TResponse);
        },
      );
    });
  }

  async function emitVoiceSignal(payload: VoiceSignalPayload) {
    return emitWithAck<{ ok: true }>("voice:signal", payload);
  }

  function getVoicePeer(targetDeviceId: string) {
    const existing = voicePeersRef.current[targetDeviceId];

    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection();
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    const peerState: VoicePeerState = {
      pc,
      audioSender: transceiver.sender,
      remoteStream: null,
      pendingCandidates: [],
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      peerState.remoteStream = remoteStream;
      setVoiceStreams((current) => ({
        ...current,
        [targetDeviceId]: remoteStream,
      }));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        void cleanupVoicePeer(targetDeviceId);
      }
    };

    pc.onicecandidate = (event) => {
      if (!room || !event.candidate) {
        return;
      }

      void emitVoiceSignal({
        roomCode: room.roomCode,
        fromDeviceId: deviceId,
        toDeviceId: targetDeviceId,
        kind: "candidate",
        candidate: event.candidate.toJSON() as VoiceCandidatePayload,
      }).catch((error) => {
        setVoiceError(
          error instanceof Error ? error.message : "Voice signal failed.",
        );
      });
    };

    voicePeersRef.current[targetDeviceId] = peerState;
    return peerState;
  }

  async function attachLocalAudio(targetDeviceId: string) {
    const peer = getVoicePeer(targetDeviceId);
    const localStream = voiceLocalStreamRef.current;

    if (!localStream) {
      return;
    }

    const track = localStream.getAudioTracks()[0];
    if (!track) {
      return;
    }

    if (peer.audioSender) {
      await peer.audioSender.replaceTrack(track);
    } else {
      peer.audioSender = peer.pc.addTrack(track, localStream);
    }
  }

  async function createVoiceOffer(targetDeviceId: string) {
    const peer = getVoicePeer(targetDeviceId);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);

    await emitVoiceSignal({
      roomCode: room?.roomCode ?? "",
      fromDeviceId: deviceId,
      toDeviceId: targetDeviceId,
      kind: "offer",
      sdp: offer.sdp ?? "",
    });
  }

  async function cleanupVoicePeer(targetDeviceId: string) {
    const peer = voicePeersRef.current[targetDeviceId];

    if (!peer) {
      return;
    }

    try {
      peer.pc.close();
    } catch {
      // ignore close failures
    }

    delete voicePeersRef.current[targetDeviceId];
    setVoiceStreams((current) => {
      const copy = { ...current };
      delete copy[targetDeviceId];
      return copy;
    });
  }

  async function stopVoiceChat() {
    const targetIds = Object.keys(voicePeersRef.current);

    if (room) {
      await Promise.all(
        targetIds.map((targetDeviceId) =>
          emitVoiceSignal({
            roomCode: room.roomCode,
            fromDeviceId: deviceId,
            toDeviceId: targetDeviceId,
            kind: "hangup",
          }).catch(() => undefined),
        ),
      );
    }

    for (const targetDeviceId of targetIds) {
      await cleanupVoicePeer(targetDeviceId);
    }

    voiceTargetIdsRef.current = [];

    const localStream = voiceLocalStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      voiceLocalStreamRef.current = null;
    }

    setVoiceStatus("idle");
  }

  async function ensureVoiceChat() {
    if (!room || room.mode !== "battle") {
      return;
    }

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      setVoiceError("Voice chat is not supported in this browser.");
      setVoiceStatus("error");
      return;
    }

    setVoiceStatus("starting");
    setVoiceError(null);

    try {
      if (!voiceLocalStreamRef.current) {
        voiceLocalStreamRef.current = await navigator.mediaDevices.getUserMedia(
          {
            audio: true,
            video: false,
          },
        );
      }

      const targetIds = getVoiceTargetIds(room, deviceId);
      for (const targetDeviceId of targetIds) {
        await attachLocalAudio(targetDeviceId);
        await createVoiceOffer(targetDeviceId);
      }

      setVoiceStatus("active");
    } catch (error) {
      await stopVoiceChat();
      setVoiceError(
        error instanceof Error ? error.message : "Unable to start voice chat.",
      );
      setVoiceStatus("error");
    }
  }

  async function toggleVoiceChat() {
    if (voiceStatus === "active" || voiceStatus === "starting") {
      await stopVoiceChat();
      return;
    }

    await ensureVoiceChat();
  }

  async function handleVoiceSignal(payload: VoiceSignalPayload) {
    if (!room || payload.roomCode !== room.roomCode) {
      return;
    }

    if (payload.toDeviceId !== deviceId) {
      return;
    }

    const peer = getVoicePeer(payload.fromDeviceId);

    if (payload.kind === "hangup") {
      await cleanupVoicePeer(payload.fromDeviceId);
      return;
    }

    if (payload.kind === "candidate") {
      const candidate = payload.candidate;
      if (!candidate) {
        return;
      }

      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(candidate);
      } else {
        peer.pendingCandidates.push(candidate);
      }
      return;
    }

    if (!payload.sdp) {
      return;
    }

    if (payload.kind === "offer") {
      await peer.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });

      while (peer.pendingCandidates.length > 0) {
        const candidate = peer.pendingCandidates.shift();
        if (candidate) {
          await peer.pc.addIceCandidate(candidate);
        }
      }

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);

      await emitVoiceSignal({
        roomCode: room.roomCode,
        fromDeviceId: deviceId,
        toDeviceId: payload.fromDeviceId,
        kind: "answer",
        sdp: answer.sdp ?? "",
      });
      return;
    }

    await peer.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });

    while (peer.pendingCandidates.length > 0) {
      const candidate = peer.pendingCandidates.shift();
      if (candidate) {
        await peer.pc.addIceCandidate(candidate);
      }
    }
  }

  async function createRoom() {
    if (isBusy) {
      return;
    }

    setIsBusy(true);
    setStatusMessage("Creating room...");
    setDisplayName(displayNameDraft || "Player");
    setActiveRoomCode("");

    try {
      const payload: any = {
        deviceId,
        displayName: displayNameDraft || "Player",
        difficulty,
        mode: roomMode,
      };

      if (createTimerOption === "none") {
        payload.timerSeconds = null;
      } else if (createTimerOption === "custom") {
        payload.timerSeconds = Math.max(0, Math.floor(createTimerSeconds));
      }

      const result = await emitWithAck<{ room: RoomState; stats: DeviceStats }>(
        "room:create",
        payload,
      );

      setRoom(result.room);
      setStats(result.stats);
      setSelectedIndex(
        result.room.phase === "active" ? firstEditableCell(result.room) : null,
      );
      setStatusMessage(
        result.room.phase === "active"
          ? `Room ${result.room.roomCode} is ready. Share the code or link.`
          : `Battle room ${result.room.roomCode} is waiting for players to ready up.`,
      );
      setActiveRoomCode(result.room.roomCode);
      updateRoomLocation(result.room.roomCode);
      initialRoomAction.current = null;
      autoJoinAttempted.current = true;
      setGameMenuOpen(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Unable to create a room.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function joinExistingRoom(roomCode = roomCodeDraft) {
    if (isBusy) {
      return;
    }

    const normalizedCode = normalizeRoomCode(roomCode);
    if (!normalizedCode) {
      setStatusMessage("Enter a room code first.");
      return;
    }

    setIsBusy(true);
    setStatusMessage(`Joining room ${normalizedCode}...`);
    setDisplayName(displayNameDraft || "Player");

    try {
      const result = await emitWithAck<{ room: RoomState; stats: DeviceStats }>(
        "room:join",
        {
          roomCode: normalizedCode,
          deviceId,
          displayName: displayNameDraft || "Player",
        },
      );

      setRoom(result.room);
      setStats(result.stats);
      setSelectedIndex(
        result.room.phase === "active" ? firstEditableCell(result.room) : null,
      );
      setStatusMessage(
        result.room.phase === "active"
          ? `Joined room ${result.room.roomCode}.`
          : `Joined battle room ${result.room.roomCode}. Ready up when you are set.`,
      );
      setActiveRoomCode(result.room.roomCode);
      updateRoomLocation(result.room.roomCode);
      initialRoomAction.current = null;
      autoJoinAttempted.current = true;
      setGameMenuOpen(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Unable to join the room.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function reconnectToRoom(roomCode = roomCodeDraft) {
    if (isBusy) {
      return;
    }

    const normalizedCode = normalizeRoomCode(roomCode);
    if (!normalizedCode) {
      return;
    }

    setIsBusy(true);
    setStatusMessage(`Restoring room ${normalizedCode}...`);

    try {
      const result = await emitWithAck<{ room: RoomState; stats: DeviceStats }>(
        "room:reconnect",
        {
          roomCode: normalizedCode,
          deviceId,
          displayName: displayNameDraft || "Player",
        },
      );

      setRoom(result.room);
      setStats(result.stats);
      setSelectedIndex(
        result.room.phase === "active" ? firstEditableCell(result.room) : null,
      );
      setStatusMessage(`Back in room ${result.room.roomCode}.`);
      setActiveRoomCode(result.room.roomCode);
      updateRoomLocation(result.room.roomCode);
      initialRoomAction.current = null;
      autoJoinAttempted.current = true;
      setGameMenuOpen(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Unable to restore the room.",
      );
      clearActiveRoomCode();
    } finally {
      setIsBusy(false);
    }
  }

  async function submitValue(value: CellValue, targetIndex = selectedIndex) {
    const currentPlayer = room?.players[deviceId];
    const canInteract =
      room?.phase === "active" && currentPlayer?.outcome === "active";

    if (!room || !canInteract || targetIndex === null || isBusy) {
      return;
    }

    if (noteMode && value !== null) {
      if (finishedDigits.has(value)) {
        setStatusMessage("That number is already finished.");
        return;
      }

      // toggle note locally
      setNotes((prevNotes) => {
        const copy: Record<number, number[]> = { ...prevNotes };
        const arr = new Set(copy[targetIndex] ?? []);
        if (arr.has(value)) {
          arr.delete(value);
        } else {
          arr.add(value);
        }
        const list = Array.from(arr).sort((a, b) => a - b);
        if (list.length > 0) {
          copy[targetIndex] = list;
        } else {
          delete copy[targetIndex];
        }
        return copy;
      });
      if (!isReplayingUndoRef.current) {
        undoHistoryRef.current.push({
          kind: "note-toggle",
          index: targetIndex,
          digit: value,
        });
      }
      playSound("tap");
      return;
    }

    if (value === null && noteMode) {
      const selectedNotes = notes[targetIndex] ?? [];
      const currentBoardValue = room.board[targetIndex];
      if (currentBoardValue === null && selectedNotes.length > 0) {
        const previousDigits = [...selectedNotes].sort((a, b) => a - b);
        setNotes((prevNotes) => {
          const copy = { ...prevNotes };
          delete copy[targetIndex];
          return copy;
        });
        if (!isReplayingUndoRef.current) {
          undoHistoryRef.current.push({
            kind: "note-clear",
            index: targetIndex,
            digits: previousDigits,
          });
        }
        setStatusMessage("Notes cleared.");
        playSound("clear");
        return;
      }
    }

    const row = Math.floor(targetIndex / 9);
    const col = targetIndex % 9;
    const previousBoardValue = room.board[targetIndex];
    setIsBusy(true);

    const clearWrongMoveTimer = () => {
      if (wrongMoveTimerRef.current !== null) {
        window.clearTimeout(wrongMoveTimerRef.current);
        wrongMoveTimerRef.current = null;
      }
    };

    const showWrongMove = (index: number, attemptedValue: number) => {
      clearWrongMoveTimer();
      setWrongMove({ index, value: attemptedValue });
      wrongMoveTimerRef.current = window.setTimeout(() => {
        setWrongMove(null);
        wrongMoveTimerRef.current = null;
      }, 1400);
    };

    try {
      const result = await emitWithAck<{
        room: RoomState;
        stats: DeviceStats;
        moveOutcome?: {
          type: "cleared" | "same" | "correct" | "wrong";
          index: number;
          value: CellValue;
        };
      }>("cell:submit", {
        roomCode: room.roomCode,
        deviceId,
        displayName: displayNameDraft || "Player",
        row,
        col,
        value,
      });

      if (result.moveOutcome?.type === "wrong" && value !== null) {
        showWrongMove(result.moveOutcome.index, value);
        playSound("wrong");
      } else if (result.moveOutcome?.type !== "wrong") {
        clearWrongMoveTimer();
        setWrongMove(null);
      }

      // apply note removals for newly placed values
      const prev = prevRoomRef.current;
      if (prev) {
        for (let i = 0; i < 81; i++) {
          const before = prev.board[i];
          const after = result.room.board[i];
          if (
            (before === null || before === undefined) &&
            typeof after === "number"
          ) {
            const placed = after;
            setNotes((prevNotes) => {
              const copy: Record<number, number[]> = {};
              for (const k of Object.keys(prevNotes)) {
                const idx = Number(k);
                copy[idx] = [...(prevNotes[idx] ?? [])];
              }

              const row0 = Math.floor(i / 9);
              const col0 = i % 9;
              for (let r = 0; r < 9; r++) {
                const idx = row0 * 9 + r;
                copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
              }
              for (let r = 0; r < 9; r++) {
                const idx = r * 9 + col0;
                copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
              }
              const boxRow = Math.floor(row0 / 3) * 3;
              const boxCol = Math.floor(col0 / 3) * 3;
              for (let rr = 0; rr < 3; rr++) {
                for (let cc = 0; cc < 3; cc++) {
                  const idx = (boxRow + rr) * 9 + (boxCol + cc);
                  copy[idx] = (copy[idx] ?? []).filter((v) => v !== placed);
                }
              }

              for (const k of Object.keys(copy)) {
                const idx = Number(k);
                if (!copy[idx] || copy[idx].length === 0) {
                  delete copy[idx];
                }
              }

              return copy;
            });
          }
        }
      }

      prevRoomRef.current = result.room;
      setRoom(result.room);
      setStats(result.stats);

      if (value !== null && result.moveOutcome?.type === "correct") {
        playSound("correct");
      } else if (value === null) {
        if (result.moveOutcome?.type === "cleared") {
          playSound("clear");
        }
      }

      if (result.moveOutcome?.type === "cleared" && value === null) {
        setNotes((prevNotes) => {
          const copy = { ...prevNotes };
          delete copy[targetIndex];
          return copy;
        });
      }

      if (
        !isReplayingUndoRef.current &&
        result.room.board[targetIndex] !== previousBoardValue
      ) {
        undoHistoryRef.current.push({
          kind: "value",
          index: targetIndex,
          previousValue: previousBoardValue,
        });
      }

      if (result.room.phase === "finished") {
        setStatusMessage(
          result.room.finishReason === "solved"
            ? `Solved by ${result.room.players[result.room.winnerDeviceId ?? ""]?.displayName ?? "a player"}.`
            : result.room.finishReason === "timeout"
              ? "The timer expired."
              : "Everybody lost their three chances.",
        );
        clearActiveRoomCode();
      } else if (value === null) {
        setStatusMessage("Cell cleared.");
      } else if (result.moveOutcome?.type === "wrong") {
        setStatusMessage("Wrong number.");
      } else if (result.room.board[targetIndex] === value) {
        setStatusMessage("Number locked in.");
      } else if (previousBoardValue === result.room.board[targetIndex]) {
        setStatusMessage("Mistake recorded.");
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Unable to update the board.",
      );
    } finally {
      setIsBusy(false);
    }
  }

  function toggleInputMode(mode: "notes" | "values") {
    setNoteMode(mode === "notes");
  }

  async function undoLastAction() {
    const currentPlayer = room?.players[deviceId];
    const canInteract =
      room?.phase === "active" && currentPlayer?.outcome === "active";
    const lastAction = undoHistoryRef.current.pop();

    if (!lastAction || !room || !canInteract) {
      return;
    }

    isReplayingUndoRef.current = true;

    try {
      if (lastAction.kind === "note-toggle") {
        setNotes((prevNotes) => {
          const copy: Record<number, number[]> = { ...prevNotes };
          const current = new Set(copy[lastAction.index] ?? []);
          if (current.has(lastAction.digit)) {
            current.delete(lastAction.digit);
          } else {
            current.add(lastAction.digit);
          }
          const next = Array.from(current).sort((a, b) => a - b);
          if (next.length > 0) {
            copy[lastAction.index] = next;
          } else {
            delete copy[lastAction.index];
          }
          return copy;
        });
        playSound("undo");
        return;
      }

      if (lastAction.kind === "note-clear") {
        setNotes((prevNotes) => {
          const copy = { ...prevNotes };
          copy[lastAction.index] = [...lastAction.digits];
          return copy;
        });
        playSound("undo");
        return;
      }

      if (lastAction.kind === "value") {
        setSelectedIndex(lastAction.index);
        await submitValue(lastAction.previousValue, lastAction.index);
        playSound("undo");
      }
    } finally {
      isReplayingUndoRef.current = false;
    }
  }

  async function leaveRoom() {
    if (!room) {
      return;
    }

    await stopVoiceChat();

    socketRef.current?.emit("game:leave", {
      roomCode: room.roomCode,
      deviceId,
    });

    setRoom(null);
    setSelectedIndex(null);
    setWrongMove(null);
    setGameMenuOpen(false);
    if (wrongMoveTimerRef.current !== null) {
      window.clearTimeout(wrongMoveTimerRef.current);
      wrongMoveTimerRef.current = null;
    }
    clearActiveRoomCode();
    setStatusMessage(
      "Left the room. You can create a new one or join another game.",
    );
    await syncStats();
  }

  async function copyRoomLink() {
    if (!room) {
      return;
    }

    const url = buildRoomInviteUrl(room.roomCode);
    await window.navigator.clipboard.writeText(url);
    setStatusMessage("Room link copied.");
  }

  async function shareRoomLink() {
    if (!room) {
      return;
    }

    const url = buildRoomInviteUrl(room.roomCode);

    if (window.navigator.share) {
      await window.navigator.share({
        title: "Sudoku Remote room",
        text: `Join my Sudoku room ${room.roomCode}`,
        url,
      });
      setStatusMessage("Share sheet opened.");
      return;
    }

    await copyRoomLink();
  }

  async function toggleReady() {
    if (!room) {
      return;
    }

    const player = room.players[deviceId];
    if (!player || player.outcome !== "active" || room.phase === "finished") {
      return;
    }

    const nextReady = !player.ready;
    setStatusMessage(
      nextReady ? "Ready set. Waiting for the countdown." : "Ready removed.",
    );

    try {
      const result = await emitWithAck<{ room: RoomState }>("room:ready", {
        roomCode: room.roomCode,
        deviceId,
        ready: nextReady,
      });

      setRoom(result.room);
      prevRoomRef.current = result.room;
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Unable to update ready state.",
      );
    }
  }

  const NO_TIMER_THRESHOLD = Date.now() + 1000 * 60 * 60 * 24 * 365 * 5; // 5 years
  const isNoTimer = room ? room.expiresAt > NO_TIMER_THRESHOLD : false;
  const currentPlayer = room ? room.players[deviceId] : null;
  const canInteract =
    room?.phase === "active" && currentPlayer?.outcome === "active";
  const isBattleLobby = room?.mode === "battle" && room.phase === "lobby";
  const countdownRemaining =
    isBattleLobby && room.countdownEndsAt
      ? Math.max(0, Math.ceil((room.countdownEndsAt - now) / 1000))
      : null;
  const roomTimer = room
    ? isBattleLobby
      ? (countdownRemaining ?? 0)
      : isNoTimer
        ? Math.max(0, Math.ceil((now - room.startedAt) / 1000))
        : Math.max(0, Math.ceil((room.expiresAt - now) / 1000))
    : 0;
  const mistakesLeft = currentPlayer
    ? Math.max(0, 3 - currentPlayer.mistakes)
    : 3;
  const currentScore = currentPlayer?.score ?? 0;
  const finishedDigits = room
    ? getFinishedDigits(room.board)
    : new Set<number>();
  const activeWinners = room
    ? Object.values(room.players).filter((player) => player.outcome === "won")
    : [];
  const inviteUrl = room ? buildRoomInviteUrl(room.roomCode) : "";
  const statusTone =
    room?.phase === "finished"
      ? room.finishReason === "solved"
        ? "from-emerald-500/20 to-emerald-500/5"
        : "from-rose-500/20 to-rose-500/5"
      : "from-sky-500/20 to-cyan-500/5";

  const completionText =
    room?.phase === "finished"
      ? room.finishReason === "solved"
        ? `Solved by ${activeWinners[0]?.displayName ?? "a player"}`
        : room.finishReason === "timeout"
          ? "Time ran out"
          : "Everyone ran out of mistakes"
      : "Live match";

  const battleStateText = room
    ? room.phase === "lobby"
      ? room.countdownEndsAt
        ? `Match starts in ${Math.max(0, Math.ceil((room.countdownEndsAt - now) / 1000))}s`
        : room.mode === "battle"
          ? "Waiting for both players to ready up"
          : "Preparing the board"
      : canInteract
        ? "Your turn"
        : currentPlayer?.outcome === "won"
          ? "You won. Watching the room now."
          : currentPlayer?.outcome === "lost"
            ? "You are out. Watching the room now."
            : "Board locked"
    : "No room loaded";

  return (
    <div className="relative min-h-screen overflow-hidden px-2 py-3 text-slate-100 sm:px-6 sm:py-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_32%),radial-gradient(circle_at_top_right,_rgba(244,114,182,0.16),_transparent_24%),radial-gradient(circle_at_bottom,_rgba(34,197,94,0.1),_transparent_22%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:56px_56px]" />

      {finishModal.visible ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() =>
              setFinishModal({ visible: false, outcome: null, score: 0 })
            }
          />
          <div className="relative z-10 w-[min(32rem,90vw)] rounded-2xl bg-slate-900/95 p-6 shadow-2xl">
            <h3 className="text-xl font-semibold text-white">
              {finishModal.outcome === "won"
                ? "You finished!"
                : "You were eliminated"}
            </h3>
            <p className="mt-3 text-sm text-slate-300">
              Score: {finishModal.score}
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setFinishModal({ visible: false, outcome: null, score: 0 });
                  void leaveRoom();
                }}
                className="ml-auto rounded-2xl bg-rose-600/10 px-4 py-2 text-rose-200"
              >
                Exit room
              </button>
              <button
                onClick={() => {
                  setFinishModal({ visible: false, outcome: null, score: 0 });
                }}
                className="rounded-2xl bg-white/5 px-4 py-2 text-white"
              >
                Spectate opponent
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3">
        {toasts.map((toast) => {
          const toneClass =
            toast.tone === "success"
              ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-50"
              : toast.tone === "danger"
                ? "border-rose-400/30 bg-rose-500/15 text-rose-50"
                : "border-white/15 bg-[var(--board-surface)] text-[var(--app-text)]";

          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 24, y: -8 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x: 24 }}
              className={`pointer-events-auto rounded-2xl border px-4 py-3 shadow-xl backdrop-blur-xl ${toneClass}`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium">{toast.message}</p>
                <button
                  onClick={() => dismissToast(toast.id)}
                  className="ml-2 flex-shrink-0 text-current opacity-70 hover:opacity-100"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-[2rem] border border-white/10 bg-white/5 px-5 py-4 shadow-2xl shadow-slate-950/30 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="font-display text-xs uppercase tracking-[0.4em] text-sky-200/80">
              Sudoku Remote
            </p>
            <h1 className="font-display mt-2 text-2xl font-bold text-white sm:text-3xl">
              Local Wi-Fi multiplayer Sudoku
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-300">
              Create a room, share the link with someone on the same network,
              and race to solve the puzzle before the timer or mistakes run out.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
                Theme
              </span>
              <select
                value={themeMode}
                onChange={(event) =>
                  setThemeMode(event.target.value as ThemeMode)
                }
                className="rounded-full border border-white/10 bg-slate-950/40 px-3 py-1.5 text-sm text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4 lg:min-w-[40rem]">
            <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
              <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-400">
                Session
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {room?.roomCode ?? "Lobby"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
              <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-400">
                Timer
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {room ? formatTime(roomTimer) : "--:--"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
              <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-400">
                Score
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {room ? currentScore : 0}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
              <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-400">
                Mistakes left
              </p>
              <p className="mt-2 text-lg font-semibold text-white">
                {mistakesLeft} / 3
              </p>
            </div>
          </div>
        </header>

        <main className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <section
            className={`rounded-[2rem] border border-white/10 bg-gradient-to-br ${statusTone} p-2 shadow-2xl shadow-slate-950/30 backdrop-blur-xl sm:p-6`}
          >
            {!room ? (
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]"
              >
                <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/50 p-6">
                  <p className="font-display text-sm uppercase tracking-[0.35em] text-sky-200/70">
                    Create
                  </p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">
                    Host a room in one click
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    Pick a difficulty or let the server choose one at random.
                    Everyone on the same Wi-Fi can join with the room code.
                  </p>

                  <div className="mt-6 space-y-4">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.3em] text-slate-400">
                        Nickname
                      </span>
                      <input
                        value={displayNameDraft}
                        onChange={(event) =>
                          handleDisplayNameChange(event.target.value)
                        }
                        maxLength={24}
                        className="w-full rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-white outline-none transition placeholder:text-slate-500 focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                        placeholder="Player"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.3em] text-slate-400">
                        Match type
                      </span>
                      <select
                        value={roomMode}
                        onChange={(event) =>
                          setRoomMode(event.target.value as RoomMode)
                        }
                        className="w-full rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                      >
                        <option value="battle">Battle</option>
                        <option value="solo">Solo</option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.3em] text-slate-400">
                        Difficulty
                      </span>
                      <select
                        value={difficulty}
                        onChange={(event) =>
                          setDifficulty(event.target.value as Difficulty)
                        }
                        className="w-full rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                      >
                        {DIFFICULTIES.map((option) => (
                          <option key={option} value={option}>
                            {difficultyLabels[option]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.3em] text-slate-400">
                        Timer
                      </span>
                      <div className="flex gap-2">
                        <select
                          value={createTimerOption}
                          onChange={(e) =>
                            setCreateTimerOption(e.target.value as any)
                          }
                          className="w-full rounded-2xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                        >
                          <option value="default">
                            Default (by difficulty)
                          </option>
                          <option value="custom">Custom seconds</option>
                          <option value="none">No timer (elapsed)</option>
                        </select>
                        {createTimerOption === "custom" ? (
                          <input
                            type="number"
                            min={10}
                            value={createTimerSeconds}
                            onChange={(e) =>
                              setCreateTimerSeconds(Number(e.target.value))
                            }
                            className="w-28 rounded-2xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none"
                          />
                        ) : null}
                      </div>
                    </label>

                    <p className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                      {roomMode === "battle"
                        ? "Battle rooms wait for the second player, then both press Ready for a synchronized start."
                        : getDifficultyHint(difficulty)}
                    </p>

                    <button
                      type="button"
                      onClick={() => void createRoom()}
                      disabled={isBusy || !displayNameDraft.trim()}
                      className="w-full rounded-2xl bg-gradient-to-r from-sky-400 to-cyan-300 px-4 py-3 font-semibold text-slate-950 shadow-glow transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {roomMode === "battle"
                        ? "Create battle room"
                        : "Create solo room"}
                    </button>
                  </div>
                </div>

                <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/50 p-6">
                  <p className="font-display text-sm uppercase tracking-[0.35em] text-fuchsia-200/70">
                    Join
                  </p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">
                    Enter a room code
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-300">
                    If a friend already created a room, enter the six-character
                    code or paste the shared link.
                  </p>

                  <div className="mt-6 space-y-4">
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase tracking-[0.3em] text-slate-400">
                        Room code
                      </span>
                      <input
                        value={roomCodeDraft}
                        onChange={(event) =>
                          handleRoomCodeChange(event.target.value)
                        }
                        maxLength={6}
                        className="w-full rounded-2xl border border-white/10 bg-slate-900/80 px-4 py-3 text-white uppercase tracking-[0.35em] outline-none transition placeholder:tracking-normal focus:border-fuchsia-400/40 focus:ring-2 focus:ring-fuchsia-400/20"
                        placeholder="ABC123"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => void joinExistingRoom()}
                      disabled={
                        isBusy ||
                        !roomCodeDraft.trim() ||
                        !displayNameDraft.trim()
                      }
                      className="w-full rounded-2xl border border-white/10 bg-white/10 px-4 py-3 font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Join room
                    </button>
                  </div>

                  <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                    <p className="font-semibold text-white">How it works</p>
                    <ul className="mt-3 space-y-2 leading-6">
                      <li>1. One player creates a room.</li>
                      <li>2. The other joins on the same Wi-Fi.</li>
                      <li>3. Three mistakes eliminate a player.</li>
                      <li>4. The first solved board wins the match.</li>
                    </ul>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="grid gap-6"
              >
                <div className="mx-auto w-full max-w-3xl space-y-3 xl:max-w-[44rem]">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-xs uppercase tracking-[0.35em] text-sky-100">
                      {completionText}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.35em] text-slate-300">
                      {room.difficulty.toUpperCase()}
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.35em] text-slate-300">
                      {room.phase === "finished"
                        ? room.finishReason?.replace("-", " ")
                        : room.phase === "lobby"
                          ? "Lobby"
                          : "Active"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
                    <button
                      type="button"
                      onClick={() => void copyRoomLink()}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 transition hover:bg-white/10"
                    >
                      Copy invite link
                    </button>
                    <button
                      type="button"
                      onClick={() => void leaveRoom()}
                      className="ml-auto inline-flex items-center gap-2 rounded-full border border-rose-400 bg-rose-600/10 px-4 py-2 text-rose-200 transition hover:bg-rose-600/20"
                      aria-label="Leave room"
                    >
                      <ExitIcon />
                      Leave
                    </button>
                    {room.mode === "battle" ? (
                      <button
                        type="button"
                        onClick={() => void toggleVoiceChat()}
                        disabled={voiceStatus === "starting"}
                        className={`inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60 ${voiceStatus === "active" ? "bg-emerald-400/15 text-emerald-100" : "bg-white/5 text-slate-200"}`}
                      >
                        {voiceStatus === "active" ? (
                          <MicOffIcon />
                        ) : (
                          <MicIcon />
                        )}
                        {voiceStatus === "active"
                          ? "Stop talking"
                          : voiceStatus === "starting"
                            ? "Connecting..."
                            : "Talk"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setGameMenuOpen((current) => !current)}
                      aria-expanded={gameMenuOpen}
                      aria-label="Toggle game menu"
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 transition hover:bg-white/10"
                    >
                      <MenuIcon />
                      Menu
                    </button>
                    <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
                      Room code: {room.roomCode}
                    </span>
                  </div>

                  {/* Timer and Mistakes above board */}
                  {/* Timer, Mistakes, and Scoreboard above board */}
                  <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
                    <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-2">
                      <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-500">
                        Timer
                      </p>
                      <p className="text-lg font-semibold text-white">
                        {formatTime(roomTimer)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-2">
                      <p className="text-[0.7rem] uppercase tracking-[0.35em] text-slate-500">
                        Mistakes
                      </p>
                      <p className="text-lg font-semibold text-white">
                        {mistakesLeft}/3
                      </p>
                    </div>
                    {/* Scoreboard */}
                    <div className="flex flex-wrap justify-center gap-2">
                      {Object.values(room.players).map((player) => (
                        <div
                          key={player.deviceId}
                          className={`rounded-2xl border px-3 py-2 ${
                            player.deviceId === deviceId
                              ? "border-sky-400 bg-sky-400/15"
                              : "border-white/10 bg-slate-950/50"
                          }`}
                        >
                          <p className="text-[0.65rem] uppercase tracking-[0.3em] text-slate-500 truncate max-w-[8rem]">
                            {player.displayName}
                          </p>
                          <p className="text-base font-semibold text-white">{player.score}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Ready button above board (battle only, lobby phase only) */}
                  {room.mode === "battle" && room.phase === "lobby" ? (
                    <button
                      type="button"
                      onClick={() => void toggleReady()}
                      disabled={currentPlayer?.outcome !== "active"}
                      className={`mx-auto rounded-2xl border border-white/10 px-6 py-3 font-semibold transition ${currentPlayer?.ready ? "bg-emerald-400/20 text-emerald-200" : "bg-sky-400/20 text-sky-100"}`}
                    >
                      {currentPlayer?.ready
                        ? "✓ Ready - waiting for opponent"
                        : "Ready up to start"}
                    </button>
                  ) : null}

                  <Board
                    board={room.board}
                    puzzle={room.puzzle}
                    selectedIndex={selectedIndex}
                    disabled={!canInteract}
                    notes={room?.notes ?? notes}
                    wrongMove={wrongMove}
                    onSelect={(index) => {
                      if (canInteract) {
                        setSelectedIndex(index);
                      }
                    }}
                  />

                  {/* Control buttons and number pad */}
                  <div className="sticky bottom-2 z-30 space-y-3 rounded-[1.75rem] border border-white/10 bg-slate-950/90 p-3 shadow-2xl shadow-slate-950/40 backdrop-blur-xl sm:static sm:bottom-auto sm:z-auto sm:bg-slate-950/40 sm:shadow-none">
                    {/* Control buttons row: Notes, Values, Erase, Undo */}
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-center">
                      <button
                        type="button"
                        onClick={() => toggleInputMode("notes")}
                        className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-xs transition sm:text-sm ${noteMode ? "border-amber-400 bg-amber-400/20 text-amber-200" : "border-white/10 bg-white/5 text-slate-300"}`}
                        title="Notes mode"
                      >
                        <PencilIcon />
                        Notes
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleInputMode("values")}
                        className={`inline-flex items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-xs transition sm:text-sm ${!noteMode ? "border-sky-400 bg-sky-400/20 text-sky-100" : "border-white/10 bg-white/5 text-slate-300"}`}
                        title="Values mode"
                      >
                        <DigitIcon />
                        Values
                      </button>
                      <button
                        type="button"
                        onClick={() => void submitValue(null)}
                        disabled={!canInteract}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                        title="Erase"
                      >
                        <EraserIcon />
                        Erase
                      </button>
                      <button
                        type="button"
                        onClick={() => void undoLastAction()}
                        disabled={!canInteract || undoHistoryRef.current.length === 0}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                        title="Undo"
                      >
                        <UndoIcon />
                        Undo
                      </button>
                    </div>

                    {/* Number pad grid */}
                    <div className="grid grid-cols-5 gap-2 rounded-[1.5rem] border border-white/10 bg-white/5 p-2 sm:bg-slate-950/40 sm:p-3">
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => void submitValue(value)}
                          disabled={!canInteract || finishedDigits.has(value)}
                          className="rounded-2xl border border-white/10 bg-slate-950/40 px-0 py-2.5 text-base font-semibold text-white transition hover:-translate-y-0.5 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-50 sm:py-3 sm:text-lg"
                        >
                          {value}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => void submitValue(null)}
                        disabled={!canInteract}
                        className="flex h-11 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/40 text-slate-300 transition hover:-translate-y-0.5 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:h-12"
                        aria-label="Erase (quick)"
                        title="Erase"
                      >
                        <EraserIcon />
                      </button>
                    </div>

                    {/* Status bar */}
                    <div className="flex min-w-[11rem] items-center justify-between gap-3 rounded-[1.5rem] border border-white/10 bg-slate-950/40 px-4 py-3 text-sm text-slate-300 sm:flex-col sm:items-start sm:justify-center">
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          Selected
                        </p>
                        <p className="mt-1 text-white">
                          {selectedIndex === null
                            ? "None"
                            : `R${Math.floor(selectedIndex / 9) + 1} / C${(selectedIndex % 9) + 1}`}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          Action
                        </p>
                        <p className="mt-1 text-white">{battleStateText}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {gameMenuOpen ? (
                  <button
                    type="button"
                    aria-label="Close game menu"
                    onClick={() => setGameMenuOpen(false)}
                    className="fixed inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px]"
                  />
                ) : null}

                <aside
                  className={`fixed right-4 top-24 z-50 w-[min(24rem,calc(100vw-2rem))] space-y-4 rounded-[1.5rem] border border-white/10 bg-slate-950/95 p-4 shadow-2xl shadow-slate-950/40 backdrop-blur-xl transition duration-200 ${gameMenuOpen ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0"}`}
                >
                  <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/40 p-4">
                    <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                      Room status
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          Timer
                        </p>
                        <p className="mt-2 text-2xl font-semibold text-white">
                          {formatTime(roomTimer)}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          Mistakes left
                        </p>
                        <p className="mt-2 text-2xl font-semibold text-white">
                          {mistakesLeft} / 3
                        </p>
                      </div>
                    </div>
                    <p className="mt-4 text-sm leading-6 text-slate-300">
                      {statusMessage}
                    </p>
                    {room.mode === "battle" ? (
                      <p className="mt-3 text-xs uppercase tracking-[0.28em] text-slate-500">
                        Voice:{" "}
                        {voiceStatus === "active"
                          ? "On"
                          : voiceStatus === "starting"
                            ? "Connecting"
                            : voiceStatus === "error"
                              ? "Error"
                              : "Off"}
                        {voiceError ? ` - ${voiceError}` : ""}
                      </p>
                    ) : null}
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/40 p-4">
                    <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                      Players
                    </p>
                    <div className="mt-4 space-y-3">
                      {Object.values(room.players).map((player) => (
                        <div
                          key={player.deviceId}
                          className={`rounded-2xl border px-4 py-3 ${outcomeTone(player.outcome)}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-white">
                                {player.displayName}
                              </p>
                              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                                {player.deviceId === deviceId
                                  ? "This device"
                                  : "Remote device"}
                              </p>
                            </div>
                            <span className="rounded-full border border-current/20 px-2.5 py-1 text-[0.7rem] uppercase tracking-[0.3em]">
                              {outcomeLabel(player.outcome)}
                            </span>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-200">
                            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                              Mistakes: {player.mistakes} / 3
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                              {player.connected ? "Connected" : "Disconnected"}
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                              Score: {player.score ?? 0}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {room.spectators && room.spectators.length > 0 ? (
                    <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/40 p-4 mt-3">
                      <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                        Spectators
                      </p>
                      <div className="mt-3 space-y-2 text-sm text-slate-200">
                        {room.spectators.map((name) => (
                          <div
                            key={name}
                            className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2"
                          >
                            {name}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </aside>

                {Object.entries(voiceStreams).map(
                  ([streamDeviceId, stream]) => (
                    <VoiceAudio key={streamDeviceId} stream={stream} />
                  ),
                )}
              </motion.div>
            )}
          </section>

          <aside className="space-y-6">
            {room ? (
              <div className="rounded-[2rem] border border-cyan-400/20 bg-gradient-to-br from-cyan-400/15 to-sky-400/5 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.35em] text-cyan-100/80">
                      Invite
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">
                      Let someone join instantly
                    </h2>
                  </div>
                  <div className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.3em] text-slate-100">
                    QR ready
                  </div>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-[auto_1fr]">
                  <div className="flex items-center justify-center rounded-[1.5rem] border border-white/10 bg-slate-950/55 p-4">
                    <div className="rounded-[1.15rem] bg-white p-3 shadow-[0_0_40px_rgba(14,165,233,0.25)]">
                      <QRCodeSVG
                        value={inviteUrl}
                        size={164}
                        bgColor="#ffffff"
                        fgColor="#020617"
                        level="M"
                        includeMargin={false}
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <p className="text-sm leading-6 text-slate-200">
                      Scan this QR code from another phone on the same Wi-Fi, or
                      copy the invite link below.
                    </p>
                    <div className="rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3">
                      <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                        Room link
                      </p>
                      <p className="mt-2 break-all text-sm text-white">
                        {inviteUrl}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void copyRoomLink()}
                        className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/15"
                      >
                        Copy link
                      </button>
                      <button
                        type="button"
                        onClick={() => void shareRoomLink()}
                        className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-sm font-medium text-cyan-50 transition hover:bg-cyan-300/15"
                      >
                        Share sheet
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="rounded-[2rem] border border-white/10 bg-white/5 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                    Device stats
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">
                    Your local record
                  </h2>
                </div>
                <div className="rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs uppercase tracking-[0.3em] text-sky-100">
                  {(stats?.displayName ?? displayNameDraft) || "Player"}
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <StatCard
                  label="Wins"
                  value={stats?.wins ?? 0}
                  accent="text-emerald-300"
                />
                <StatCard
                  label="Losses"
                  value={stats?.losses ?? 0}
                  accent="text-rose-300"
                />
                <StatCard
                  label="Games"
                  value={stats?.gamesPlayed ?? 0}
                  accent="text-sky-300"
                />
                <StatCard
                  label="Mistakes"
                  value={stats?.mistakes ?? 0}
                  accent="text-amber-300"
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <StatCard
                  label="Best streak"
                  value={stats?.bestWinStreak ?? 0}
                  accent="text-fuchsia-300"
                />
                <StatCard
                  label="Fastest win"
                  value={formatDuration(stats?.fastestSolveMs ?? null)}
                  accent="text-cyan-300"
                />
              </div>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-white/5 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                Match feed
              </p>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <FeedLine
                  title="Connection"
                  value={socketReady ? "Ready" : "Connecting"}
                />
                <FeedLine
                  title="Device ID"
                  value={deviceId.slice(0, 8).toUpperCase()}
                />
                <FeedLine
                  title="Lobby hint"
                  value={room ? "In game" : "Set a name and pick a room"}
                />
                <FeedLine
                  title="Difficulty"
                  value={
                    room
                      ? difficultyLabels[room.difficulty]
                      : difficultyLabels[difficulty]
                  }
                />
              </div>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/55 p-4">
      <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function FeedLine({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3">
      <span className="text-xs uppercase tracking-[0.28em] text-slate-500">
        {title}
      </span>
      <span className="text-right text-sm font-medium text-white">{value}</span>
    </div>
  );
}

function UndoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14l-4-4 4-4" />
      <path d="M5 10h8.5a5.5 5.5 0 1 1 0 11H10" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20H10.2a2 2 0 0 1-1.4-.6L4 14.6a2 2 0 0 1 0-2.8l6.1-6.1a2 2 0 0 1 2.8 0l7.1 7.1a2 2 0 0 1 0 2.8L18.8 17" />
      <path d="M7 20h13" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" />
      <path d="M19 12a7 7 0 0 1-14 0" />
      <path d="M12 19v3" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 5a2 2 0 1 1 4 0v5" />
      <path d="M14 10v2a2 2 0 0 1-3.2 1.6" />
      <path d="M5 12a7 7 0 0 0 10.9 5.8" />
      <path d="M12 19v3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function VoiceAudio({ stream }: { stream: MediaStream | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.srcObject = stream;
  }, [stream]);

  if (!stream) {
    return null;
  }

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
}

function ExitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
      <path d="M21 21V3" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function DigitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
      <path d="M7 11c0-1.5.5-3 2-4" />
      <path d="M17 11c0-1.5-.5-3-2-4" />
    </svg>
  );
}
