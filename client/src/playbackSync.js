export const PLAYBACK_DRIFT_THRESHOLD_SECONDS = 2
export const PLAYBACK_SEEK_COOLDOWN_MS = 1200

export function getSeekCorrection({
  videoId,
  currentTime,
  targetTime,
  playerState,
  ready,
  lastCorrection,
  now,
}) {
  if (!ready || playerState === 3 || !Number.isFinite(currentTime) || !Number.isFinite(targetTime)) return null
  if (Math.abs(currentTime - targetTime) <= PLAYBACK_DRIFT_THRESHOLD_SECONDS) return null

  const sameTarget = lastCorrection?.videoId === videoId
    && Math.abs(lastCorrection.targetTime - targetTime) <= PLAYBACK_DRIFT_THRESHOLD_SECONDS
  if (sameTarget && now - lastCorrection.at < PLAYBACK_SEEK_COOLDOWN_MS) return null

  return { videoId, targetTime, at: now }
}

export function getPlaybackCommandForPlayerState(playerState, desiredPlaying) {
  if (playerState === 3 || playerState === 5 || playerState === -1) return null
  if (playerState === 1) return desiredPlaying === false ? 'play' : null
  if (playerState === 2 || playerState === 0) return desiredPlaying === true ? 'pause' : null
  return null
}
