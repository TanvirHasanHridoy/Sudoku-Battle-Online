## Plan: Spectate, Scoreboard, and Difficulty Fixes

Fix the match flow so spectating is tied to the correct player role, not just to "anyone who is no longer active." The core change is to separate a finished battle player from a true spectator: a battle player who wins or loses should be able to stay in the room and watch the still-active opponent, while a solo joiner who is only spectating should not be counted in the live scoreboard. In parallel, add a visible spectator counter near the board, toast when spectators arrive or leave, remove the duplicate erase control, and expand the difficulty table so the generator exposes more granular tiers.

**Steps**

1. Rework the room end-state model in `server/gameStore.ts` and `shared/game.ts` so a player's role is not inferred only from `outcome`.
   - Add an explicit spectating/participant distinction for solo joiners versus finished battle players.
   - Keep battle rooms active while at least one player is still playing, instead of forcing the entire room into `finished` as soon as the first board is solved.
   - Preserve the existing win/loss stats updates and make sure the board chosen for each device still comes from the active opponent when that is appropriate.
   - This is the main fix for the bug where the wrong player gets pushed into spectate mode.

2. Update the client finish-state gating in `src/App.tsx` so the spectate/exit modal appears only for the correct local player.
   - Trigger the modal from the local player's outcome transition, not from a blanket room-finished check.
   - Show the spectate option only when the local player is allowed to watch the still-active opponent.
   - Avoid showing the modal to the still-active player when the other participant has already finished.
   - Keep the existing exit flow for leaving the room, but make the modal text reflect whether the local player won, lost, or is now watching.

3. Rework the scoreboard and spectator UI in `src/App.tsx`.
   - Render the live scoreboard from active battle participants and finished battle participants, but exclude true solo spectators so they do not appear as players on the board.
   - Add a compact spectator indicator near the board with an eye icon and the current watcher count.
   - Use `room.spectators` or an equivalent server-provided watcher list as the source for that counter.
   - Keep the existing side panel spectator list only if it still adds value; otherwise let the new eye counter be the primary inline signal.

4. Add join/leave spectate toasts in `src/App.tsx`.
   - Diff the previous and current spectator list after each room update.
   - Emit a toast when someone starts spectating and another when someone leaves spectating.
   - Make sure these toasts also work when a solo spectator joins or disconnects.

5. Remove the redundant erase control in `src/App.tsx`.
   - Keep the main erase button in the control row.
   - Remove the extra quick erase button from the number pad so there is only one visible eraser action.
   - Leave the keyboard shortcuts intact.

6. Expand difficulty coverage in `shared/game.ts`, `server/gameStore.ts`, `server/sudoku.ts`, and `src/App.tsx`.
   - Add more named difficulty tiers rather than only the current small set.
   - Extend the timer and blank-count tables for the new tiers.
   - Make server-side random difficulty selection pull from the full real-difficulty set.
   - Update the UI labels and difficulty description copy so the new tiers are selectable and readable.
   - Review the generator behavior so the added tiers actually produce noticeably different board densities.

**Relevant files**

- `d:\Projects\ALL AI RELATED STUFFS\Sudoku remote\server\gameStore.ts` - room lifecycle, join/reconnect behavior, board selection, spectator data
- `d:\Projects\ALL AI RELATED STUFFS\Sudoku remote\shared\game.ts` - shared room/player types, difficulty unions, blank/timer tables
- `d:\Projects\ALL AI RELATED STUFFS\Sudoku remote\server\sudoku.ts` - puzzle generation and blanking
- `d:\Projects\ALL AI RELATED STUFFS\Sudoku remote\src\App.tsx` - finish modal, scoreboard, spectator UI, toasts, erase controls, difficulty dropdown
- `d:\Projects\ALL AI RELATED STUFFS\Sudoku remote\src\components\Board.tsx` - board-only rendering surface; should not need control changes

**Verification**

1. Run `npm run typecheck` after the changes to catch any shared-type or state-shape mismatches.
2. Run `npm run build` to confirm the Vite client still compiles with the updated room and difficulty model.
3. Manually test a two-device battle: one player solves first, the still-active player keeps playing, the finished player gets the spectate/exit prompt, and the wrong player does not.
4. Manually test a solo watcher join: the watcher should not appear in the live scoreboard, the eye counter should increment, and a toast should fire on join and leave.
5. Confirm there is only one visible erase button and the keyboard shortcuts still clear cells.
6. Sample each difficulty tier a few times and confirm the blank counts and timers are distinct enough to feel like real tiers.

**Decisions**

- Treat "spectator" as a distinct concept from "finished battle player" so the live scoreboard can hide true watchers without hiding winners and losers who are still part of the match.
- Keep the room active until the last participant is done or the timer ends, rather than ending the entire room on the first solve.
- Expand the difficulty set by adding a few new named tiers, not just by renaming the existing ones.
- Keep the scoreboard showing finished battle participants, but not solo watchers.
