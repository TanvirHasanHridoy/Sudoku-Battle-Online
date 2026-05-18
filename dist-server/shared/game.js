export const DIFFICULTIES = [
    "random",
    "beginner",
    "easy",
    "medium",
    "hard",
    "expert",
    "master",
];
export const DEFAULT_TIMER_BY_DIFFICULTY = {
    beginner: 18 * 60,
    easy: 15 * 60,
    medium: 12 * 60,
    hard: 9 * 60,
    expert: 6 * 60,
    master: 4 * 60,
};
export const DEFAULT_BLANKS_BY_DIFFICULTY = {
    beginner: 30,
    easy: 38,
    medium: 44,
    hard: 50,
    expert: 56,
    master: 61,
};
export const BATTLE_COUNTDOWN_SECONDS = 5;
export function isRealDifficulty(value) {
    return value !== "random";
}
export function createEmptyStats(deviceId, displayName, now = Date.now()) {
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
