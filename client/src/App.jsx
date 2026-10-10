import { useEffect, useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import Brand from './components/Brand.jsx'
import HomePage from './pages/HomePage.jsx'
import WatchRoomPage from './pages/WatchRoomPage.jsx'
import { socket } from './socket.js'
import './style.css'

function AppShell() {
  const [connection, setConnection] = useState('connecting')
  useEffect(() => {
    const onConnect = () => setConnection('connected')
    const onConnectError = () => setConnection('disconnected')
    const onDisconnect = () => setConnection('disconnected')
    socket.on('connect', onConnect)
    socket.on('connect_error', onConnectError)
    socket.on('disconnect', onDisconnect)
    if (socket.connected) setConnection('connected')
    else socket.connect()
    return () => {
      socket.off('connect', onConnect)
      socket.off('connect_error', onConnectError)
      socket.off('disconnect', onDisconnect)
    }
  }, [])

  return <div className="app-shell">
    <header className="topbar">
      <Link className="brand-link" to="/"><Brand /></Link>
      <div className="topbar-right"><span className={`connection-pill ${connection}`}><i /> Server {connection}</span><a className="topbar-help" href="#how-it-works">How it works</a></div>
    </header>
    <Routes><Route path="/" element={<HomePage socket={socket} connection={connection} />} /><Route path="/room/:roomId" element={<WatchRoomPage socket={socket} connection={connection} />} /><Route path="*" element={<HomePage socket={socket} connection={connection} />} /></Routes>
    <footer className="site-footer"><span>Made for better watch nights.</span><span>Room memberships are temporary and reset when the server restarts.</span></footer>
  </div>
}

export default function App() { return <BrowserRouter><AppShell /></BrowserRouter> }
