import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyStats, type DeviceStats } from "@shared/game";

const statsFilePath = fileURLToPath(
  new URL("./data/stats.json", import.meta.url),
);

let statsCache: Record<string, DeviceStats> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

async function ensureLoaded() {
  if (statsCache) {
    return statsCache;
  }

  try {
    const raw = await fs.readFile(statsFilePath, "utf8");
    statsCache = raw.trim()
      ? (JSON.parse(raw) as Record<string, DeviceStats>)
      : {};
  } catch {
    statsCache = {};
  }

  return statsCache;
}

function queuePersist() {
  persistQueue = persistQueue.then(async () => {
    if (!statsCache) {
      return;
    }

    await fs.mkdir(dirname(statsFilePath), { recursive: true });
    await fs.writeFile(
      statsFilePath,
      `${JSON.stringify(statsCache, null, 2)}\n`,
      "utf8",
    );
  });

  return persistQueue;
}

async function mutateStats(
  deviceId: string,
  displayName: string,
  mutate: (stats: DeviceStats) => void,
) {
  const cache = await ensureLoaded();
  const now = Date.now();
  const stats = cache[deviceId] ?? createEmptyStats(deviceId, displayName, now);

  stats.deviceId = deviceId;
  stats.displayName = displayName;
  stats.lastSeenAt = now;
  stats.updatedAt = now;
  mutate(stats);
  cache[deviceId] = stats;

  await queuePersist();
  return structuredClone(stats);
}

export async function getDeviceStats(deviceId: string, displayName = "Player") {
  const cache = await ensureLoaded();
  const now = Date.now();
  const existing = cache[deviceId];

  if (!existing) {
    const created = createEmptyStats(deviceId, displayName, now);
    cache[deviceId] = created;
    await queuePersist();
    return structuredClone(created);
  }

  existing.displayName = displayName || existing.displayName;
  existing.lastSeenAt = now;
  existing.updatedAt = now;
  await queuePersist();
  return structuredClone(existing);
}

export async function recordRoomCreated(deviceId: string, displayName: string) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.roomsCreated += 1;
    stats.roomsJoined += 1;
  });
}

export async function recordRoomJoined(deviceId: string, displayName: string) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.roomsJoined += 1;
  });
}

export async function recordMistake(deviceId: string, displayName: string) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.mistakes += 1;
    stats.wrongPlacements += 1;
    stats.totalScore -= 5;
  });
}

export async function recordCorrectPlacement(
  deviceId: string,
  displayName: string,
) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.correctPlacements += 1;
    stats.totalScore += 10;
  });
}

export async function recordWin(
  deviceId: string,
  displayName: string,
  solveTimeMs: number,
  scoreBonus = 0,
) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.gamesPlayed += 1;
    stats.wins += 1;
    stats.currentWinStreak += 1;
    stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.currentWinStreak);
    stats.fastestSolveMs =
      stats.fastestSolveMs === null
        ? solveTimeMs
        : Math.min(stats.fastestSolveMs, solveTimeMs);
    if (scoreBonus) {
      stats.totalScore += scoreBonus;
    }
  });
}

export async function recordLoss(deviceId: string, displayName: string) {
  return mutateStats(deviceId, displayName, (stats) => {
    stats.gamesPlayed += 1;
    stats.losses += 1;
    stats.currentWinStreak = 0;
  });
}
