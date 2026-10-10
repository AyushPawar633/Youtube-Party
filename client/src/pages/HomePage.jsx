import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SectionTitle from '../components/SectionTitle.jsx'
import { loadRoomSession, participantId, saveRoomSession } from '../roomSession.js'

function ArrowIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M10 5l5 5-5 5" /></svg> }

export default function HomePage({ socket, connection }) {
  const navigate = useNavigate()
  const [createUsername, setCreateUsername] = useState('')
  const [joinUsername, setJoinUsername] = useState('')
  const [roomId, setRoomId] = useState('')
  const [createError, setCreateError] = useState('')
  const [joinError, setJoinError] = useState('')
  const [pending, setPending] = useState('')

  function requestRoom(event, action) {
    event.preventDefault()
    const username = (action === 'create' ? createUsername : joinUsername).trim()
    const setError = action === 'create' ? setCreateError : setJoinError
    setError('')
    if (!username || username.length > 24) {
      setError('Enter a username between 1 and 24 characters.')
      return
    }
    if (action === 'join' && !roomId.trim()) {
      setError('Enter a room ID.')
      return
    }
    if (!socket?.connected || connection !== 'connected') {
      setError('Connecting to the server… Please try again in a moment.')
      return
    }
    setPending(action)
    const eventName = action === 'create' ? 'room:create' : 'room:join'
    const payload = action === 'create'
      ? { username, participantId }
      : { username, roomId: roomId.trim(), participantId, hostToken: loadRoomSession(roomId.trim().toUpperCase())?.hostToken }
    socket.timeout(8000).emit(eventName, payload, (timeoutError, result) => {
      setPending('')
      if (timeoutError) {
        setError('The server did not respond. Check your connection and try again.')
        return
      }
      if (result?.error) {
        setError(result.error)
        return
      }
      if (!result?.room?.id || !result?.participant) {
        setError('The server returned an incomplete room response. Please try again.')
        return
      }
      saveRoomSession(result.room.id, result.participant, result.hostToken)
      navigate(`/room/${result.room.id}`, { state: { room: result.room, participant: result.participant } })
    })
  }
  return <main className="home-page">
    <section className="hero">
      <div className="hero-copy">
        <div className="status-label"><span /> YOUR NEXT WATCH NIGHT STARTS HERE</div>
        <h1>Good videos.<br /><span>Great company.</span></h1>
        <p className="hero-description">Bring your people together for the videos you love. One room, one shared screen, all your favorite people.</p>
        <a className="text-link" href="#room-options">Get started <ArrowIcon /></a>
        <div className="hero-note"><span className="note-icon">✳</span><span><strong>Ready when you are</strong><br />Create a room and invite your people with a shareable link.</span></div>
      </div>
      <div className="hero-art" aria-label="Preview of a shared watch room">
        <div className="art-window"><div className="window-bar"><span /><span /><span /><b>ROOM PREVIEW</b></div><div className="screen-scene"><div className="moon" /><div className="hill hill-back" /><div className="hill hill-front" /><div className="play-disc"><span /></div><div className="screen-caption">SHARED VIDEO</div></div><div className="watchers"><span className="watching-label">Video, chat, and queue in one room</span></div></div>
      </div>
    </section>
    <section className="room-options" id="room-options">
      <div className="options-heading"><div><span className="eyebrow">MAKE IT A GROUP THING</span><h2>How do you want to join?</h2></div><span className="options-counter">01 <i /> 02</span></div>
      <div className="option-grid">
        <article className="option-card"><SectionTitle number="01" title="Start a watch party" detail="Set up a room for your crew." /><form onSubmit={(event) => requestRoom(event, 'create')} noValidate><label className="field-label" htmlFor="create-username">YOUR NAME</label><input id="create-username" className="text-input" placeholder="e.g. Alex" value={createUsername} onChange={(event) => setCreateUsername(event.target.value)} maxLength={24} autoComplete="nickname" /><button className="primary-button" type="submit" disabled={pending !== ''}>{pending === 'create' ? 'Creating room…' : 'Create a room'} {!pending && <ArrowIcon />}</button><p className="card-footnote" aria-live="polite">{createError || 'You’ll be the host of this room.'}</p></form></article>
        <article className="option-card"><SectionTitle number="02" title="Join your people" detail="Got an invite? Enter your name and room ID." /><form onSubmit={(event) => requestRoom(event, 'join')} noValidate><label className="field-label" htmlFor="join-username">YOUR NAME</label><input id="join-username" className="text-input join-name-input" placeholder="e.g. Sam" value={joinUsername} onChange={(event) => setJoinUsername(event.target.value)} maxLength={24} autoComplete="nickname" /><label className="field-label join-room-label" htmlFor="room-id">ROOM ID</label><input id="room-id" className="text-input" placeholder="Paste your room ID" value={roomId} onChange={(event) => setRoomId(event.target.value)} /><button className="secondary-button" type="submit" disabled={pending !== ''}>{pending === 'join' ? 'Joining room…' : 'Join room'} {!pending && <ArrowIcon />}</button><p className="card-footnote" aria-live="polite">{joinError || 'You’ll join as a participant.'}</p></form></article>
      </div>
      <div className="preview-callout"><span className="preview-spark">✳</span><div><strong>Invite your people</strong><span>Every room gets a unique ID and a shareable invite link.</span></div></div>
    </section>
    <section className="how-section" id="how-it-works"><span className="eyebrow">THE IDEA IS SIMPLE</span><div className="how-grid"><h2>Good things are<br />better <span>together.</span></h2><p>Create a room, share its invite link, and bring your friends in. Rooms are stored in memory for now and clear when the server restarts.</p></div></section>
  </main>
}
