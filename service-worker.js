/* global self, caches, fetch, URL, Request, setTimeout */

const APP_CACHE = 'brouter-navi-app-shell-v1'
const TILE_CACHE = 'brouter-navi-viewed-tiles-v1'
const MAX_TILE_COUNT = 1200
const TILE_TRIM_TARGET = 1100
const STATUS_WRITE_INTERVAL = 25
const FAILURE_BACKOFF_MS = [30_000, 120_000, 600_000]
const APP_SHELL_FALLBACK_DELAY_MS = 1_500

const workerUrl = new URL(self.location.href)
let allowedTilePrefixes = workerUrl.searchParams.get('tileCache') === 'osm'
  ? ['https://tile.openstreetmap.org/']
  : []
let lastSuccessfulTileFetchAt = null
let lastTileFailureAt = null
const hostFailures = new Map()
let tileCountEstimate = null
let tileWritesSinceStatus = 0
let tileWriteQueue = Promise.resolve()

const scopeUrl = new URL(self.registration.scope)
const shellUrl = scopeUrl.href

function isVersionManifest(url) {
  return url.origin === scopeUrl.origin && url.pathname === `${scopeUrl.pathname}version.json`
}

function isShellAsset(url) {
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return false
  if (isVersionManifest(url) || url.pathname.includes('/api/')) return false
  return url.pathname.includes('/assets/') ||
    /\.(?:css|js|png|svg|webp|webmanifest)$/.test(url.pathname)
}

function isAllowedTileRequest(request) {
  if (request.method !== 'GET') return false
  return allowedTilePrefixes.some((prefix) => request.url.startsWith(prefix))
}

function responseFresh(response, now = Date.now()) {
  const cacheControl = response.headers.get('cache-control') ?? ''
  const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i)
  const responseDate = Date.parse(response.headers.get('date') ?? '')
  const ageSeconds = Number(response.headers.get('age') ?? '0')
  if (maxAgeMatch && Number.isFinite(responseDate)) {
    return responseDate + Number(maxAgeMatch[1]) * 1000 - ageSeconds * 1000 > now
  }
  const expires = Date.parse(response.headers.get('expires') ?? '')
  return Number.isFinite(expires) && expires > now
}

async function trimTileCache(cache) {
  const keys = await cache.keys()
  const overflow = keys.length - TILE_TRIM_TARGET
  if (overflow <= 0) return
  await Promise.all(keys.slice(0, overflow).map((request) => cache.delete(request)))
  tileCountEstimate = keys.length - overflow
}

async function broadcastStatusChanged() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) client.postMessage({ type: 'OFFLINE_STATUS_CHANGED' })
}

function recordTileFailure(host) {
  const previous = hostFailures.get(host)
  const failures = Math.min((previous?.failures ?? 0) + 1, FAILURE_BACKOFF_MS.length)
  const now = Date.now()
  hostFailures.set(host, {
    failures,
    retryAt: now + FAILURE_BACKOFF_MS[failures - 1],
  })
  lastTileFailureAt = now
  void broadcastStatusChanged()
}

function recordTileSuccess(host) {
  const recovered = hostFailures.delete(host)
  lastSuccessfulTileFetchAt = Date.now()
  if (recovered) void broadcastStatusChanged()
}

async function fetchTile(request) {
  // CacheStorage is the single application-managed persistent tile cache.
  // Avoid a second, separately managed copy in the browser HTTP cache.
  const response = await fetch(new Request(request, { cache: 'no-store' }))
  if (!response.ok && response.type !== 'opaque') throw new Error(`Tile HTTP ${response.status}`)
  return response
}

function responseCacheable(response) {
  const cacheControl = response.headers.get('cache-control') ?? ''
  return !/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/i.test(cacheControl)
}

async function storeTile(request, response, cache, isNewTile) {
  try {
    if (tileCountEstimate === null) tileCountEstimate = (await cache.keys()).length
    await cache.put(request, response)
    if (isNewTile) tileCountEstimate += 1
    if (tileCountEstimate > MAX_TILE_COUNT) await trimTileCache(cache)

    tileWritesSinceStatus += 1
    if (tileWritesSinceStatus >= STATUS_WRITE_INTERVAL) {
      tileWritesSinceStatus = 0
      await broadcastStatusChanged()
    }
  } catch {
    // A full or unavailable CacheStorage must not hide a successfully loaded tile.
  }
}

function queueTileStore(request, response, cache, isNewTile) {
  const task = tileWriteQueue.then(() => storeTile(request, response, cache, isNewTile))
  tileWriteQueue = task.catch(() => undefined)
  return task
}

function queueTileCacheClear(target, requestId) {
  const task = tileWriteQueue.then(async () => {
    let success = false
    let remainingTileCount = null
    try {
      await caches.delete(TILE_CACHE)
      const remainingCacheNames = await caches.keys()
      remainingTileCount = remainingCacheNames.includes(TILE_CACHE)
        ? (await (await caches.open(TILE_CACHE)).keys()).length
        : 0
      tileCountEstimate = remainingTileCount
      tileWritesSinceStatus = 0
      success = remainingTileCount === 0
      await broadcastStatusChanged()
    } finally {
      target?.postMessage({
        type: 'OFFLINE_TILE_CACHE_CLEARED',
        requestId,
        success,
        remainingTileCount,
      })
    }
  })
  tileWriteQueue = task.catch(() => undefined)
  return task
}

async function tileResult(request) {
  const cache = await caches.open(TILE_CACHE)
  const cached = await cache.match(request)
  if (cached && responseFresh(cached)) {
    return { response: cached, completion: Promise.resolve() }
  }

  const host = new URL(request.url).host
  const failure = hostFailures.get(host)
  if (failure && failure.retryAt > Date.now()) {
    if (cached) return { response: cached, completion: Promise.resolve() }
    throw new Error('Tile host is temporarily unavailable')
  }

  if (cached) {
    const completion = fetchTile(request)
      .then((response) => {
        recordTileSuccess(host)
        return responseCacheable(response)
          ? queueTileStore(request, response, cache, false)
          : undefined
      })
      .catch(() => recordTileFailure(host))
    return { response: cached, completion }
  }

  try {
    const response = await fetchTile(request)
    recordTileSuccess(host)
    const completion = responseCacheable(response)
      ? queueTileStore(request, response.clone(), cache, true)
      : Promise.resolve()
    return { response, completion }
  } catch (error) {
    recordTileFailure(host)
    throw error
  }
}

async function navigationResult(request) {
  const cache = await caches.open(APP_CACHE)
  const cached = await cache.match(shellUrl)
  const networkResult = fetch(request).then(
    (response) => ({ response }),
    (error) => ({ error }),
  )
  const storeNetworkResponse = async (result) => {
    if ('response' in result && result.response.ok) {
      await cache.put(shellUrl, result.response.clone())
    }
  }

  if (!cached) {
    const result = await networkResult
    if ('error' in result) throw result.error
    return {
      response: result.response,
      completion: storeNetworkResponse(result),
    }
  }

  const result = await Promise.race([
    networkResult,
    new Promise((resolve) => {
      setTimeout(() => resolve({ fallback: true }), APP_SHELL_FALLBACK_DELAY_MS)
    }),
  ])
  if ('response' in result) {
    return {
      response: result.response,
      completion: storeNetworkResponse(result),
    }
  }
  if ('error' in result) {
    return { response: cached, completion: Promise.resolve() }
  }
  return {
    response: cached,
    completion: networkResult.then(storeNetworkResponse).catch(() => undefined),
  }
}

async function shellAssetResponse(request) {
  const cache = await caches.open(APP_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function warmAppShell(urls) {
  const cache = await caches.open(APP_CACHE)
  for (const value of urls) {
    try {
      const url = new URL(value, scopeUrl)
      if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname) ||
          isVersionManifest(url) || url.pathname.includes('/api/')) continue
      const request = new Request(url.href, { credentials: 'same-origin' })
      const response = await fetch(request)
      if (response.ok) await cache.put(url.href, response)
    } catch {
      // Remaining assets can still be warmed and a later page load retries this one.
    }
  }
  await broadcastStatusChanged()
}

async function sendStatus(target, requestId) {
  await tileWriteQueue
  const [appCache, tileCache] = await Promise.all([
    caches.open(APP_CACHE),
    caches.open(TILE_CACHE),
  ])
  const [shell, tileKeys] = await Promise.all([
    appCache.match(shellUrl),
    tileCache.keys(),
  ])
  target.postMessage({
    type: 'OFFLINE_STATUS',
    requestId,
    appShellAvailable: shell !== undefined,
    cachedTileCount: tileKeys.length,
    lastSuccessfulTileFetchAt,
    lastTileFailureAt,
  })
}

self.addEventListener('install', () => {
  // Do not skip waiting: an existing navigation keeps its current application build.
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('brouter-navi-') &&
        name !== APP_CACHE && name !== TILE_CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'OFFLINE_CONFIG') {
    allowedTilePrefixes = Array.isArray(message.allowedTilePrefixes)
      ? message.allowedTilePrefixes.filter((value) => typeof value === 'string')
      : []
    const urls = Array.isArray(message.shellUrls) ? message.shellUrls : []
    event.waitUntil(warmAppShell(urls))
  }
  if (message.type === 'OFFLINE_STATUS_REQUEST' && event.source) {
    event.waitUntil(sendStatus(event.source, message.requestId))
  }
  if (message.type === 'OFFLINE_TILE_CACHE_CLEAR') {
    event.waitUntil(queueTileCacheClear(event.source, message.requestId))
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (isVersionManifest(url)) return
  if (request.mode === 'navigate') {
    const result = navigationResult(request)
    event.respondWith(result.then(({ response }) => response))
    event.waitUntil(
      result.then(({ completion }) => completion).catch(() => undefined),
    )
    return
  }
  if (isAllowedTileRequest(request)) {
    const result = tileResult(request)
    event.respondWith(result.then(({ response }) => response))
    event.waitUntil(
      result.then(({ completion }) => completion).catch(() => undefined),
    )
    return
  }
  if (isShellAsset(url)) event.respondWith(shellAssetResponse(request))
})
