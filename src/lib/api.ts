import type { DeviceStats, RoomState } from "@shared/game";

export async function fetchDeviceStats(deviceId: string, displayName: string) {
  const response = await fetch(
    `/api/stats/${encodeURIComponent(deviceId)}?displayName=${encodeURIComponent(displayName)}`,
  );

  if (!response.ok) {
    throw new Error("Unable to load device stats.");
  }

  const data = (await response.json()) as { stats: DeviceStats };
  return data.stats;
}

export async function fetchRoom(roomCode: string) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}`);

  if (!response.ok) {
    throw new Error("Room not found.");
  }

  const data = (await response.json()) as { room: RoomState };
  return data.room;
}
