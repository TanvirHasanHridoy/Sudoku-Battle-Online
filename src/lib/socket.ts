import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@shared/game";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createGameSocket() {
  const baseUrl = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;

  return io(baseUrl, {
    path: "/socket.io",
    autoConnect: false,
    transports: ["websocket", "polling"],
    withCredentials: true,
  }) as GameSocket;
}
