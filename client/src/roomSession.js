const participantStorageKey = 'youtube-watch-party:participant-id'
const roomStorageKey = 'youtube-watch-party:active-room'

function createParticipantId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function loadParticipantId() {
  try {
    let id = window.sessionStorage.getItem(participantStorageKey)
    if (!id) {
      id = createParticipantId()
      window.sessionStorage.setItem(participantStorageKey, id)
    }
    return id
  } catch {
    return createParticipantId()
  }
}

export const participantId = loadParticipantId()

export function saveRoomSession(roomId, participant, hostToken) {
  try {
    window.sessionStorage.setItem(roomStorageKey, JSON.stringify({ roomId, participant, hostToken: participant?.role === 'Host' ? hostToken : undefined }))
  } catch {
    // Router state still carries the membership for this page load.
  }
}

export function loadRoomSession(roomId) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(roomStorageKey) || 'null')
    return value?.roomId === roomId ? value : null
  } catch {
    return null
  }
}

export function clearRoomSession(roomId) {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(roomStorageKey) || 'null')
    if (!roomId || value?.roomId === roomId) window.sessionStorage.removeItem(roomStorageKey)
  } catch {
    window.sessionStorage.removeItem(roomStorageKey)
  }
}
