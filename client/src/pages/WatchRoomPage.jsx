import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { clearRoomSession, loadRoomSession, participantId, saveRoomSession } from '../roomSession.js'
import { extractYoutubeVideoId, loadYoutubeIframeApi } from '../youtubeIframeApi.js'

function Icon({ name }) {
  const paths = {
    play: <path d="m8 5 10 7-10 7z" />, pause: <path d="M8 5v14M16 5v14" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="4" /><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    chat: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" /></>,
  }
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function initials(name = '') { return name.trim().slice(0, 1).toUpperCase() || '?' }

function storedLocalAudio() {
  try {
    const volume = Number(window.sessionStorage.getItem('watch-party-volume'))
    return {
      volume: Number.isFinite(volume) && volume >= 0 && volume <= 100 ? volume : 100,
      muted: window.sessionStorage.getItem('watch-party-muted') === 'true',
    }
  } catch {
    return { volume: 100, muted: false }
  }
}

export default function WatchRoomPage({ socket, connection }) {
  const { roomId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const restoredSession = loadRoomSession(roomId)
  const initialRoom = location.state?.room || (restoredSession ? { id: roomId, participants: [] } : null)
  const [room, setRoom] = useState(initialRoom)
  const [participant, setParticipant] = useState(location.state?.participant || restoredSession?.participant || null)
  const [videoUrl, setVideoUrl] = useState('')
  const [activeVideoId, setActiveVideoId] = useState('')
  const [playerStatus, setPlayerStatus] = useState('idle')
  const [localVolume, setLocalVolume] = useState(() => storedLocalAudio().volume)
  const [localMuted, setLocalMuted] = useState(() => storedLocalAudio().muted)
  const [videoError, setVideoError] = useState('')
  const [copyLabel, setCopyLabel] = useState('Copy invite link')
  const [inviteUsername, setInviteUsername] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinPending, setJoinPending] = useState(false)
  const [roomError, setRoomError] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatError, setChatError] = useState('')
  const [chatPending, setChatPending] = useState(false)
  const [queue, setQueue] = useState([])
  const [queueInput, setQueueInput] = useState('')
  const [queueError, setQueueError] = useState('')
  const [queuePending, setQueuePending] = useState(false)
  const pendingLeaveRef = useRef(null)
  const pageUnloadingRef = useRef(false)
  const playerMountRef = useRef(null)
  const playerRef = useRef(null)
  const playerCreationRef = useRef(null)
  const playerReadyRef = useRef(false)
  const localAudioRef = useRef({ volume: localVolume, muted: localMuted })
  const localAudioNeedsRestoreRef = useRef(false)
  const localAudioRestoreTimerRef = useRef(null)
  const playerLoadRef = useRef(0)
  const pendingVideoStateRef = useRef(null)
  const remoteApplyRef = useRef(false)
  const remoteApplyTimerRef = useRef(null)
  const currentPlayerVideoRef = useRef('')
  const lastHostActionRef = useRef('')
  const lastHostTimeRef = useRef({ time: 0, at: 0 })
  const chatListRef = useRef(null)
  const isHost = participant?.role === 'Host'
  const canControlPlayback = isHost || participant?.role === 'Moderator'
  const playerControlsRef = useRef(canControlPlayback)
  const canControlPlaybackRef = useRef(canControlPlayback)
  canControlPlaybackRef.current = canControlPlayback

  function saveLocalAudio(volume, muted) {
    const next = {
      volume: Math.max(0, Math.min(100, Math.round(volume))),
      muted: Boolean(muted),
    }
    localAudioRef.current = next
    setLocalVolume(next.volume)
    setLocalMuted(next.muted)
    try {
      window.sessionStorage.setItem('watch-party-volume', String(next.volume))
      window.sessionStorage.setItem('watch-party-muted', String(next.muted))
    } catch {
      // Audio settings still work for this player if storage is unavailable.
    }
  }

  function captureLocalAudio(player = playerRef.current) {
    if (localAudioNeedsRestoreRef.current) return localAudioRef.current
    if (!player?.getVolume || !player?.isMuted) return localAudioRef.current
    const volume = player.getVolume()
    const muted = player.isMuted()
    if (Number.isFinite(volume) && (Math.abs(volume - localAudioRef.current.volume) > 1 || muted !== localAudioRef.current.muted)) {
      saveLocalAudio(volume, muted)
    }
    return localAudioRef.current
  }

  function restoreLocalAudio(player = playerRef.current) {
    if (!player?.setVolume || !player?.isMuted) return
    const { volume, muted } = localAudioRef.current
    if (Math.abs((player.getVolume?.() ?? volume) - volume) > 1) player.setVolume(volume)
    if (muted && !player.isMuted()) player.mute()
    else if (!muted && player.isMuted()) player.unMute()
  }

  function changeLocalVolume(value) {
    const volume = Number(value)
    saveLocalAudio(volume, localAudioRef.current.muted)
    playerRef.current?.setVolume?.(volume)
  }

  function toggleLocalMute() {
    const muted = !localAudioRef.current.muted
    saveLocalAudio(localAudioRef.current.volume, muted)
    if (muted) playerRef.current?.mute?.()
    else playerRef.current?.unMute?.()
  }

  function emitHostControl(event, payload) {
    if (!canControlPlaybackRef.current || !socket?.connected) return
    socket.timeout(5000).emit(event, payload, (timeoutError, result) => {
      if (timeoutError || result?.error) setVideoError(result?.error || 'The server did not confirm the playback update.')
    })
  }

  function applyVideoState(state) {
    if (!state || (state.videoId && !/^[a-zA-Z0-9_-]{11}$/.test(state.videoId))) return
    pendingVideoStateRef.current = state
    if (!state.videoId) return
    setActiveVideoId(state.videoId)
    setPlayerStatus('loading')
    setVideoError('')
    const player = playerRef.current
    if (!player || !playerReadyRef.current || !player.getIframe?.()) return
    remoteApplyRef.current = true
    window.clearTimeout(remoteApplyTimerRef.current)
    remoteApplyTimerRef.current = window.setTimeout(() => { remoteApplyRef.current = false }, 1800)
    if (currentPlayerVideoRef.current !== state.videoId) {
      captureLocalAudio(player)
      localAudioNeedsRestoreRef.current = true
      currentPlayerVideoRef.current = state.videoId
      const options = { videoId: state.videoId, startSeconds: Math.max(0, state.currentTime || 0) }
      if (state.playing) player.loadVideoById(options)
      else player.cueVideoById(options)
      restoreLocalAudio(player)
      window.clearTimeout(localAudioRestoreTimerRef.current)
      localAudioRestoreTimerRef.current = window.setTimeout(() => {
        restoreLocalAudio(player)
        localAudioNeedsRestoreRef.current = false
      }, 1200)
      return
    }
    const targetTime = Math.max(0, state.currentTime || 0)
    const shouldSeek = Math.abs((player.getCurrentTime?.() || 0) - targetTime) > 1.25
    const playerState = player.getPlayerState?.()
    const shouldPlay = state.playing && playerState !== 1 && playerState !== 3
    const shouldPause = !state.playing && playerState !== 2
    if (shouldSeek || shouldPlay || shouldPause) {
      if (shouldSeek) player.seekTo(targetTime, true)
      if (shouldPlay) player.playVideo()
      if (shouldPause) player.pauseVideo()
    }
    setPlayerStatus('ready')
  }

  async function rebuildPlayerForRole() {
    const player = playerRef.current
    if (!player || !playerReadyRef.current || playerControlsRef.current === canControlPlaybackRef.current) return
    captureLocalAudio(player)
    const state = {
      ...(pendingVideoStateRef.current || {}),
      videoId: activeVideoId || currentPlayerVideoRef.current,
      currentTime: player.getCurrentTime?.() || 0,
      playing: player.getPlayerState?.() === 1,
      updatedAt: Date.now(),
    }
    if (!state.videoId) return
    player.destroy()
    playerRef.current = null
    playerReadyRef.current = false
    currentPlayerVideoRef.current = ''
    pendingVideoStateRef.current = state
    setPlayerStatus('loading')
    try { await ensurePlayer(state.videoId, state) }
    catch (error) { setPlayerStatus('error'); setVideoError(error.message || 'Could not reload the YouTube player.') }
  }

  async function ensurePlayer(videoId, state) {
    if (playerRef.current) { applyVideoState(state); return }
    if (playerCreationRef.current) {
      await playerCreationRef.current
      applyVideoState(state)
      return
    }
    const creation = (async () => {
      const YT = await loadYoutubeIframeApi()
      if (playerRef.current) return
      if (!playerMountRef.current) throw new Error('The player area is not available. Try again.')
      const mount = document.createElement('div')
      playerMountRef.current.replaceChildren(mount)
      playerControlsRef.current = canControlPlaybackRef.current
      playerRef.current = new YT.Player(mount, {
        width: '100%', height: '100%', videoId,
        playerVars: { playsinline: 1, rel: 0, enablejsapi: 1, origin: window.location.origin, controls: canControlPlaybackRef.current ? 1 : 0, disablekb: canControlPlaybackRef.current ? 0 : 1 },
        events: {
          onReady: () => {
            playerReadyRef.current = true
            restoreLocalAudio(playerRef.current)
            setPlayerStatus('ready')
            if (playerControlsRef.current !== canControlPlaybackRef.current) {
              rebuildPlayerForRole()
              return
            }
            if (pendingVideoStateRef.current) applyVideoState(pendingVideoStateRef.current)
          },
          onStateChange: (event) => {
            if (event.data === 3) setPlayerStatus('loading')
            else if ([0, 1, 2, 5].includes(event.data)) setPlayerStatus('ready')
            if (localAudioNeedsRestoreRef.current) {
              restoreLocalAudio(playerRef.current)
              if ([0, 1, 2, 5].includes(event.data)) {
                localAudioNeedsRestoreRef.current = false
                window.clearTimeout(localAudioRestoreTimerRef.current)
              }
            } else if (!remoteApplyRef.current) {
              // The Host can also use YouTube's native controls; capture any
              // local volume change before handling its resulting player event.
              captureLocalAudio(playerRef.current)
            }
            if (!canControlPlaybackRef.current || remoteApplyRef.current || !playerRef.current) return
            const action = event.data === 1 ? 'play' : event.data === 2 ? 'pause' : null
            if (!action || lastHostActionRef.current === action) return
            lastHostActionRef.current = action
            emitHostControl(action, { currentTime: playerRef.current.getCurrentTime() || 0 })
          },
          onError: (event) => onPlayerError(event.data),
        },
      })
      currentPlayerVideoRef.current = videoId
      pendingVideoStateRef.current = state
    })()
    playerCreationRef.current = creation
    try { await creation } finally { if (playerCreationRef.current === creation) playerCreationRef.current = null }
  }

  useEffect(() => {
    rebuildPlayerForRole()
  }, [canControlPlayback, activeVideoId])

  useEffect(() => {
    if (!canControlPlayback || !activeVideoId || !playerRef.current) return undefined
    let previous = { time: playerRef.current.getCurrentTime?.() || 0, at: Date.now() }
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player || remoteApplyRef.current) return
      const now = Date.now()
      const time = player.getCurrentTime?.()
      if (!Number.isFinite(time)) return
      const state = player.getPlayerState?.()
      const expected = previous.time + (state === 1 ? (now - previous.at) / 1000 : 0)
      if (Math.abs(time - expected) > 1.5) {
        emitHostControl('seek', { currentTime: time })
        lastHostTimeRef.current = { time, at: now }
      } else if (now - lastHostTimeRef.current.at > 5000) {
        emitHostControl('sync_state', { currentTime: time, playing: state === 1 || (state === 3 && lastHostActionRef.current === 'play') })
        lastHostTimeRef.current = { time, at: now }
      }
      previous = { time, at: now }
    }, 500)
    return () => window.clearInterval(timer)
  }, [canControlPlayback, activeVideoId, socket])

  useEffect(() => {
    if (!activeVideoId || playerStatus !== 'ready') return undefined
    const timer = window.setInterval(() => captureLocalAudio(), 400)
    return () => window.clearInterval(timer)
  }, [activeVideoId, playerStatus])

  useEffect(() => {
    if (canControlPlayback || !activeVideoId || playerStatus !== 'ready') return undefined
    const timer = window.setInterval(() => {
      const player = playerRef.current
      const state = pendingVideoStateRef.current
      if (!player || !state?.videoId || state.videoId !== activeVideoId) return
      const expectedTime = state.currentTime + (state.playing ? Math.max(0, (Date.now() - state.updatedAt) / 1000) : 0)
      const playerState = player.getPlayerState?.()
      const time = player.getCurrentTime?.()
      if (!Number.isFinite(time)) return
      const shouldPlay = state.playing && playerState !== 1 && playerState !== 3
      const shouldPause = !state.playing && playerState !== 2 && playerState !== 5
      if (Math.abs(time - expectedTime) <= 1.25 && !shouldPlay && !shouldPause) return
      remoteApplyRef.current = true
      window.clearTimeout(remoteApplyTimerRef.current)
      remoteApplyTimerRef.current = window.setTimeout(() => { remoteApplyRef.current = false }, 1800)
      if (Math.abs(time - expectedTime) > 1.25) player.seekTo(expectedTime, true)
      if (shouldPlay) player.playVideo()
      if (shouldPause) player.pauseVideo()
    }, 300)
    return () => window.clearInterval(timer)
  }, [canControlPlayback, activeVideoId, playerStatus])

  useEffect(() => {
    if (chatListRef.current) chatListRef.current.scrollTop = chatListRef.current.scrollHeight
  }, [chatMessages])

  useEffect(() => () => {
    playerLoadRef.current += 1
    window.clearTimeout(remoteApplyTimerRef.current)
    window.clearTimeout(localAudioRestoreTimerRef.current)
    playerRef.current?.destroy()
    playerRef.current = null
    playerReadyRef.current = false
  }, [])

  useEffect(() => {
    const markPageExit = () => { pageUnloadingRef.current = true }
    const markPageReturn = () => { pageUnloadingRef.current = false }
    window.addEventListener('pagehide', markPageExit)
    window.addEventListener('pageshow', markPageReturn)
    return () => {
      window.removeEventListener('pagehide', markPageExit)
      window.removeEventListener('pageshow', markPageReturn)
    }
  }, [])

  useEffect(() => {
    if (!participant || !socket) return undefined
    if (pendingLeaveRef.current?.roomId === roomId) {
      window.clearTimeout(pendingLeaveRef.current.timer)
      pendingLeaveRef.current = null
    }
    let active = true
    const applyRoomUpdate = (update) => {
      const updateId = update?.roomId || update?.id
      if (updateId === roomId && Array.isArray(update.participants)) {
        setRoom({ id: updateId, participants: update.participants })
        const currentParticipant = update.participants.find((person) => person.id === participant?.id)
        if (currentParticipant && currentParticipant.role !== participant?.role) {
          setParticipant((current) => current ? { ...current, role: currentParticipant.role } : current)
        }
      }
    }
    const onRemoved = (event) => {
      if (event?.roomId !== roomId) return
      clearRoomSession(roomId)
      setParticipant(null)
      setRoomError('You were removed from this room.')
      navigate('/')
    }
    const onRoomClosed = (event) => {
      if (event?.roomId !== roomId) return
      clearRoomSession(roomId)
      setParticipant(null)
      setRoomError(event.message || 'This room was closed by its Host.')
    }
    const onHostToken = (event) => {
      if (event?.roomId !== roomId || typeof event.hostToken !== 'string') return
      setParticipant((current) => {
        if (!current) return current
        const promoted = { ...current, role: 'Host' }
        saveRoomSession(roomId, promoted, event.hostToken)
        return promoted
      })
    }
    const onVideoSync = (state) => {
      applyVideoState(state)
      if (state?.videoId && !playerRef.current) {
        ensurePlayer(state.videoId, state).catch((error) => {
          setPlayerStatus('error')
          setVideoError(error.message || 'Could not load the YouTube player.')
        })
      }
    }
    const onChatMessage = (message) => {
      setChatMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100))
    }
    const onQueueUpdate = (nextQueue) => {
      if (Array.isArray(nextQueue)) setQueue(nextQueue)
    }
    const subscribe = () => {
      if (!socket.connected) return
      socket.timeout(8000).emit('room:subscribe', { roomId, participantId, hostToken: restoredSession?.hostToken }, (timeoutError, result) => {
        if (!active) return
        if (timeoutError) {
          setRoomError('The room server did not respond. Reconnecting…')
          return
        }
        if (result?.error) {
          setRoomError(result.error)
          clearRoomSession(roomId)
          setParticipant(null)
          return
        }
        setRoom(result.room)
        setParticipant(result.participant)
        setChatMessages((current) => [...new Map([...(result.chatMessages || []), ...current].map((message) => [message.id, message])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-100))
        setQueue(result.queue || [])
        if (result.videoState?.videoId) {
          applyVideoState(result.videoState)
          ensurePlayer(result.videoState.videoId, result.videoState).catch((error) => {
            setPlayerStatus('error')
            setVideoError(error.message || 'Could not load the YouTube player.')
          })
        }
        saveRoomSession(roomId, result.participant, result.hostToken)
        setRoomError('')
      })
    }
    socket.on('room:participants', applyRoomUpdate)
    socket.on('room:removed', onRemoved)
    socket.on('room:closed', onRoomClosed)
    socket.on('room:host_token', onHostToken)
    socket.on('user_joined', applyRoomUpdate)
    socket.on('user_left', applyRoomUpdate)
    socket.on('sync_state', onVideoSync)
    socket.on('chat:message', onChatMessage)
    socket.on('queue:update', onQueueUpdate)
    socket.on('connect', subscribe)
    if (socket.connected) subscribe()
    return () => {
      active = false
      socket.off('room:participants', applyRoomUpdate)
      socket.off('room:removed', onRemoved)
      socket.off('room:closed', onRoomClosed)
      socket.off('room:host_token', onHostToken)
      socket.off('user_joined', applyRoomUpdate)
      socket.off('user_left', applyRoomUpdate)
      socket.off('sync_state', onVideoSync)
      socket.off('chat:message', onChatMessage)
      socket.off('queue:update', onQueueUpdate)
      socket.off('connect', subscribe)
      // A real route exit leaves. Strict Mode replay cancels this next-tick
      // action, while a page refresh relies on the disconnect grace/rejoin.
      if (pageUnloadingRef.current) return
      const timer = window.setTimeout(() => {
        if (pendingLeaveRef.current?.timer === timer) pendingLeaveRef.current = null
        if (socket.connected) socket.emit('room:leave', roomId)
        clearRoomSession(roomId)
      }, 0)
      pendingLeaveRef.current = { roomId, timer }
    }
  }, [socket, roomId, participant?.id, participant?.username, participant?.role, navigate])

  useEffect(() => {
    if (connection === 'disconnected' && participant) {
      setRoomError('Connection lost. Trying to restore your room membership…')
    }
  }, [connection, participant?.username])

  function joinFromInvite(event) {
    event.preventDefault()
    setJoinError('')
    const username = inviteUsername.trim()
    if (!username || username.length > 24) {
      setJoinError('Enter a username between 1 and 24 characters.')
      return
    }
    if (!socket?.connected) {
      setJoinError('Connecting to the server… Please try again in a moment.')
      return
    }
    setJoinPending(true)
    socket.timeout(8000).emit('room:join', { username, roomId, participantId, hostToken: restoredSession?.hostToken }, (timeoutError, result) => {
      setJoinPending(false)
      if (timeoutError) return setJoinError('The server did not respond. Check your connection and try again.')
      if (result?.error) return setJoinError(result.error)
      setRoom(result.room)
      setParticipant(result.participant)
      setChatMessages((current) => [...new Map([...(result.chatMessages || []), ...current].map((message) => [message.id, message])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-100))
      setQueue(result.queue || [])
      if (result.videoState?.videoId) {
        applyVideoState(result.videoState)
        ensurePlayer(result.videoState.videoId, result.videoState).catch((error) => {
          setPlayerStatus('error')
          setVideoError(error.message || 'Could not load the YouTube player.')
        })
      }
      saveRoomSession(result.room.id, result.participant, result.hostToken)
      setRoomError('')
      navigate(`/room/${result.room.id}`, { replace: true, state: { room: result.room, participant: result.participant } })
    })
  }

  function onPlayerError(errorCode) {
    const messages = {
      2: 'YouTube rejected this video ID. Check the URL and try again.',
      5: 'This video could not be played in the embedded player. Try another video.',
      100: 'This video is unavailable, private, or has been removed.',
      101: 'The video owner does not allow playback in embedded players.',
      150: 'The video owner does not allow playback in embedded players.',
      153: 'YouTube could not verify this embedded player. Check the page origin and try again.',
    }
    setPlayerStatus('error')
    setVideoError(messages[errorCode] || 'YouTube could not load this video. Try another public, embeddable video.')
  }

  function sendChat(event) {
    event.preventDefault()
    const text = chatInput.trim()
    setChatError('')
    if (!text) return setChatError('Write a message first.')
    if (text.length > 1000) return setChatError('Messages can be up to 1000 characters.')
    if (!socket?.connected) return setChatError('Reconnect to the server before sending a message.')
    setChatPending(true)
    socket.timeout(5000).emit('chat:send', { text }, (timeoutError, result) => {
      setChatPending(false)
      if (timeoutError || result?.error) return setChatError(result?.error || 'The message was not sent. Try again.')
      setChatInput('')
    })
  }

  function addQueueVideo(event) {
    event.preventDefault()
    setQueueError('')
    const videoId = extractYoutubeVideoId(queueInput)
    if (!videoId) return setQueueError('Enter a valid YouTube watch, youtu.be, or Shorts URL.')
    if (!socket?.connected) return setQueueError('Reconnect to the server before adding a video.')
    setQueuePending(true)
    socket.timeout(7000).emit('queue:add', { videoId }, (timeoutError, result) => {
      setQueuePending(false)
      if (timeoutError || result?.error) return setQueueError(result?.error || 'The video was not added. Try again.')
      setQueueInput('')
    })
  }

  function removeQueueVideo(id) {
    setQueueError('')
    socket.timeout(5000).emit('queue:remove', { id }, (timeoutError, result) => {
      if (timeoutError || result?.error) setQueueError(result?.error || 'Could not remove that queue item.')
    })
  }

  function promoteParticipant(id) {
    socket.timeout(5000).emit('participant:promote', { participantId: id }, (timeoutError, result) => {
      if (timeoutError || result?.error) setRoomError(result?.error || 'Could not promote that participant.')
    })
  }

  function removeRoomParticipant(id) {
    socket.timeout(5000).emit('participant:remove', { participantId: id }, (timeoutError, result) => {
      if (timeoutError || result?.error) setRoomError(result?.error || 'Could not remove that participant.')
    })
  }

  function playNextVideo() {
    setQueueError('')
    socket.timeout(5000).emit('queue:next', {}, (timeoutError, result) => {
      if (timeoutError || result?.error) setQueueError(result?.error || 'Could not play the next video.')
      else {
        setActiveVideoId(result.videoState.videoId)
        setVideoUrl('')
        setPlayerStatus('loading')
        setVideoError('')
      }
    })
  }

  async function addVideo(event) {
    event.preventDefault()
    setVideoError('')
    if (!canControlPlayback) return
    const videoId = extractYoutubeVideoId(videoUrl)
    if (!videoId) {
      setVideoError('Enter a valid YouTube watch, youtu.be, or Shorts URL.')
      return
    }

    if (!socket?.connected) {
      setVideoError('Reconnect to the server before changing the room video.')
      return
    }
    const loadId = ++playerLoadRef.current
    setPlayerStatus('loading')
    try {
      await loadYoutubeIframeApi()
      if (loadId !== playerLoadRef.current) return
      socket.timeout(5000).emit('change_video', { videoId, currentTime: 0 }, async (timeoutError, result) => {
        if (timeoutError || result?.error) {
          setPlayerStatus('error')
          setVideoError(result?.error || 'The server did not confirm the video change.')
          return
        }
        setActiveVideoId(videoId)
        setVideoError('')
        lastHostActionRef.current = 'pause'
        currentPlayerVideoRef.current = ''
        pendingVideoStateRef.current = result.videoState
        try { await ensurePlayer(videoId, result.videoState) }
        catch (error) { setPlayerStatus('error'); setVideoError(error.message || 'Could not load the YouTube player.') }
      })
    } catch (error) {
      if (loadId !== playerLoadRef.current) return
      setPlayerStatus('error')
      setVideoError(error.message || 'Could not load the YouTube player. Try again.')
    }
  }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(window.location.href); setCopyLabel('Link copied!') }
    catch { setCopyLabel('Copy unavailable') }
    window.setTimeout(() => setCopyLabel('Copy invite link'), 1800)
  }
  const participants = room?.participants || []
  if (!participant) return <main className="room-page">
    <div className="room-topline"><Link to="/" className="back-link">← <span>Back home</span></Link><span className="preview-mode"><i /> ROOM INVITE</span></div>
    <section className="invite-join-card"><span className="eyebrow">YOU’VE BEEN INVITED</span><h1>Join this watch room</h1><p>Room ID <strong>{roomId}</strong></p>{roomError && <p className="room-error" role="alert">{roomError}</p>}<form onSubmit={joinFromInvite} noValidate><label className="field-label" htmlFor="invite-username">YOUR NAME</label><input id="invite-username" className="text-input" value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value)} placeholder="e.g. Sam" maxLength={24} autoComplete="nickname" /><button className="primary-button" type="submit" disabled={joinPending || !socket?.connected}>{joinPending ? 'Joining room…' : 'Join room'} {!joinPending && <Icon name="play" />}</button><p className="card-footnote" aria-live="polite">{joinError || 'You’ll join as a participant.'}</p></form></section>
  </main>

  return <main className="room-page">
    <div className="room-topline"><Link to="/" className="back-link">← <span>Leave room</span></Link><span className="preview-mode"><i /> LIVE ROOM · {participants.length} HERE</span></div>
    {roomError && <div className="room-error room-banner" role="alert">{roomError} <Link to="/">Return home</Link></div>}
    <section className="room-heading"><div><span className="eyebrow">YOUR WATCH SPACE</span><h1>Watch <span>together.</span></h1><p className="room-current-user">You’re here as <strong>{participant.username}</strong> <span className={`role-badge ${participant.role.toLowerCase()}`}>{participant.role}</span></p></div><div className="room-share"><div className="room-id-block"><span>ROOM ID</span><strong>{room?.id || roomId}</strong></div><button type="button" className="copy-button" onClick={copyInvite}><Icon name="copy" />{copyLabel}</button></div></section>
    <div className="room-layout">
      <section className="room-main-column">
        <div className={`player-frame ${activeVideoId ? 'has-youtube-video' : ''} ${isHost ? 'is-host' : 'is-participant'}`}>
          <div ref={playerMountRef} className="youtube-player-mount" />
          {activeVideoId && !canControlPlayback && <div className="participant-player-shield" aria-hidden="true" />}
          {!activeVideoId && <><div className="player-empty"><div className="player-logo"><span /></div><span className="player-overline">THE BIG SCREEN</span><h2>Your next favorite<br />video goes here.</h2><p>Paste a YouTube link below to get started.</p></div><div className="player-corner"><span className="corner-dot" /> NO VIDEO LOADED</div></>}
          {activeVideoId && playerStatus === 'loading' && <div className="player-load-label" aria-live="polite">Loading YouTube video…</div>}
          {activeVideoId && playerStatus === 'error' && <div className="player-load-label player-load-error" role="alert">Video could not be loaded</div>}
        </div>
        <div className="local-audio-controls" aria-label="Local player audio controls">
          <button type="button" onClick={toggleLocalMute} disabled={!activeVideoId || !playerReadyRef.current} aria-pressed={localMuted}>{localMuted ? 'Unmute' : 'Mute'}</button>
          <label htmlFor="local-player-volume">Volume</label>
          <input id="local-player-volume" type="range" min="0" max="100" value={localVolume} onChange={(event) => changeLocalVolume(event.target.value)} disabled={!activeVideoId || !playerReadyRef.current} aria-valuetext={`${localMuted ? 'Muted, ' : ''}${localVolume}%`} />
          <span>{localMuted ? 'Muted' : `${localVolume}%`}</span>
        </div>
        <form className="video-entry" onSubmit={addVideo} noValidate>
          <div><span className="eyebrow">{activeVideoId ? 'CURRENT VIDEO' : 'UP NEXT'}</span><strong>{activeVideoId ? `Video ID · ${activeVideoId}` : 'Add a YouTube video'}</strong></div>
          <div className="video-input-wrap"><input aria-label="YouTube URL" placeholder={canControlPlayback ? 'Paste a YouTube URL or Shorts link' : 'Only the Host or a Moderator can select a video'} value={videoUrl} onChange={(event) => { setVideoUrl(event.target.value); setVideoError('') }} disabled={!canControlPlayback || playerStatus === 'loading'} /><button type="submit" disabled={!canControlPlayback || playerStatus === 'loading'}>{playerStatus === 'loading' ? 'Loading…' : activeVideoId ? 'Load new video' : 'Add video'} <Icon name="play" /></button></div>
          {videoError && <p className="video-error" role="alert">{videoError}</p>}
          {!canControlPlayback && <p className="video-helper">The Host or a Moderator selects and controls the room video.</p>}
        </form>
        <section className="side-panel queue-panel" aria-labelledby="queue-title">
          <div className="panel-heading"><div><h2 id="queue-title">Up Next</h2></div><span className="people-count">{String(queue.length).padStart(2, '0')}</span></div>
          <form className="queue-form" onSubmit={addQueueVideo} noValidate>
            <input aria-label="YouTube URL to add to queue" value={queueInput} onChange={(event) => { setQueueInput(event.target.value); setQueueError('') }} placeholder="Add a YouTube link to the queue" />
            <button type="submit" disabled={queuePending || !socket?.connected}>{queuePending ? 'Adding…' : 'Add'}</button>
          </form>
          {queueError && <p className="queue-error" role="alert">{queueError}</p>}
          {queue.length === 0 ? <p className="panel-subtitle queue-empty">The queue is empty. Add a video for the room.</p> : <div className="queue-list">
            {queue.map((item, index) => <article className="queue-item" key={item.id}>
              {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span className="queue-thumbnail-fallback">▶</span>}
              <div className="queue-item-info"><strong>{item.title}</strong><span>Added by {item.addedBy}</span></div>
              {isHost && <button type="button" className="queue-remove" onClick={() => removeQueueVideo(item.id)} aria-label={`Remove ${item.title} from queue`}>×</button>}
            </article>)}
          </div>}
          {canControlPlayback && <button type="button" className="queue-next-button" onClick={playNextVideo} disabled={queue.length === 0 || !socket?.connected}>Play next video <Icon name="play" /></button>}
        </section>
        <div className="controls-note"><span>ⓘ</span> Host and Moderator playback is synchronized with the room.</div>
      </section>
      <aside className="room-sidebar">
        <section className="side-panel participants-panel"><div className="panel-heading"><div><Icon name="users" /><h2>People here</h2></div><span className="people-count">{String(participants.length).padStart(2, '0')}</span></div><p className="panel-subtitle">A little company goes a long way.</p><div className="people-list">{participants.map((person, index) => <div className="person-row" key={person.id}><span className={`avatar person-avatar avatar-${person.role === 'Host' ? 'mint' : ['peach', 'lilac', 'blue'][index % 3]}`}>{initials(person.username)}</span><div className="person-info"><strong>{person.username}{person.id === participant.id ? ' (you)' : ''}</strong><span>{person.connected === false ? 'Reconnecting…' : person.role === 'Host' ? 'Room host' : person.role}</span></div><span className={`role-badge ${person.role.toLowerCase()}`}>{person.role}</span>{isHost && person.role !== 'Host' && <div className="person-management-actions">{person.role === 'Participant' && <button type="button" onClick={() => promoteParticipant(person.id)} aria-label={`Promote ${person.username} to Moderator`}>Promote</button>}<button type="button" onClick={() => removeRoomParticipant(person.id)} aria-label={`Remove ${person.username} from room`}>Remove</button></div>}</div>)}</div>{participants.length === 0 && <p className="panel-subtitle">No participants are connected.</p>}</section>
        <section className="side-panel chat-panel"><div className="panel-heading"><div><Icon name="chat" /><h2>Room chat</h2></div><span className="chat-preview-tag">LIVE</span></div>
          <div className="chat-list" ref={chatListRef} aria-live="polite" aria-label="Room messages">
            {chatMessages.length === 0 ? <div className="chat-empty"><span className="chat-bubble-icon"><Icon name="chat" /></span><strong>Say hello to the room</strong><p>Messages are shared with this room.</p></div> : chatMessages.map((message) => <article className="chat-message" key={message.id}>
              <div><strong>{message.username}</strong><time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{message.text}</p>
            </article>)}
          </div>
          {chatError && <p className="chat-error" role="alert">{chatError}</p>}
          <form className="chat-input-wrap" onSubmit={sendChat}>
            <input value={chatInput} onChange={(event) => { setChatInput(event.target.value); setChatError('') }} maxLength={1000} placeholder="Write a message…" aria-label="Chat message" disabled={!socket?.connected || chatPending} />
            <button type="submit" aria-label="Send message" disabled={!socket?.connected || chatPending || !chatInput.trim()}><Icon name="send" /></button>
          </form>
        </section>
      </aside>
    </div>
    <div className="room-bottom-note">Room membership, chat, and the shared video queue are live. Host and Moderator playback controls the room.</div>
  </main>
}
