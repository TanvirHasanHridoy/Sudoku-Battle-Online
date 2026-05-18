import {
  DEFAULT_BLANKS_BY_DIFFICULTY,
  type Board,
  type RealDifficulty,
} from "../shared/game.js";

const BASE_SOLUTION = Array.from({ length: 81 }, (_, index) => {
  const row = Math.floor(index / 9);
  const col = index % 9;
  return ((row * 3 + Math.floor(row / 3) + col) % 9) + 1;
});

function shuffle<T>(values: T[]): T[] {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function buildPermutation(): number[] {
  const bandOrder = shuffle([0, 1, 2]);
  const rowPermutation = bandOrder.flatMap((band) =>
    shuffle([0, 1, 2]).map((offset) => band * 3 + offset),
  );
  const stackOrder = shuffle([0, 1, 2]);
  const columnPermutation = stackOrder.flatMap((stack) =>
    shuffle([0, 1, 2]).map((offset) => stack * 3 + offset),
  );
  return rowPermutation
    .map((rowIndex) => rowIndex * 9)
    .flatMap((rowStart) =>
      columnPermutation.map((columnIndex) => rowStart + columnIndex),
    );
}

function remapDigits(board: Board): Board {
  const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  return board.map((value) => (value === null ? null : digits[value - 1]));
}

function pickBlankPositions(blankCount: number, difficulty: RealDifficulty) {
  const shuffledPositions = shuffle(
    Array.from({ length: 81 }, (_, index) => index),
  );
  const selected = new Set<number>();
  const rowCounts = Array.from({ length: 9 }, () => 0);
  const columnCounts = Array.from({ length: 9 }, () => 0);
  const maxPerRow =
    difficulty === "beginner"
      ? 4
      : difficulty === "easy"
        ? 5
        : difficulty === "medium"
          ? 6
          : difficulty === "hard"
            ? 7
            : difficulty === "expert"
              ? 8
              : 9;

  for (const position of shuffledPositions) {
    if (selected.size >= blankCount) {
      break;
    }

    const row = Math.floor(position / 9);
    const column = position % 9;

    if (rowCounts[row] >= maxPerRow || columnCounts[column] >= maxPerRow) {
      continue;
    }

    selected.add(position);
    rowCounts[row] += 1;
    columnCounts[column] += 1;
  }

  for (const position of shuffledPositions) {
    if (selected.size >= blankCount) {
      break;
    }

    selected.add(position);
  }

  return Array.from(selected).slice(0, blankCount);
}

export function generateSudokuPuzzle(difficulty: RealDifficulty): {
  puzzle: Board;
  solution: Board;
} {
  const permutation = buildPermutation();
  const randomizedSolution = remapDigits(
    permutation.map((index) => BASE_SOLUTION[index]),
  );
  const puzzle = [...randomizedSolution];
  const blanksNeeded = DEFAULT_BLANKS_BY_DIFFICULTY[difficulty];
  const positions = pickBlankPositions(blanksNeeded, difficulty);

  for (const position of positions) {
    puzzle[position] = null;
  }

  return {
    puzzle,
    solution: randomizedSolution,
  };
}
