# YouTube Watch Party

A small watch party app with a React/Vite client and an Express + Socket.IO server. The server owns room membership, participant roles, the shared video state, chat history, and the queue. The browser embeds YouTube's IFrame Player API and applies room playback updates locally.

## Requirements

- Node.js 20 or newer
- npm

## Install and run

From the project root:

```sh
npm install
npm run dev
```

The client runs at <http://localhost:5173> and the server at <http://localhost:3001>. Vite proxies `/api` and `/socket.io` to the server. To run one process at a time, use `npm run dev:client` or `npm run dev:server`.

The server defaults to port `3001` and accepts the client origin `http://localhost:5173`. Set `PORT` or `CLIENT_ORIGIN` in `server/.env` to change those values. `server/.env.example` lists the supported variables. The app does not require API secrets.

Check server availability at <http://localhost:3001/api/health>.

## Architecture and room flow

- The client creates or joins rooms over Socket.IO. Room IDs are generated on the server; the app also provides a shareable URL containing the room ID.
- On create or join, the server attaches the socket to that room and returns the current participant list, video state, chat history, and queue. A reconnect can subscribe again to restore the current room state.
- The server keeps rooms in memory. Room state and chat history are cleared when the server restarts. Disconnected participants have a 20-second reconnect window.
- Socket handlers look up the socket's current room membership and server-side role before applying room actions. Role fields sent by clients do not grant permissions. Host reconnects also require a server-issued host token stored in that browser tab's session storage.
- Room events update all connected members: `sync_state` carries video changes and playback state, `room:participants` and `user_joined`/`user_left` update the participant list, `chat:message` carries room chat, and `queue:update` carries the shared queue.
- The client loads videos through YouTube's IFrame Player API. Host and Moderator play, pause, seek, and select videos; the server broadcasts the resulting shared state and each client applies it to its own player.
- Participant promotion and removal are Host-only. Chat and adding a video to the queue are available to room members; queue removal is Host-only and playing the next queued video is available to Host and Moderator.
- Volume and mute are local to each browser player. They are stored in that tab's session storage and are not sent over Socket.IO.

## Verification

Run the server's Socket.IO permission and room-flow tests:

```sh
npm test --workspace server
```

Create a production client bundle:

```sh
npm run build --workspace client
```

The client package does not currently define an automated test script. The server integration test uses separate Socket.IO clients to exercise room permissions, role changes, removal, reconnection, synchronization, chat, queue behavior, and room isolation.

## Deployment (Render)

The repository includes a `render.yaml` Blueprint for a Render static site and a Node web service. The React/Vite client is published from `client/dist`; the Express + Socket.IO server runs as a single, always-on web service. Use a single backend instance because room membership, playback state, chat, and queue are held in that process's memory. The Blueprint selects Render's `starter` web-service plan so the backend does not use an inactivity-sleeping free instance.

### Deploy from the Blueprint

1. Push this repository to a Git provider supported by Render. Keep `render.yaml` at the repository root.
2. In Render, choose **New > Blueprint**, connect the repository, and select the branch to deploy. Render reads the two services and their build, start, health-check, and route settings from `render.yaml`.
3. Review the Blueprint before applying it. The backend's `CLIENT_ORIGIN` is linked to the static site's public `RENDER_EXTERNAL_URL`; the static build's `VITE_SERVER_URL` is linked to the backend's public `RENDER_EXTERNAL_URL`. Render supplies both URLs, so no localhost URL or manually invented deployment URL is used.
4. Apply the Blueprint and wait for both services to finish deploying. The backend health check is `/api/health`. The static site rewrites missing paths to `/index.html`, allowing direct visits and refreshes at `/room/<ROOM_ID>`.
5. Copy the actual service URLs from the Render Dashboard after creation. Check the backend URL plus `/api/health`, load the frontend, open a room link directly, and confirm the Socket.IO connection reaches the backend. The browser connects to the backend's HTTPS URL; Socket.IO uses its normal polling connection and WebSocket upgrade. Render Web Services support inbound WebSocket connections.

The Blueprint configures these variables:

| Service | Variable | Value / purpose |
| --- | --- | --- |
| Backend | `NODE_ENV` | `production` |
| Backend | `CLIENT_ORIGIN` | Render-provided public URL of the frontend; used for Express and Socket.IO CORS. |
| Backend | `PORT` | Supplied by Render at runtime; the server reads it and falls back to `3001` locally. |
| Frontend build | `VITE_SERVER_URL` | Render-provided public URL of the backend, embedded in the built client for Socket.IO. |

There are no secrets or API keys required. `CLIENT_ORIGIN` and `VITE_SERVER_URL` are public service URLs, not credentials. `VITE_SERVER_URL` is a build-time setting, so redeploy the frontend after changing it. If you add a custom frontend domain, update the backend `CLIENT_ORIGIN` to that exact origin (scheme and hostname, with no path) and redeploy the backend. Keep the backend URL public and HTTPS, and do not point production builds at localhost. The Vite `/api` and `/socket.io` proxies remain development-only.

### Deployment limits

This deployment runs one in-memory backend instance. A backend restart or redeploy clears rooms and chat/queue state; scaling to multiple instances would split room state and is not supported without shared storage and a Socket.IO adapter. The application has no account system or durable room authorization. Deployment adds no persistence, database, or authentication. Render assigns the actual service URLs, so this repository intentionally does not contain a live URL.

## YouTube behavior and limitations

- YouTube Data API search is not implemented. Queue entries are added using YouTube links; the server requests title and thumbnail metadata from YouTube oEmbed and falls back to the video ID if metadata is unavailable.
- The video must be public and allow embedded playback. YouTube can reject unavailable, private, age-restricted, or embedding-disabled videos. Browser extensions, autoplay rules, network access, and YouTube availability can also affect playback.
- Rooms, queue items, and chat history are held in memory and are not persisted across server restarts. There is no account system or durable room authorization; the host token protects Host reconnects within the current app session.

If real YouTube search is added later, keep its API key on the server in `server/.env`; do not expose it through a `VITE_` variable or client bundle. No YouTube API key is needed for the current app.
