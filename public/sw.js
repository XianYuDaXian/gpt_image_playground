const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE_PREFIX = 'gpt-image-playground'
const CACHE_NAME = `${CACHE_PREFIX}-${VERSION}`
const APP_SHELL = ['./manifest.webmanifest', './pwa-icon.svg']

function isHtmlRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document'
}

function isAppApi(url) {
  return url.pathname.startsWith('/api/')
}

function isAppMedia(url) {
  return url.pathname.startsWith('/media/')
}

function isStaticAsset(request) {
  return ['script', 'style', 'worker', 'font'].includes(request.destination)
}

function isVersionedAsset(url) {
  return url.pathname.includes('/assets/')
}

function isImageRequest(request) {
  return request.destination === 'image'
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
      self.clients.claim(),
    ]),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isAppApi(url)) return

  if (isHtmlRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, copy)
              if (isHtmlRequest(request)) {
                cache.put('./index.html', response.clone())
              }
            })
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          return caches.match('./index.html')
        }),
    )
    return
  }

  if (isStaticAsset(request) && isVersionedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached

        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
            }
            return response
          })
      }),
    )
    return
  }

  if (isStaticAsset(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => caches.match(request)),
    )
    return
  }

  if (isImageRequest(request) || isAppMedia(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached

        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
      }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
