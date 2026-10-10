const IFRAME_API_URL = 'https://www.youtube.com/iframe_api'
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

let apiPromise

export function extractYoutubeVideoId(value) {
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const hostname = url.hostname.toLowerCase()
    let videoId = null

    if (hostname === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0]
    } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      const segments = url.pathname.split('/').filter(Boolean)
      if (url.pathname === '/watch') videoId = url.searchParams.get('v')
      else if (['shorts', 'embed', 'live'].includes(segments[0])) videoId = segments[1]
    }

    return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null
  } catch {
    return null
  }
}

export function loadYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise

  apiPromise = new Promise((resolve, reject) => {
    let timeout
    const fail = (error) => {
      window.clearTimeout(timeout)
      reject(error instanceof Error ? error : new Error('The YouTube player API could not be loaded.'))
    }
    const ready = () => {
      window.clearTimeout(timeout)
      if (window.YT?.Player) resolve(window.YT)
      else fail(new Error('YouTube loaded without making the player API available.'))
    }

    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      try {
        if (typeof previousReady === 'function') previousReady()
      } finally {
        ready()
      }
    }

    timeout = window.setTimeout(() => fail(new Error('Timed out loading the YouTube player API. Check your connection and try again.')), 15000)
    let script = [...document.scripts].find((item) => item.src.startsWith(IFRAME_API_URL))
    if (!script) {
      script = document.createElement('script')
      script.src = IFRAME_API_URL
      script.async = true
      document.head.appendChild(script)
    }
    script.addEventListener('error', () => {
      script.remove()
      fail(new Error('Could not load YouTube. Check your connection or content blocker.'))
    }, { once: true })
  }).catch((error) => {
    apiPromise = null
    throw error
  })

  return apiPromise
}
