import { motion } from "framer-motion";
import type { Board as BoardValue } from "@shared/game";

interface BoardProps {
  board: BoardValue;
  puzzle: BoardValue;
  selectedIndex: number | null;
  disabled?: boolean;
  notes?: Record<number, number[]>;
  wrongMove?: { index: number; value: number } | null;
  onSelect: (index: number) => void;
}

export function Board({
  board,
  puzzle,
  selectedIndex,
  disabled = false,
  notes,
  wrongMove,
  onSelect,
}: BoardProps) {
  const selectedNumber =
    selectedIndex !== null ? (board[selectedIndex] ?? null) : null;

  return (
    <div className="mx-auto w-full max-w-[min(40rem,calc(100vw-0.25rem))] overflow-hidden rounded-2xl border-2 border-[var(--board-border)] bg-[var(--board-surface)] sm:max-w-[min(32rem,calc(100vw-1rem))]">
      <div className="grid grid-cols-9 gap-0">
        {board.map((value, index) => {
          const row = Math.floor(index / 9);
          const col = index % 9;
          const fixed = puzzle[index] !== null;
          const filled = value !== null;

          const isSelected = selectedIndex === index;
          const sameNumberHighlight =
            selectedNumber !== null &&
            selectedNumber === value &&
            !isSelected &&
            value !== null;
          const sameRowOrCol =
            selectedIndex !== null &&
            (Math.floor(selectedIndex / 9) === row ||
              selectedIndex % 9 === col);

          const isWrongMove = wrongMove?.index === index;
          const displayedValue = isWrongMove
            ? (wrongMove?.value ?? value)
            : value;
          const isWrongDigitVisible = isWrongMove && displayedValue !== null;

          let cellBg = "bg-[var(--board-cell-bg)]";
          let cellText = fixed
            ? "text-[var(--board-fixed-text)]"
            : filled
              ? "text-[var(--board-filled-text)]"
              : "text-[var(--board-empty-text)]";

          if (isWrongMove) {
            cellBg = "bg-[var(--board-wrong-bg)]";
            cellText = "text-[var(--board-wrong-text)]";
          } else if (isSelected) {
            cellBg = "bg-[var(--board-selected-bg)]";
            cellText = "text-[var(--board-selected-text)]";
          } else if (sameNumberHighlight) {
            cellBg = "bg-[var(--board-selected-bg)]";
            cellText = "text-[var(--board-filled-text)]";
          } else if (sameRowOrCol) {
            cellBg = "bg-[var(--board-hover-bg)]";
          }

          const borderClasses: string[] = [];
          if (col === 2 || col === 5) {
            borderClasses.push("border-r-4 border-r-[var(--board-separator)]");
          }
          if (row === 2 || row === 5) {
            borderClasses.push("border-b-4 border-b-[var(--board-separator)]");
          }

          const notesFor = notes?.[index] ?? [];
          const cellAnimation = isWrongMove
            ? {
                x: [0, -12, 12, -10, 10, -6, 6, 0],
                y: [0, 0, -2, 0, 1, 0],
                scale: [1.05, 1.08, 1.03, 1.1, 1.05],
                rotate: [0, -2, 2, -1, 1, 0],
              }
            : isSelected
              ? { scale: 1.05 }
              : undefined;
          const cellTransition = isWrongMove
            ? {
                duration: 0.7,
                times: [0, 0.12, 0.24, 0.38, 0.52, 0.68, 0.84, 1],
              }
            : { duration: 0.15 };

          return (
            <motion.button
              key={index}
              type="button"
              animate={cellAnimation}
              transition={cellTransition}
              whileTap={disabled ? undefined : { scale: 0.96 }}
              onClick={() => {
                if (!disabled) onSelect(index);
              }}
              className={`relative aspect-square border border-[var(--board-cell-border)] text-[clamp(0.95rem,4vw,1.15rem)] font-semibold transition duration-150 sm:text-lg ${cellBg} ${cellText} ${borderClasses.join(" ")} ${disabled ? "cursor-not-allowed opacity-70" : isSelected ? "" : "hover:bg-[var(--board-hover-bg)]"}`}
              aria-label={`Cell ${row + 1}, ${col + 1}${fixed ? ", fixed" : ""}`}
            >
              <span className="absolute inset-0 flex items-center justify-center">
                {displayedValue}
              </span>
              {isWrongDigitVisible ? (
                <motion.span
                  initial={{ opacity: 0, scale: 0.75, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="absolute inset-0 flex items-center justify-center text-3xl font-bold text-[var(--board-wrong-text)] drop-shadow-[0_0_12px_rgba(255,255,255,0.18)]"
                >
                  {wrongMove?.value}
                </motion.span>
              ) : null}

              {!filled && notesFor.length > 0 ? (
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 p-1 text-[0.55rem] text-[var(--board-note-text)] pointer-events-none select-none sm:text-[0.6rem]">
                  {Array.from({ length: 9 }).map((_, i) => {
                    const digit = i + 1;
                    const present = notesFor.includes(digit);
                    return (
                      <span
                        key={digit}
                        className={`flex items-center justify-center ${present ? "text-slate-100" : "text-slate-600"}`}
                        aria-hidden="true"
                      >
                        {present ? digit : ""}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
