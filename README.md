# YouTube Watch Party

A small watch party app with a React/Vite client and an Express + Socket.IO server. The server owns room membership, participant roles, the shared video state, chat history, and the queue. The browser embeds YouTube's IFrame Player API and applies room playback updates locally.

The project lets people watch the same YouTube video in a shared room, coordinate playback, chat, and keep a shared queue. Room participation is temporary and does not require user accounts.

## Project links

- Live frontend: <https://youtube-party-client.vercel.app/>
- GitHub repository: <https://github.com/AyushPawar633/Youtube-Party>

## Features

- Create a room and share its invite link; participants can join or reconnect to an existing room.
- Synchronize YouTube video selection, play, pause, seek, and playback state for Host and Moderator controls.
- Chat and maintain a shared YouTube video queue.
- Assign Moderator privileges; the Host can also manage participants and remove queued videos.
- Control volume and mute independently in each browser.
- Load queue title and thumbnail metadata through YouTube oEmbed, with a video ID fallback.

## Technology stack

- React 19 and React Router for the single-page frontend.
- Vite 6 for development and production builds.
- Node.js, Express 5, and Socket.IO 4 for the API and real-time room server.
- YouTube IFrame Player API for embedded video playback.
- Node's built-in test runner and Socket.IO clients for server integration tests.

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

### Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PORT` | Server | HTTP and Socket.IO port. Defaults to `3001` locally; Render supplies this in production. |
| `CLIENT_ORIGIN` | Server | Exact browser origin allowed by Express and Socket.IO CORS. Defaults to `http://localhost:5173` locally. |
| `VITE_SERVER_URL` | Client build | Public base URL of the Socket.IO backend. Optional in local development because Vite proxies `/socket.io`; set it to the deployed backend URL for production. |

The server reads `PORT` and `CLIENT_ORIGIN` from `server/.env` during local development. The client does not need a local env file when using the Vite proxy. Vite embeds `VITE_SERVER_URL` at build time. These variables are URLs/configuration, not secrets; no credentials or API keys are required.

Check server availability at <http://localhost:3001/api/health>.

## Architecture and room flow

- The client creates or joins rooms over Socket.IO. Room IDs are generated on the server; the app also provides a shareable URL containing the room ID.
- On create or join, the server attaches the socket to that room and returns the current participant list, video state, chat history, and queue. A reconnect can subscribe again to restore the current room state.
- The server keeps rooms in memory. Room state and chat history are cleared when the server restarts. Disconnected participants have a 20-second reconnect window.
- Socket handlers look up the socket's current room membership and server-side role before applying room actions. Role fields sent by clients do not grant permissions. Host reconnects also require a server-issued host token stored in that browser tab's session storage.
- Room events update all connected members: `sync_state` carries video changes and playback state, `room:participants` and `user_joined`/`user_left` update the participant list, `chat:message` carries room chat, and `queue:update` carries the shared queue.
- The client loads videos through YouTube's IFrame Player API. Host and Moderator play, pause, seek, and select videos; the server broadcasts the resulting shared state and each client applies it to its own player.
- **Host:** controls playback and selects videos; promotes and removes participants; removes queued items; can play the next queued video.
- **Moderator:** controls playback, selects videos, and can play the next queued video. Participant management and queue removal remain Host-only.
- **Participant:** can chat and add videos to the queue, but cannot control shared playback or select the current video.
- Chat and adding a video to the queue are available to all room members. The backend checks the socket's room membership and role for protected actions; client role fields do not grant permissions.
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

Run the focused client playback-synchronization regression tests:

```sh
node --test client/test/playbackSync.test.js
```

The client package does not currently define an npm test script. The server integration tests use separate Socket.IO clients to exercise room permissions, role changes, removal, reconnection, synchronization, chat, queue behavior, and room isolation.

## Deployment

The live frontend is hosted at Vercel, and the application uses a persistent Node.js + Socket.IO backend on Render. The repository does not record the actual Render backend URL, so it is intentionally not listed here.

### Configure the existing Vercel and Render services

1. In the Render backend service, set `CLIENT_ORIGIN` to `https://youtube-party-client.vercel.app`. Keep `NODE_ENV=production`; Render supplies `PORT` at runtime. The server listens on `0.0.0.0` and uses that port.
2. Copy the backend's actual public HTTPS URL from the Render Dashboard. Check that `<backend-url>/api/health` returns `{"status":"ok"}`.
3. In the Vercel frontend project's Production Environment Variables, set `VITE_SERVER_URL` to that actual Render backend URL. Do not add a path or use a localhost URL.
4. Redeploy the Vercel frontend because `VITE_SERVER_URL` is embedded at build time. Open the live frontend, create a room, then open an invite URL directly to verify the client can connect to the backend.

`CLIENT_ORIGIN` is used for both Express and Socket.IO CORS and must match the frontend origin exactly (scheme and host, with no path). If the frontend domain changes, update it and redeploy the backend. The client uses Socket.IO's HTTPS transport and can upgrade to WebSocket. Vite's `/api` and `/socket.io` proxies are development-only.

### Optional Render Blueprint

The checked-in `render.yaml` is an alternative deployment that creates both a Render static site and a Render Node web service. It builds the frontend from `client/dist`, rewrites SPA paths to `/index.html`, and links the two services' Render-provided public URLs. To use it, select **New > Blueprint** in Render, connect this repository, review the services, and apply the Blueprint. This setup hosts a separate frontend on Render; it is not the Vercel frontend linked above.

Use one backend instance. The room membership, video state, chat, and queue are in memory, so restarts clear them and multiple instances would not share state without adding shared storage and a Socket.IO adapter.

## YouTube behavior and limitations

- YouTube Data API search is not implemented. Queue entries are added using YouTube links; the server requests title and thumbnail metadata from YouTube oEmbed and falls back to the video ID if metadata is unavailable.
- The video must be public and allow embedded playback. YouTube can reject unavailable, private, age-restricted, or embedding-disabled videos. Browser extensions, autoplay rules, network access, and YouTube availability can also affect playback.
- Rooms, chat history, and queue items are held in memory and are not persisted across server restarts. There is no persistent database or user account system. The host token protects Host reconnects within the current app session, but this is not durable account-based authorization.

No YouTube API key is needed for the current app.
