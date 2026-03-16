import { Router } from 'express'
import path from 'path'
import type { WsMessage } from './types'
import type { ProjectRegistry } from './project-registry'
import { getHubSetting, setHubSetting, listProjects } from './hub-db'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function deriveProjectName(projectPath: string): string {
  return path.basename(projectPath)
}

export function createHubRouter(
  registry: ProjectRegistry,
  broadcast: (msg: WsMessage) => void
): Router {
  const router = Router()

  // GET /api/hub/projects — list all registered projects
  router.get('/projects', (_req, res) => {
    const projects = listProjects(registry.hubDb)
    res.json({ projects })
  })

  // POST /api/hub/projects — register a new project by path
  router.post('/projects', (req, res) => {
    const { path: projectPath, name } = req.body ?? {}
    if (!projectPath || typeof projectPath !== 'string') {
      res.status(400).json({ error: 'path is required' })
      return
    }

    const resolvedPath = path.resolve(projectPath)
    const derivedName = (name && typeof name === 'string' && name.trim())
      ? name.trim()
      : deriveProjectName(resolvedPath)
    const slug = slugify(derivedName)
    const id = crypto.randomUUID()

    try {
      const ctx = registry.addProject({ id, slug, name: derivedName, path: resolvedPath })
      broadcast({
        type: 'hub.project_added',
        project: ctx.project,
        timestamp: new Date().toISOString(),
      })
      res.status(201).json({ project: ctx.project })
    } catch (err) {
      const message = (err as Error).message ?? ''
      // SQLite UNIQUE constraint violation means path or slug already registered
      if (message.includes('UNIQUE')) {
        res.status(409).json({ error: 'A project with this path is already registered' })
      } else {
        console.error('[hub] add project error:', err)
        res.status(500).json({ error: 'Failed to register project' })
      }
    }
  })

  // DELETE /api/hub/projects/:id — unregister a project
  router.delete('/projects/:id', (req, res) => {
    const { id } = req.params
    const ctx = registry.getContext(id)
    if (!ctx) {
      res.status(404).json({ error: 'Project not found' })
      return
    }

    registry.removeProject(id)
    broadcast({
      type: 'hub.project_removed',
      projectId: id,
      timestamp: new Date().toISOString(),
    })
    res.json({ ok: true })
  })

  // GET /api/hub/state — hub-level state summary
  router.get('/state', (_req, res) => {
    const projects = listProjects(registry.hubDb)
    res.json({
      projects,
      projectCount: projects.length,
    })
  })

  // GET /api/hub/resolve?path=<cwd> — resolve a project from a filesystem path
  router.get('/resolve', (req, res) => {
    const queryPath = req.query.path as string | undefined
    if (!queryPath) {
      res.status(400).json({ error: 'path query parameter is required' })
      return
    }

    const resolvedPath = path.resolve(queryPath)
    const ctx = registry.getContextByPath(resolvedPath)
    if (!ctx) {
      res.status(404).json({ error: 'No project registered for this path' })
      return
    }

    registry.touchProject(ctx.project.id)
    res.json({ project: ctx.project })
  })

  // GET /api/hub/settings — get hub-level settings
  router.get('/settings', (_req, res) => {
    const port = getHubSetting(registry.hubDb, 'port') ?? '4200'
    res.json({ port: parseInt(port, 10) })
  })

  // PUT /api/hub/settings — update hub-level settings
  router.put('/settings', (req, res) => {
    const { port } = req.body ?? {}
    if (port !== undefined) {
      setHubSetting(registry.hubDb, 'port', String(port))
    }
    res.json({ ok: true })
  })

  return router
}
