# Sudoku Remote Plan

## Stack

- Frontend: React 18 + TypeScript + Vite
- Realtime multiplayer: Socket.IO client/server
- Server: Express + Socket.IO + Node.js
- Styling: Tailwind CSS 3 with custom animation utilities
- Motion: Framer Motion for board and panel transitions
- Persistence: JSON-backed stats store on the server so each device keeps its own record locally on the LAN host

## Dependency Versions

- `react` and `react-dom`: `18.2.0`
- `vite`: `5.4.x`
- `@vitejs/plugin-react`: `4.3.x`
- `typescript`: `5.5.x`
- `tailwindcss`: `3.4.x`
- `postcss`: `8.4.x`
- `autoprefixer`: `10.4.x`
- `socket.io` and `socket.io-client`: `4.7.x`
- `express`: `4.19.x`
- `framer-motion`: `11.11.x`

## File Structure

- `src/` - React client
- `src/components/` - board, panels, controls, animations
- `src/lib/` - device identity, socket helpers, API helpers, client utilities
- `server/` - Express app, Socket.IO game loop, stats store, Sudoku generator
- `shared/` - shared TypeScript types and schemas used by both client and server
- `server/data/` - JSON persistence for device stats

## Gameplay Flow

1. A player opens the site and creates a room.
2. The host chooses a difficulty or random mode.
3. The server generates a fresh Sudoku puzzle and keeps the solution hidden.
4. Other players on the same Wi-Fi join using the room code or room link.
5. Each device gets its own stats record.
6. Every player has 3 mistakes. The third wrong submission eliminates that player.
7. The first player to solve the board wins and ends the room.
8. If the timer expires before a solve, the room ends and active players lose.

## Validation Plan

- Type-check the whole project after scaffolding.
- Build the client bundle.
- Fix any mismatched ESM/TypeScript/Vite issues before finalizing.
