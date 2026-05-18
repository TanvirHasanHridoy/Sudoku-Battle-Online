const DEVICE_ID_KEY = "sudoku-remote-device-id";
const DISPLAY_NAME_KEY = "sudoku-remote-display-name";
const ACTIVE_ROOM_KEY = "sudoku-remote-active-room";

function fallbackDeviceId() {
  return `device-${Math.random().toString(36).slice(2, 10)}`;
}

export function getDeviceId() {
  if (typeof window === "undefined") {
    return fallbackDeviceId();
  }

  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.() ?? fallbackDeviceId();
  window.localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

export function getDisplayName() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(DISPLAY_NAME_KEY) ?? "";
}

export function setDisplayName(displayName: string) {
  if (typeof window === "undefined") {
    return;
  }

  if (!displayName.trim()) {
    window.localStorage.removeItem(DISPLAY_NAME_KEY);
    return;
  }

  window.localStorage.setItem(DISPLAY_NAME_KEY, displayName);
}

export function getActiveRoomCode() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(ACTIVE_ROOM_KEY) ?? "";
}

export function setActiveRoomCode(roomCode: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(ACTIVE_ROOM_KEY, roomCode);
}

export function clearActiveRoomCode() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(ACTIVE_ROOM_KEY);
}

export function normalizeRoomCode(roomCode: string) {
  return roomCode.trim().toUpperCase();
}
