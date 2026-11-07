/**
 * dsh-plugins-sidebar-manager / host half
 *
 * The sidebar work itself happens in the browser half, because the panel list
 * is rendered by the shell and only the page can watch it. What the host owns
 * is the one thing a browser cannot be trusted with: a durable document.
 *
 *   GET  /api/dsh-plugins-sidebar-manager/config   the saved layout document
 *   POST /api/dsh-plugins-sidebar-manager/config   replace it
 *   GET  /api/dsh-plugins-sidebar-manager/health   mount check
 *
 * The document lives next to the other DSH state, under
 * `$DSH_HOME/plugins-sidebar-manager.json`, so it survives a browser cache wipe
 * and travels with a profile copy. The browser keeps a localStorage mirror so
 * the sidebar is organized on the very first paint, before this half answers.
 *
 * A missing document is not an error: the browser half treats `{}` as "no
 * preference yet" and shows every entry where the plugin put it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'plugins-sidebar-manager'

/** Services the routes need before they can mount. */
export const inject = ['webServer']

const API = '/api/dsh-plugins-sidebar-manager'

const ROUTES = {
  config: `${API}/config`,
  health: `${API}/health`,
}

/** Largest layout document accepted on the write route. */
const BODY_LIMIT = 512 * 1024

/** Where the document lives. */
function configPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugins-sidebar-manager.json')
}

/** Headers every answer carries. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * Turn a thrown value into text a client can read.
 * @param error - whatever was thrown.
 * @returns a message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write one JSON response.
 * @param response - the server response.
 * @param status - the status code.
 * @param payload - the body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(payload))
}

/**
 * Whether the caller is on this machine. The document is user preference, not
 * secret, but a remote browser tab has no business rewriting it: loopback is
 * the whole fence, and an unidentifiable peer is refused rather than trusted.
 * @param request - the incoming request.
 * @returns whether the call may proceed.
 */
function isLocal(request) {
  const address = request.socket?.remoteAddress ?? ''
  if (address === '') return false
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  )
}

/**
 * Read and parse a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed body, or undefined when it is unusable.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read the saved document.
 * @returns the parsed document, or an empty object when nothing is saved yet.
 */
async function readDocument() {
  try {
    const text = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Replace the saved document atomically: a partly written file would leave the
 * sidebar with a layout it can only read half of.
 * @param document - the new document.
 */
async function writeDocument(document) {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * Mount the routes.
 * @param ctx - the host plugin context.
 */
function applyImpl(ctx) {
  /** Guard: local caller and the expected method. */
  const guard = (request, response, method) => {
    if (!isLocal(request)) {
      sendJson(response, 403, { error: 'local-only' })
      return false
    }
    if (request.method !== method) {
      sendJson(response, 405, { error: `method not allowed: ${request.method}` })
      return false
    }
    return true
  }

  /**
   * One path, two methods. Mounting `GET /config` and `POST /config` as two
   * exact routes would put two entries on the same path, and the router keys
   * exact routes by path: the second registration would shadow or throw
   * depending on the build. Dispatching on the method inside one handler keeps
   * the mounting independent of that detail.
   * @param request - the incoming request.
   * @param response - the server response.
   */
  const handleConfig = async (request, response) => {
    if (!isLocal(request)) {
      sendJson(response, 403, { error: 'local-only' })
      return
    }
    if (request.method === 'GET') {
      try {
        sendJson(response, 200, { document: await readDocument() })
      } catch (error) {
        sendJson(response, 500, { error: describe(error) })
      }
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: `method not allowed: ${request.method}` })
      return
    }
    const body = await readBody(request)
    if (body === undefined) {
      sendJson(response, 400, { error: 'unreadable body' })
      return
    }
    const document = body?.document
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      sendJson(response, 400, { error: 'document must be an object' })
      return
    }
    try {
      await writeDocument(document)
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 500, { error: describe(error) })
    }
  }

  const handlers = [
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: (request, response) => {
        if (!guard(request, response, 'GET')) return
        sendJson(response, 200, { ok: true, path: configPath() })
      },
    },
    {
      kind: 'exact',
      path: ROUTES.config,
      handler: handleConfig,
    },
  ]

  ctx.effect(() => {
    const disposers = handlers.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'plugins-sidebar-manager: routes')
}

/** Wrap the plugin so a second mount in one process is a no-op. */
const MOUNTED = Symbol.for('dsh.web.mounted-plugins-sidebar-manager')

/**
 * Mount the routes once per process.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const registry = globalThis
  if (registry[MOUNTED] === true) return
  registry[MOUNTED] = true
  ctx.effect(
    () => () => {
      registry[MOUNTED] = false
    },
    'plugins-sidebar-manager: mount guard',
  )
  applyImpl(ctx)
}

export { ROUTES }
