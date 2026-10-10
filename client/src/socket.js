import { io } from 'socket.io-client'

// Keep one client for the lifetime of the app. autoConnect:false lets AppShell
// attach connection listeners before starting the transport.
// In development, use Vite's /socket.io proxy. Production builds set
// VITE_SERVER_URL to the separately hosted Socket.IO server's public URL.
export const socket = io(import.meta.env.VITE_SERVER_URL || undefined, { autoConnect: false })
