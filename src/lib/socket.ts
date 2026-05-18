import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@shared/game";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let gameSocket: GameSocket | null = null;

export function createGameSocket() {
  if (gameSocket) {
    return gameSocket;
  }

  const baseUrl = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;

  gameSocket = io(baseUrl, {
    path: "/socket.io",
    autoConnect: false,
    transports: ["websocket", "polling"],
    withCredentials: true,
  }) as GameSocket;

  return gameSocket;
}
