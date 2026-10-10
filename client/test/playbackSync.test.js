import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPlaybackCommandForPlayerState,
  getSeekCorrection,
  PLAYBACK_DRIFT_THRESHOLD_SECONDS,
} from '../src/playbackSync.js'

test('seek corrections ignore small drift and correct drift over the threshold', () => {
  const options = { videoId: 'abcdefghijk', ready: true, playerState: 1, now: 1000 }
  assert.equal(getSeekCorrection({ ...options, currentTime: 10, targetTime: 10 + PLAYBACK_DRIFT_THRESHOLD_SECONDS }), null)
  assert.deepEqual(
    getSeekCorrection({ ...options, currentTime: 10, targetTime: 12.1 }),
    { videoId: 'abcdefghijk', targetTime: 12.1, at: 1000 },
  )
})

test('seek corrections wait for readiness and do not run during buffering', () => {
  const options = { videoId: 'abcdefghijk', currentTime: 0, targetTime: 10, now: 1000 }
  assert.equal(getSeekCorrection({ ...options, ready: false, playerState: 1 }), null)
  assert.equal(getSeekCorrection({ ...options, ready: true, playerState: 3 }), null)
})

test('seek cooldown prevents repeat corrections to the same target', () => {
  const lastCorrection = { videoId: 'abcdefghijk', targetTime: 20, at: 1000 }
  const options = { videoId: 'abcdefghijk', currentTime: 10, targetTime: 20, playerState: 1, ready: true, lastCorrection, now: 1100 }
  assert.equal(getSeekCorrection(options), null)
  assert.ok(getSeekCorrection({ ...options, targetTime: 30 }))
  assert.ok(getSeekCorrection({ ...options, now: 2200 }))
})

test('player events only produce commands when they disagree with desired playback', () => {
  assert.equal(getPlaybackCommandForPlayerState(1, false), 'play')
  assert.equal(getPlaybackCommandForPlayerState(1, true), null)
  assert.equal(getPlaybackCommandForPlayerState(2, true), 'pause')
  assert.equal(getPlaybackCommandForPlayerState(2, false), null)
  assert.equal(getPlaybackCommandForPlayerState(0, true), 'pause')
  assert.equal(getPlaybackCommandForPlayerState(0, false), null)
  assert.equal(getPlaybackCommandForPlayerState(3, true), null)
  assert.equal(getPlaybackCommandForPlayerState(5, false), null)
})
