import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { io as connectSocket } from 'socket.io-client'

process.env.NODE_ENV = 'test'
const { io: serverIo, rooms, server } = await import('../src/index.js')
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const clients = []
const activeRoomIds = []

after(async () => {
  for (const activeRoomId of activeRoomIds) {
    for (const client of clients) {
      if (client.connected) await request(client, 'room:leave', activeRoomId)
    }
  }
  for (const client of clients) client.close()
  await new Promise((resolve) => serverIo.close(resolve))
  rooms.clear()
})

function connect() {
  const socket = connectSocket(origin, { reconnection: false, timeout: 3000 })
  clients.push(socket)
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result))
  })
}

function nextEvent(socket, name) {
  return new Promise((resolve) => socket.once(name, resolve))
}

function expectNoEvent(socket, name, durationMs = 80) {
  return new Promise((resolve, reject) => {
    const onEvent = (value) => { clearTimeout(timer); reject(new Error(`Unexpected ${name} event: ${JSON.stringify(value)}`)) }
    const timer = setTimeout(() => { socket.off(name, onEvent); resolve() }, durationMs)
    socket.on(name, onEvent)
  })
}

test('Host, Moderator, and Participant room permissions are enforced', async () => {
  const host = await connect()
  const moderator = await connect()
  const participant = await connect()
  const hostResult = await request(host, 'room:create', {
    username: 'Host', participantId: 'host-test-session', role: 'Participant',
  })
  activeRoomIds.push(hostResult.room.id)
  assert.equal(hostResult.participant.role, 'Host', 'server assigns the Host role')
  assert.ok(hostResult.hostToken)

  const moderatorJoin = await request(moderator, 'room:join', {
    username: 'Future moderator', roomId: hostResult.room.id,
    participantId: 'moderator-test-session', role: 'Moderator',
  })
  const participantJoin = await request(participant, 'room:join', {
    username: 'Participant', roomId: hostResult.room.id,
    participantId: 'participant-test-session', role: 'Host',
  })
  assert.equal(moderatorJoin.participant.role, 'Participant', 'join payload cannot assign a role')
  assert.equal(participantJoin.participant.role, 'Participant', 'join payload cannot assign a role')

  const moderatorSnapshot = nextEvent(moderator, 'room:participants')
  const participantSnapshot = nextEvent(participant, 'room:participants')
  const roleBroadcast = nextEvent(participant, 'participant:role_changed')
  const promotion = await request(host, 'participant:promote', { participantId: moderatorJoin.participant.id })
  assert.equal(promotion.participant.role, 'Moderator')
  assert.equal((await roleBroadcast).participant.role, 'Moderator')
  assert.equal((await moderatorSnapshot).participants.find((person) => person.id === moderatorJoin.participant.id).role, 'Moderator')
  assert.equal((await participantSnapshot).participants.find((person) => person.id === moderatorJoin.participant.id).role, 'Moderator')

  const videoId = 'dQw4w9WgXcQ'
  const changedEvent = nextEvent(participant, 'sync_state')
  assert.equal((await request(moderator, 'change_video', { videoId, currentTime: 0 })).ok, true)
  assert.equal((await changedEvent).videoId, videoId)
  const hostPlaySync = nextEvent(participant, 'sync_state')
  assert.equal((await request(host, 'play', { currentTime: 3 })).ok, true, 'Host playback remains authorized')
  assert.equal((await hostPlaySync).action, 'play')
  for (const [event, payload] of [
    ['play', { currentTime: 4 }],
    ['pause', { currentTime: 4 }],
    ['seek', { currentTime: 25 }],
    ['sync_state', { currentTime: 25, playing: true }],
  ]) {
    const sync = nextEvent(participant, 'sync_state')
    assert.equal((await request(moderator, event, payload)).ok, true, `Moderator ${event} should be accepted`)
    assert.equal((await sync).action, event)
  }

  const room = rooms.get(hostResult.room.id)
  room.queue.push({ id: 'queued-video', videoId: 'M7lc1UVf-VE', title: 'Next video', thumbnailUrl: null, addedBy: 'Host', addedAt: new Date().toISOString() })
  const nextQueue = nextEvent(participant, 'queue:update')
  const nextSync = nextEvent(participant, 'sync_state')
  const nextResult = await request(moderator, 'queue:next')
  assert.equal(nextResult.ok, true, 'Moderator can advance the shared video queue')
  assert.equal(nextResult.videoState.videoId, 'M7lc1UVf-VE')
  assert.deepEqual(await nextQueue, [])
  assert.equal((await nextSync).videoId, 'M7lc1UVf-VE')
  room.queue.push({ id: 'host-removable', videoId: 'abcDEF12345', title: 'Remove test', thumbnailUrl: null, addedBy: 'Host', addedAt: new Date().toISOString() })
  const removeQueueUpdate = nextEvent(participant, 'queue:update')
  assert.equal((await request(host, 'queue:remove', { id: 'host-removable' })).ok, true, 'Host can remove queue items')
  assert.deepEqual(await removeQueueUpdate, [])
  const resumeSync = nextEvent(participant, 'sync_state')
  assert.equal((await request(moderator, 'play', { currentTime: 1 })).ok, true)
  assert.equal((await resumeSync).playing, true)

  for (const event of ['change_video', 'play', 'pause', 'seek', 'sync_state']) {
    const denied = await request(participant, event, { videoId, currentTime: 33, playing: true, role: 'Moderator' })
    assert.match(denied.error, /Host or a Moderator/)
  }
  for (const socket of [moderator, participant]) {
    assert.match((await request(socket, 'participant:promote', { participantId: participantJoin.participant.id })).error, /Only the Host/)
    assert.match((await request(socket, 'participant:remove', { participantId: participantJoin.participant.id })).error, /Only the Host/)
    assert.match((await request(socket, 'queue:remove', { id: 'missing' })).error, /Only the Host/)
  }
  assert.match((await request(participant, 'queue:next')).error, /Host or a Moderator/)
  assert.match((await request(host, 'participant:promote', { participantId: hostResult.participant.id })).error, /current Participant/)

  const removedMessage = nextEvent(participant, 'room:removed')
  const removalBroadcast = nextEvent(host, 'user_left')
  const removed = await request(host, 'participant:remove', { participantId: participantJoin.participant.id })
  assert.equal(removed.ok, true)
  assert.equal((await removedMessage).roomId, hostResult.room.id)
  assert.equal((await removalBroadcast).participant.id, participantJoin.participant.id)
  assert.equal(removed.room.participants.some((person) => person.id === participantJoin.participant.id), false)

  for (const [event, payload] of [
    ['chat:send', { text: 'stale socket' }],
    ['queue:add', { videoId: 'aaaaaaaaaaa' }],
    ['participant:promote', { participantId: moderatorJoin.participant.id }],
    ['change_video', { videoId, currentTime: 0 }],
    ['play', { currentTime: 1 }],
  ]) {
    assert.ok((await request(participant, event, payload)).error, `Removed socket ${event} must require a fresh join`)
  }
  assert.ok((await request(participant, 'room:subscribe', {
    roomId: hostResult.room.id, participantId: 'participant-test-session',
  })).error, 'removed membership cannot be restored by subscribe')
  const freshJoin = await request(participant, 'room:join', {
    username: 'Participant', roomId: hostResult.room.id, participantId: 'participant-test-session',
  })
  assert.equal(freshJoin.participant.role, 'Participant', 'only a fresh join creates new membership')

  const oldModeratorDisconnected = nextEvent(moderator, 'disconnect')
  moderator.disconnect()
  await oldModeratorDisconnected
  await new Promise((resolve) => setTimeout(resolve, 30))
  const replacementModerator = await connect()
  const beforeReconnectCount = rooms.get(hostResult.room.id).participants.size
  const rejoinedModerator = await request(replacementModerator, 'room:subscribe', {
    roomId: hostResult.room.id, participantId: 'moderator-test-session',
  })
  assert.equal(rejoinedModerator.participant.id, promotion.participant.id)
  assert.equal(rejoinedModerator.participant.role, 'Moderator', 'reconnect restores server role, not submitted role')
  await oldModeratorDisconnected
  assert.equal(rooms.get(hostResult.room.id).participants.size, beforeReconnectCount, 'reconnect does not create a duplicate')
  assert.equal(rejoinedModerator.videoState.videoId, 'M7lc1UVf-VE', 'late join receives the current video')
  assert.equal(rejoinedModerator.videoState.playing, true, 'late join receives current playback state')
  const lateJoiner = await connect()
  const lateJoinResult = await request(lateJoiner, 'room:join', {
    username: 'Late guest', roomId: hostResult.room.id, participantId: 'late-join-test-session',
  })
  assert.equal(lateJoinResult.videoState.videoId, 'M7lc1UVf-VE')
  assert.equal(lateJoinResult.videoState.playing, true)

  const roomTwoHost = await connect()
  const roomTwo = await request(roomTwoHost, 'room:create', { username: 'Other host', participantId: 'other-room-host' })
  activeRoomIds.push(roomTwo.room.id)
  assert.notEqual(roomTwo.room.id, hostResult.room.id, 'active room IDs are unique')
  const roomOneMessage = nextEvent(participant, 'chat:message')
  const roomOneChat = await request(host, 'chat:send', { text: 'room one only' })
  assert.equal((await roomOneMessage).text, 'room one only', 'chat is broadcast to current room members')
  let crossRoomMessage = null
  const captureCrossRoomMessage = (message) => { crossRoomMessage = message }
  participant.on('chat:message', captureCrossRoomMessage)
  const roomTwoChat = await request(roomTwoHost, 'chat:send', { text: 'room two only' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  participant.off('chat:message', captureCrossRoomMessage)
  assert.equal(roomOneChat.ok, true)
  assert.equal(roomTwoChat.ok, true)
  assert.equal(crossRoomMessage, null, 'other-room chat is not broadcast across rooms')
  assert.deepEqual(rooms.get(hostResult.room.id).chatMessages.map((message) => message.text), ['room one only'])
  assert.deepEqual(rooms.get(roomTwo.room.id).chatMessages.map((message) => message.text), ['room two only'])
  const roomTwoGuest = await connect()
  const roomTwoHistory = await request(roomTwoGuest, 'room:join', {
    username: 'Second room guest', roomId: roomTwo.room.id, participantId: 'other-room-guest',
  })
  assert.deepEqual(roomTwoHistory.chatMessages.map((message) => message.text), ['room two only'])
})

test('queue:add uses the real handler and queue, video, and playback stay isolated by room', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ title: 'Mock queue video', thumbnail_url: 'https://example.test/thumb.jpg' }) })
  try {
    const hostOne = await connect()
    const guestOne = await connect()
    const hostTwo = await connect()
    const guestTwo = await connect()
    const first = await request(hostOne, 'room:create', { username: 'First host', participantId: 'queue-room-one-host' })
    const second = await request(hostTwo, 'room:create', { username: 'Second host', participantId: 'queue-room-two-host' })
    activeRoomIds.push(first.room.id, second.room.id)
    await request(guestOne, 'room:join', { username: 'First guest', roomId: first.room.id, participantId: 'queue-room-one-guest' })
    await request(guestTwo, 'room:join', { username: 'Second guest', roomId: second.room.id, participantId: 'queue-room-two-guest' })

    const queueOneUpdate = nextEvent(guestOne, 'queue:update')
    const noQueueInSecondRoom = expectNoEvent(guestTwo, 'queue:update')
    const added = await request(guestOne, 'queue:add', { videoId: 'M7lc1UVf-VE' })
    assert.equal(added.ok, true, 'a Participant can add a video to the shared queue')
    assert.equal(added.item.title, 'Mock queue video')
    assert.equal((await queueOneUpdate)[0].videoId, 'M7lc1UVf-VE')
    await noQueueInSecondRoom
    assert.equal(rooms.get(first.room.id).queue.length, 1)
    assert.deepEqual(rooms.get(second.room.id).queue, [])

    assert.match((await request(guestOne, 'queue:remove', { id: added.item.id })).error, /Only the Host/)
    assert.match((await request(guestOne, 'queue:next')).error, /Host or a Moderator/)
    const videoId = 'dQw4w9WgXcQ'
    for (const event of ['change_video', 'play', 'pause', 'seek', 'sync_state']) {
      assert.match((await request(guestOne, event, { videoId, currentTime: 3, playing: true })).error, /Host or a Moderator/)
    }
    const noVideoInSecondRoom = expectNoEvent(guestTwo, 'sync_state')
    const videoInFirstRoom = nextEvent(guestOne, 'sync_state')
    const changed = await request(hostOne, 'change_video', { videoId, currentTime: 0 })
    assert.equal(changed.ok, true, 'Host can select a video')
    assert.equal((await videoInFirstRoom).videoId, videoId)
    await noVideoInSecondRoom
    assert.equal(rooms.get(first.room.id).videoState.videoId, videoId)
    assert.equal(rooms.get(second.room.id).videoState.videoId, null)

    const noEchoToSender = expectNoEvent(hostOne, 'sync_state')
    const singlePeerSync = nextEvent(guestOne, 'sync_state')
    assert.equal((await request(hostOne, 'play', { currentTime: 2 })).ok, true)
    assert.equal((await singlePeerSync).action, 'play')
    await noEchoToSender
    await expectNoEvent(guestOne, 'sync_state')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Host departure transfers privileges once, and the replacement Host can reconnect and recover', async () => {
  const host = await connect()
  const successor = await connect()
  const observer = await connect()
  const created = await request(host, 'room:create', { username: 'Leaving host', participantId: 'handoff-host-session' })
  activeRoomIds.push(created.room.id)
  await request(successor, 'room:join', { username: 'Successor', roomId: created.room.id, participantId: 'handoff-successor-session' })
  const observerJoin = await request(observer, 'room:join', { username: 'Observer', roomId: created.room.id, participantId: 'handoff-observer-session' })

  const tokenEvent = nextEvent(successor, 'room:host_token')
  assert.equal((await request(host, 'room:leave', created.room.id)).ok, true)
  const newToken = await tokenEvent
  assert.equal(newToken.roomId, created.room.id)
  assert.notEqual(newToken.hostToken, created.hostToken, 'handoff rotates the Host token')
  let room = rooms.get(created.room.id)
  assert.equal([...room.participants.values()].filter((person) => person.role === 'Host').length, 1)
  assert.equal([...room.participants.values()].find((person) => person.publicId === observerJoin.participant.id).role, 'Participant')
  assert.ok((await request(host, 'play', { currentTime: 1 })).error, 'the departing socket loses playback authorization')

  assert.equal((await request(successor, 'participant:promote', { participantId: observerJoin.participant.id })).ok, true, 'the new Host receives Host privileges')
  const successorDisconnect = nextEvent(successor, 'disconnect')
  successor.disconnect()
  await successorDisconnect
  const recoveredHost = await connect()
  const recovered = await request(recoveredHost, 'room:subscribe', {
    roomId: created.room.id, participantId: 'handoff-successor-session', hostToken: newToken.hostToken,
  })
  assert.equal(recovered.participant.role, 'Host', 'Host role and room state survive reconnect')
  assert.equal(recovered.hostToken, newToken.hostToken)
  room = rooms.get(created.room.id)
  assert.equal([...room.participants.values()].filter((person) => person.role === 'Host').length, 1)
  assert.equal(room.participants.size, 2, 'reconnect restores the existing membership without duplicates')
  assert.ok((await request(host, 'room:subscribe', { roomId: created.room.id, participantId: 'handoff-host-session', hostToken: created.hostToken })).error, 'the old Host session cannot recover its removed role')
})

test('Host reconnects during the existing grace window, while a room with no connected successor closes clearly', async () => {
  const host = await connect()
  const guest = await connect()
  const created = await request(host, 'room:create', { username: 'Grace host', participantId: 'grace-host-session' })
  activeRoomIds.push(created.room.id)
  await request(guest, 'room:join', { username: 'Grace guest', roomId: created.room.id, participantId: 'grace-guest-session' })
  const disconnected = nextEvent(host, 'disconnect')
  host.disconnect()
  await disconnected
  const reconnectedHost = await connect()
  const recovered = await request(reconnectedHost, 'room:subscribe', {
    roomId: created.room.id, participantId: 'grace-host-session', hostToken: created.hostToken,
  })
  assert.equal(recovered.participant.role, 'Host', 'the current Host recovers within 20 seconds')
  assert.equal([...rooms.get(created.room.id).participants.values()].filter((person) => person.role === 'Host').length, 1)

  const closingHost = await connect()
  const disconnectedGuest = await connect()
  const closingRoom = await request(closingHost, 'room:create', { username: 'Closing host', participantId: 'closing-host-session' })
  activeRoomIds.push(closingRoom.room.id)
  await request(disconnectedGuest, 'room:join', { username: 'Offline guest', roomId: closingRoom.room.id, participantId: 'closing-guest-session' })
  const guestDisconnected = nextEvent(disconnectedGuest, 'disconnect')
  disconnectedGuest.disconnect()
  await guestDisconnected
  assert.equal((await request(closingHost, 'room:leave', closingRoom.room.id)).ok, true)
  assert.equal(rooms.has(closingRoom.room.id), false, 'room closes when there is no connected successor')
  const laterJoiner = await connect()
  const closed = await request(laterJoiner, 'room:join', { username: 'Late guest', roomId: closingRoom.room.id, participantId: 'closing-late-guest' })
  assert.match(closed.error, /room closed because the Host left/i, 'invitees receive the room closure reason')
})
