Plan — what I'll cover

- Summarize the app architecture and data models.
- Describe runtime flows: create/join, play/submit, win/loss, spectating, solo watcher.
- Point out the important files and key functions (with links).
- Give practical tips for making common changes, testing, and debugging.
- Provide exact commands to run/build/deploy locally and on Render.

**Overview**

- **What it is**: A full-stack realtime Sudoku game (React + Vite client, Express + Socket.IO server) that supports solo and 1-vs-1 battle modes, spectator joins, per-device stats, and optional voice signaling.
- **Single origin design**: The production server serves the built client and the Socket.IO/API on the same origin (see index.ts and package.json).

**Data Model (shared types)**

- **DIFFICULTIES / Difficulty**: defined in game.ts. Controls timer/blank tables.
- **RoomState**: room metadata, puzzle & board arrays, players map, spectators list, phase/outcome fields. See game.ts.
- **PlayerState**: device id, displayName, connected, ready, mistakes, outcome, score.

**Key files & important functions**

- **Shared types**
  - game.ts — DIFFICULTIES, DEFAULT_TIMER_BY_DIFFICULTY, DEFAULT_BLANKS_BY_DIFFICULTY, Room/Player types.
- **Server (room lifecycle & logic)**
  - index.ts
    - Sets up Express + Socket.IO, routes `/api/*`, and emits `room:updated` / `room:ended`.
    - `emitRoomUpdate(roomCode)`: iterates sockets and sends tailored room state per device.
  - gameStore.ts and surrounding lines
    - `createRoom(payload)`: picks/creates puzzle, initializes room and boards.
    - `joinRoom(payload)`: ensures player exists, marks solo late-joiners as spectator (outcome = "lost"), ensures boards/notes.
    - `submitCell(payload)`: validates move, updates board, records correct/wrong/mistake, calls `finishRoom` if solved or everyone eliminated.
    - `finishRoom(room, reason, winnerDeviceId)`: sets room.phase to "finished", marks winner.outcome = "won", others active => "lost", records stats.
    - `cloneRoom(room, deviceId)`: returns a room view tailored to the requesting device (board chosen via `getBoardForDevice` and notes merged for spectators).
  - sudoku.ts
    - `generateSudokuPuzzle(difficulty)`: builds a randomized solution and blanks positions according to DEFAULT_BLANKS_BY_DIFFICULTY.
- **Server state & persistence**
  - statsStore.ts — simple JSON-backed per-device stats helpers used by the server.
- **Client (UI + socket integration)**
  - socket.ts
    - `createGameSocket()`: uses `import.meta.env.VITE_SOCKET_URL ?? window.location.origin`; connects with path `/socket.io`.
  - api.ts
    - `fetchDeviceStats` and `fetchRoom` use relative `/api/*` endpoints.
  - App.tsx and modal region App.tsx
    - Central app state, socket event handlers (`room:updated`, `room:ended`), UI for lobby, board, scoreboard, spectator panel, toasts, finish modal, and number pad.
    - `submitValue(...)` calls `cell:submit` via socket ack and applies local state/notes and sound feedback.
    - Handles keyboard shortcuts, undo stack, voice chat setup, and toast notifications.
  - Board.tsx
    - Pure board rendering (cells, fixed vs editable, notes grid, wrong-move animation). Receives `board`, `puzzle`, `selectedIndex`, `notes`, `onSelect`.
- **Build / Run**
  - package.json scripts:
    - `npm run dev` — dev server + vite client
    - `npm run build` — builds client and compiles server into dist-server
    - `npm start` — runs `node dist-server/server/index.js` in production

**Runtime flows (step-by-step)**

1. Room creation (host)

- Client calls socket `"room:create"` with CreateRoomPayload.
- Server: `createRoom` picks difficulty (handles "random"), calls `generateSudokuPuzzle`, initializes `room.boards` and `room.players`, persists initial stats, responds with `room` tailored to creator via `cloneRoom`.
- Server joins the socket to the room namespace and calls `emitRoomUpdate(roomCode)` to update other sockets (none yet).

2. Join (second player or spectator)

- Client emits `"room:join"`.
- Server `joinRoom`:
  - If room.mode === "solo" and an active player exists, the new joiner is marked as a spectator by setting `player.outcome = "lost"`.
  - Ensures a board for the device is present (but spectators get board chosen by `cloneRoom` tailored view).
  - Emits updated room state to all sockets in room.

3. Play / submit cell

- Client `submitValue` => `socket.emit("cell:submit", payload)`
- Server `submitCell`:
  - Validates active phase and player outcome.
  - If value matches solution: update player's board, increment score, call `isSolvedBoard` => if solved, call `finishRoom`.
  - Incorrect: increment mistakes; if mistakes >= 3, set player.outcome = "lost"; if all active players eliminated, `finishRoom("all-eliminated")`.
  - Returns `room` & `stats` in the ack; server then `emitRoomUpdate(...)`.
- Client receives reply and updates local UI, notes, toasts, wrong-move animation.

4. Finish & Spectating

- `finishRoom` marks winner/winnerDeviceId, sets room.phase = "finished", sets solvedAt, and updates players' outcomes.
- Server emits `room:ended` to all sockets after finishing (via `emitRoomUpdate` / `room:ended` branch in index.ts).
- Client finish modal logic (in App.tsx) shows modal only for the local player when their local outcome transitions from "active" -> "won" | "lost" (we updated gating to avoid prompting the still-active opponent).
- Spectators: for solo games, late joiners are spectators (outcome set to "lost"), included in `room.spectators` (display names). For battle games, finished players remain participants and can watch without being considered the same as a solo spectator.

5. Notes merge for spectators

- `getNotesForDevice(room, deviceId)` in server merges all players’ notes for spectators; active players only see their own notes.

6. Voice signaling

- Clients call `voice:signal` events; server forwards `roomSocket.emit("voice:signal", payload)` to target socket if present.

**Special cases**

- Solo active game + late joiner → joiner becomes spectator and receives merged notes; they should not appear on live scoreboard.
- Battle game: winner is set and others marked lost only when appropriate; room remains logically accessible (we updated client to show spectate only for the finished player).
- Timer expiration → `finishRoom("timeout")` path.

**Where to change behavior**

- Change how spectators are tracked:
  - Server: gameStore.ts — adjust `joinRoom` behavior and `cloneRoom`’s `spectators` calculation.
- Change who the spectator sees:
  - `getBoardForDevice(room, deviceId)` in gameStore.ts determines which board is returned to requesting device.
- Change finish modal logic:
  - App.tsx — look for the useEffect that shows `finishModal` (search for `setFinishModal` and the modal JSX near App.tsx).
- Change generation difficulty:
  - game.ts — change blank counts and timers.
  - sudoku.ts — adjust `generateSudokuPuzzle` if you want more sophisticated generation (constraint solver) instead of simple random blanking.
- Remove duplicate Eraser:
  - App.tsx — remove the quick erase button from the number pad area (the Eraser appears twice; remove the pad one).
- Add spectator counter/notifications:
  - Server already computes `spectators` in `cloneRoom`; in App.tsx show an eye icon near the board using `room.spectators.length`. Add toasts by diffing previous `room.spectators` vs new in `room:updated` handler (there is already toast code — reuse `pushToast`).

**Practical editing tips**

- Use the shared type definitions to keep server/client synced. When you change a type in game.ts, run `npm run typecheck`.
- When changing imports on server side, prefer relative imports (`../shared/game.js`) so the compiled Node code resolves without TS path alias hacks.
- When editing production behavior (server), follow this loop:
  1. Edit server code.
  2. Run unit or integration tests (if you add some).
  3. Locally: `npm run build` then `npm start` and test client interactions.
- To change client UI:
  - Edit App.tsx and smaller components (e.g., Board.tsx) and test with `npm run dev`.
  - Use React DevTools and Redux-like snapshots (or `prevRoomRef` in code) to inspect transitions.
- To add logging for debugging:
  - Server: add `console.log(...)` in gameStore.ts or index.ts. Render logs will surface under the service Events.
  - Client: `pushToast` is a convenient visible debug UI. Use `console.debug` for less noisy console logs.

**Commands**

- Install deps (local):

```bash
npm ci
```

- Run development (client + server):

```bash
npm run dev
```

- Build client + server for production locally:

```bash
npm run build
```

- Run production server locally (after build):

```bash
npm start
```

- Typecheck:

```bash
npm run typecheck
```

**Deployment notes (Render)**

- Build command in Render: `npm install && npm run build`
- Start command in Render: `npm start`
- If you previously committed node_modules, remove them from Git and force-push to avoid platform issues.
- Free Render instances sleep after 15m idle — expect cold-start delays.

**Debugging checklist**

- If 404 on live site:
  - Check that dist exists post-build and server serves the correct path (server path was fixed to serve `../../dist` from compiled location).
  - Check Render service logs (Events) for build and start errors.
- If socket fails:
  - Verify client `createGameSocket()` baseUrl uses same origin or VITE_SOCKET_URL when running split deployments.
  - Check `socket.io` server logs for connection attempts.
- Use browser devtools Network tab to examine `/socket.io/` handshake, and `/api/rooms/*` responses.

If you want, I can:

- Generate a shorter README.md in the repo summarizing this doc and the exact commands.
- Create a small checklist script for common changes (e.g., expand difficulties, adjust spectate behavior) and implement one change (e.g., remove duplicate eraser) as an example. Which would you like next?
