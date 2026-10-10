import 'dotenv/config'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'

const app = express()
const server = http.createServer(app)
const port = Number(process.env.PORT) || 3001
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

app.use(cors({ origin: clientOrigin }))
app.use(express.json())
app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))

const io = new Server(server, {
  cors: { origin: clientOrigin, methods: ['GET', 'POST'] },
})

// The participant key is a per-tab reconnect identifier, not an auth token.
// Room data remains in memory and is cleared when this process restarts.
const rooms = new Map()
const reconnectGraceMs = 20_000
const closedRoomMessageTtlMs = 60_000
const closedRooms = new Map()

function acknowledge(callback, result) {
  if (typeof callback === 'function') callback(result)
}

function publicRoom(room) {
  return {
    id: room.id,
    participants: [...room.participants.values()].map(({ publicId, username, role, socketId }) => ({
      id: publicId,
      username,
      role,
      connected: Boolean(socketId),
    })),
  }
}

function publicVideoState(room, action = 'sync_state') {
  const elapsed = room.videoState.playing ? Math.max(0, (Date.now() - room.videoState.updatedAt) / 1000) : 0
  return { ...room.videoState, currentTime: room.videoState.currentTime + elapsed, updatedAt: Date.now(), action }
}

function publishSnapshot(room, target = io.to(room.id)) {
  target.emit('room:participants', publicRoom(room))
}

function publishUserEvent(event, room, participant) {
  io.to(room.id).emit(event, {
    roomId: room.id,
    participant: { id: participant.publicId, username: participant.username, role: participant.role },
    participants: publicRoom(room).participants,
  })
}

function rememberClosedRoom(roomId, message) {
  const timer = setTimeout(() => {
    const closedRoom = closedRooms.get(roomId)
    if (closedRoom?.timer === timer) closedRooms.delete(roomId)
  }, closedRoomMessageTtlMs)
  timer.unref?.()
  closedRooms.set(roomId, { message, timer })
}

function closeRoom(room, message) {
  io.to(room.id).emit('room:closed', { roomId: room.id, message })
  for (const participant of room.participants.values()) {
    clearTimeout(participant.disconnectTimer)
    const memberSocket = participant.socketId ? io.sockets.sockets.get(participant.socketId) : null
    if (memberSocket?.data.roomId === room.id) {
      memberSocket.data.roomId = undefined
      memberSocket.data.participantId = undefined
      memberSocket.leave(room.id)
    }
  }
  room.participants.clear()
  rooms.delete(room.id)
  rememberClosedRoom(room.id, message)
}

function removeParticipant(room, id) {
  const participant = room.participants.get(id)
  if (!participant) return
  clearTimeout(participant.disconnectTimer)
  room.participants.delete(id)

  if (participant.role === 'Host' && room.participants.size > 0) {
    const successor = [...room.participants.values()].find((member) => member.socketId && io.sockets.sockets.has(member.socketId))
    if (!successor) {
      closeRoom(room, 'This room closed because the Host left and no connected participant was available to take over.')
      return
    }

    successor.role = 'Host'
    room.hostToken = randomBytes(32).toString('hex')
    const update = { roomId: room.id, participant: { id: successor.publicId, username: successor.username, role: 'Host' } }
    io.to(room.id).emit('participant:role_changed', update)
    io.sockets.sockets.get(successor.socketId)?.emit('room:host_token', { roomId: room.id, hostToken: room.hostToken })
  }

  publishUserEvent('user_left', room, participant)
  if (room.participants.size === 0) rooms.delete(room.id)
}

function validateUsername(value) {
  if (typeof value !== 'string') return null
  const username = value.trim()
  return username.length > 0 && username.length <= 24 ? username : null
}

function participantKey(value, socket) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : socket.id
}

function detachFromRoom(socket) {
  const { roomId, participantId } = socket.data
  if (!roomId || !participantId) return
  socket.data.roomId = undefined
  socket.data.participantId = undefined
  socket.leave(roomId)
  const room = rooms.get(roomId)
  const participant = room?.participants.get(participantId)
  // Ignore disconnect/leave from a socket that was replaced by a reconnect.
  if (participant?.socketId === socket.id) removeParticipant(room, participantId)
}

function attachParticipant(socket, room, id, participant) {
  const previousSocketId = participant.socketId
  clearTimeout(participant.disconnectTimer)
  participant.disconnectTimer = null
  participant.socketId = socket.id
  socket.data.roomId = room.id
  socket.data.participantId = id
  socket.join(room.id)
  if (previousSocketId && previousSocketId !== socket.id) {
    io.sockets.sockets.get(previousSocketId)?.disconnect(true)
  }
}

function participantResult(room, participant) {
  const result = {
    room: publicRoom(room),
    participant: { id: participant.publicId, username: participant.username, role: participant.role },
    videoState: publicVideoState(room),
    chatMessages: [...room.chatMessages],
    queue: [...room.queue],
  }
  if (participant.role === 'Host') result.hostToken = room.hostToken
  return result
}

function validVideoId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value)
}

function validPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400
}

function currentMembership(socket) {
  const room = rooms.get(socket.data.roomId)
  const participant = room?.participants.get(socket.data.participantId)
  if (!room || !participant || participant.socketId !== socket.id || !socket.rooms.has(room.id)) return null
  return { room, participant }
}

function roleMembership(socket, roles, errorMessage, membershipError) {
  const membership = currentMembership(socket)
  if (!membership) return { error: membershipError }
  if (!roles.includes(membership.participant.role)) return { error: errorMessage }
  return membership
}

function hostMembership(socket) {
  return roleMembership(socket, ['Host'], 'Only the Host can manage room participants and the video queue.', 'Join a room before managing its participants or video queue.')
}

function playbackMembership(socket) {
  return roleMembership(socket, ['Host', 'Moderator'], 'Only the Host or a Moderator can control room playback.', 'Join a room before controlling its video.')
}

function publishQueue(room) {
  io.to(room.id).emit('queue:update', [...room.queue])
}

async function getVideoMetadata(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      signal: AbortSignal.timeout(4000),
    })
    if (response.ok) {
      const metadata = await response.json()
      return {
        title: typeof metadata.title === 'string' ? metadata.title.slice(0, 200) : `YouTube video ${videoId}`,
        thumbnailUrl: typeof metadata.thumbnail_url === 'string' ? metadata.thumbnail_url : null,
      }
    }
  } catch {
    // Metadata is optional; keep the real video ID visible if YouTube is unavailable.
  }
  return { title: `YouTube video ${videoId}`, thumbnailUrl: null }
}

function handleChatSend(socket, payload, callback) {
  const membership = currentMembership(socket)
  if (!membership) return acknowledge(callback, { error: 'Join a room before sending chat messages.' })
  if (typeof payload?.text !== 'string') return acknowledge(callback, { error: 'Enter a message.' })
  const text = payload.text.trim()
  if (!text || text.length > 1000) return acknowledge(callback, { error: 'Messages must be between 1 and 1000 characters.' })
  const message = {
    id: randomBytes(8).toString('hex'),
    username: membership.participant.username,
    text,
    timestamp: new Date().toISOString(),
  }
  membership.room.chatMessages.push(message)
  if (membership.room.chatMessages.length > 100) membership.room.chatMessages.shift()
  io.to(membership.room.id).emit('chat:message', message)
  acknowledge(callback, { ok: true, message })
}

async function handleQueueAdd(socket, payload, callback) {
  const membership = currentMembership(socket)
  if (!membership) return acknowledge(callback, { error: 'Join a room before adding to the queue.' })
  const videoId = payload?.videoId
  if (!validVideoId(videoId)) return acknowledge(callback, { error: 'Enter a valid YouTube video ID.' })
  if (membership.room.videoState.videoId === videoId || membership.room.queue.some((item) => item.videoId === videoId)) {
    return acknowledge(callback, { error: 'That video is already playing or in the queue.' })
  }
  if (membership.room.queue.length >= 100) return acknowledge(callback, { error: 'The queue is full. Ask the Host to play or remove a video first.' })
  const { title, thumbnailUrl } = await getVideoMetadata(videoId)
  // The socket might have left while the metadata request was in flight.
  const current = currentMembership(socket)
  if (!current || current.room !== membership.room) return acknowledge(callback, { error: 'Room membership ended before the video was added.' })
  if (current.room.videoState.videoId === videoId || current.room.queue.some((item) => item.videoId === videoId)) {
    return acknowledge(callback, { error: 'That video is already playing or in the queue.' })
  }
  if (current.room.queue.length >= 100) return acknowledge(callback, { error: 'The queue is full. Ask the Host to play or remove a video first.' })
  const item = {
    id: randomBytes(8).toString('hex'),
    videoId,
    title,
    thumbnailUrl,
    addedBy: current.participant.username,
    addedAt: new Date().toISOString(),
  }
  current.room.queue.push(item)
  publishQueue(current.room)
  acknowledge(callback, { ok: true, item })
}

function handleQueueRemove(socket, payload, callback) {
  const membership = hostMembership(socket)
  if (membership.error) return acknowledge(callback, { error: membership.error })
  const index = membership.room.queue.findIndex((item) => item.id === payload?.id)
  if (index < 0) return acknowledge(callback, { error: 'That video is no longer in the queue.' })
  membership.room.queue.splice(index, 1)
  publishQueue(membership.room)
  acknowledge(callback, { ok: true, queue: [...membership.room.queue] })
}

function handleQueueNext(socket, _payload, callback) {
  const membership = roleMembership(socket, ['Host', 'Moderator'], 'Only the Host or a Moderator can change the current video.', 'Join a room before playing the next video.')
  if (membership.error) return acknowledge(callback, { error: membership.error })
  const next = membership.room.queue.shift()
  if (!next) return acknowledge(callback, { error: 'The queue is empty.' })
  membership.room.videoState = { videoId: next.videoId, playing: false, currentTime: 0, updatedAt: Date.now() }
  publishQueue(membership.room)
  const videoState = publicVideoState(membership.room, 'change_video')
  io.to(membership.room.id).emit('sync_state', videoState)
  acknowledge(callback, { ok: true, item: next, videoState })
}

function handleVideoControl(socket, event, payload, callback) {
  const membership = playbackMembership(socket)
  if (membership.error) return acknowledge(callback, { error: membership.error })
  const { room } = membership

  const currentTime = payload?.currentTime
  if (!validPosition(currentTime)) return acknowledge(callback, { error: 'Invalid playback position.' })
  if (event === 'change_video') {
    if (!validVideoId(payload?.videoId)) return acknowledge(callback, { error: 'Invalid YouTube video ID.' })
    room.videoState = { videoId: payload.videoId, playing: false, currentTime: 0, updatedAt: Date.now() }
  } else {
    if (!room.videoState.videoId) return acknowledge(callback, { error: 'Load a video before controlling playback.' })
    if (event === 'play') room.videoState = { ...room.videoState, playing: true, currentTime, updatedAt: Date.now() }
    else if (event === 'pause') room.videoState = { ...room.videoState, playing: false, currentTime, updatedAt: Date.now() }
    else if (event === 'seek') room.videoState = { ...room.videoState, currentTime, updatedAt: Date.now() }
    else if (event === 'sync_state') {
      if (typeof payload?.playing !== 'boolean') return acknowledge(callback, { error: 'Invalid playback state.' })
      room.videoState = { ...room.videoState, playing: payload.playing, currentTime, updatedAt: Date.now() }
    }
  }

  const state = publicVideoState(room, event)
  if (event === 'change_video') {
    room.queue = room.queue.filter((item) => item.videoId !== payload.videoId)
    publishQueue(room)
  }
  socket.to(room.id).emit('sync_state', state)
  acknowledge(callback, { ok: true, videoState: state })
}

function handleParticipantPromote(socket, payload, callback) {
  const membership = hostMembership(socket)
  if (membership.error) return acknowledge(callback, { error: membership.error })
  const target = [...membership.room.participants.values()].find((participant) => participant.publicId === payload?.participantId)
  if (!target || target.role !== 'Participant') return acknowledge(callback, { error: 'Select a current Participant to promote.' })
  target.role = 'Moderator'
  const update = { roomId: membership.room.id, participant: { id: target.publicId, username: target.username, role: target.role } }
  io.to(membership.room.id).emit('participant:role_changed', update)
  publishSnapshot(membership.room)
  acknowledge(callback, { ok: true, participant: update.participant, room: publicRoom(membership.room) })
}

function handleParticipantRemove(socket, payload, callback) {
  const membership = hostMembership(socket)
  if (membership.error) return acknowledge(callback, { error: membership.error })
  const target = [...membership.room.participants.entries()].find(([, participant]) => participant.publicId === payload?.participantId)
  if (!target || target[1].role === 'Host') return acknowledge(callback, { error: 'Select a current non-Host participant to remove.' })
  const [targetId, participant] = target
  const removedSocket = participant.socketId ? io.sockets.sockets.get(participant.socketId) : null
  if (removedSocket) {
    removedSocket.emit('room:removed', { roomId: membership.room.id })
    removedSocket.data.roomId = undefined
    removedSocket.data.participantId = undefined
    removedSocket.leave(membership.room.id)
  }
  removeParticipant(membership.room, targetId)
  acknowledge(callback, { ok: true, participantId: participant.publicId, room: publicRoom(membership.room) })
}

function addParticipant(socket, room, id, username, role) {
  const participant = { publicId: randomBytes(12).toString('hex'), username, role, socketId: null, disconnectTimer: null }
  room.participants.set(id, participant)
  attachParticipant(socket, room, id, participant)
  publishUserEvent('user_joined', room, participant)
  publishSnapshot(room, socket)
  return participantResult(room, participant)
}

function detachUnlessSame(socket, room, id) {
  if (socket.data.roomId !== room.id || socket.data.participantId !== id) detachFromRoom(socket)
}

function handleCreate(socket, payload, callback) {
  const username = validateUsername(payload?.username)
  if (!username) return acknowledge(callback, { error: 'Enter a username (1–24 characters).' })
  detachFromRoom(socket)

  let id
  do { id = randomBytes(4).toString('hex').toUpperCase() } while (rooms.has(id) || closedRooms.has(id))
  const room = {
    id,
    hostToken: randomBytes(32).toString('hex'),
    participants: new Map(),
    videoState: { videoId: null, playing: false, currentTime: 0, updatedAt: Date.now() },
    chatMessages: [],
    queue: [],
  }
  rooms.set(id, room)
  const participant = addParticipant(socket, room, participantKey(payload?.participantId, socket), username, 'Host')
  acknowledge(callback, participant)
}

function handleJoin(socket, payload, callback) {
  const username = validateUsername(payload?.username)
  if (!username) return acknowledge(callback, { error: 'Enter a username (1–24 characters).' })
  if (typeof payload?.roomId !== 'string' || !payload.roomId.trim()) {
    return acknowledge(callback, { error: 'Enter a room ID.' })
  }
  const id = payload.roomId.trim().toUpperCase()
  const room = rooms.get(id)
  if (!room) return acknowledge(callback, { error: closedRooms.get(id)?.message || 'Room not found. Check the room ID and try again.' })

  const idKey = participantKey(payload.participantId, socket)
  const existing = room.participants.get(idKey)
  if (existing) {
    if (existing.role === 'Host' && payload?.hostToken !== room.hostToken) {
      return acknowledge(callback, { error: 'The Host session could not be verified.' })
    }
    detachUnlessSame(socket, room, idKey)
    const changedUsername = existing.username !== username
    existing.username = username
    const oldSocketId = existing.socketId
    attachParticipant(socket, room, idKey, existing)
    if (!oldSocketId || oldSocketId !== socket.id || changedUsername) publishSnapshot(room)
    publishSnapshot(room, socket)
    return acknowledge(callback, participantResult(room, existing))
  }

  detachFromRoom(socket)
  const participant = addParticipant(socket, room, idKey, username, 'Participant')
  acknowledge(callback, participant)
}

function handleSubscribe(socket, payload, callback) {
  const roomId = typeof payload === 'string' ? payload : payload?.roomId
  const idKey = participantKey(payload?.participantId ?? socket.data.participantId, socket)
  const room = rooms.get(roomId)
  const participant = room?.participants.get(idKey)
  if (!room || !participant) {
    return acknowledge(callback, { error: closedRooms.get(roomId)?.message || 'Room membership expired. Return home and join the room again.' })
  }
  if (participant.role === 'Host' && payload?.hostToken !== room.hostToken) {
    return acknowledge(callback, { error: 'The Host session could not be verified.' })
  }
  detachUnlessSame(socket, room, idKey)
  attachParticipant(socket, room, idKey, participant)
  publishSnapshot(room)
  acknowledge(callback, participantResult(room, participant))
}

function handleLeave(socket, roomId, callback) {
  if (!roomId || socket.data.roomId === roomId) detachFromRoom(socket)
  acknowledge(callback, { ok: true })
}

function markDisconnected(socket) {
  const room = rooms.get(socket.data.roomId)
  const idKey = socket.data.participantId
  const participant = room?.participants.get(idKey)
  if (!participant || participant.socketId !== socket.id) return

  participant.socketId = null
  participant.disconnectTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.id)
    if (currentRoom?.participants.get(idKey) === participant && !participant.socketId) {
      removeParticipant(currentRoom, idKey)
    }
  }, reconnectGraceMs)
  publishSnapshot(room)
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`)
  socket.on('room:create', (payload, callback) => handleCreate(socket, payload, callback))
  socket.on('room:join', (payload, callback) => handleJoin(socket, payload, callback))
  socket.on('room:subscribe', (payload, callback) => handleSubscribe(socket, payload, callback))
  socket.on('room:leave', (roomId, callback) => handleLeave(socket, roomId, callback))
  socket.on('chat:send', (payload, callback) => handleChatSend(socket, payload, callback))
  socket.on('queue:add', (payload, callback) => handleQueueAdd(socket, payload, callback))
  socket.on('queue:remove', (payload, callback) => handleQueueRemove(socket, payload, callback))
  socket.on('queue:next', (payload, callback) => handleQueueNext(socket, payload, callback))
  socket.on('participant:promote', (payload, callback) => handleParticipantPromote(socket, payload, callback))
  socket.on('participant:remove', (payload, callback) => handleParticipantRemove(socket, payload, callback))
  for (const event of ['change_video', 'play', 'pause', 'seek', 'sync_state']) {
    socket.on(event, (payload, callback) => handleVideoControl(socket, event, payload, callback))
  }
  socket.on('disconnect', () => {
    markDisconnected(socket)
    console.log(`Socket disconnected: ${socket.id}`)
  })
})

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '0.0.0.0', () => {
    console.log(`API and Socket.IO listening on port ${port}`)
  })
}

export { io, rooms, server }
