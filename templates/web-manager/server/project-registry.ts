import path from 'path'
import type { DbInstance } from './db'
import { initDb } from './db'
import { QueueManager } from './queue-manager'
import { ChatManager } from './chat-manager'
import type { WsMessage } from './types'
import {
  initHubDb,
  getHubDbPath,
  listProjects,
  addProject as addProjectToHub,
  removeProject as removeProjectFromHub,
  getProject,
  getProjectByPath,
  touchProject,
  type ProjectRow,
} from './hub-db'
import { getConfig } from './config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectContext {
  project: ProjectRow
  db: DbInstance
  queueManager: QueueManager
  chatManager: ChatManager
  broadcast: (msg: WsMessage) => void
}

// ─── ProjectRegistry ──────────────────────────────────────────────────────────

export class ProjectRegistry {
  private _hubDb: DbInstance
  private _contexts: Map<string, ProjectContext>
  private _broadcast: (msg: WsMessage) => void

  constructor(broadcast: (msg: WsMessage) => void, hubDbPath?: string) {
    this._broadcast = broadcast
    this._hubDb = initHubDb(hubDbPath ?? getHubDbPath())
    this._contexts = new Map()
  }

  get hubDb(): DbInstance {
    return this._hubDb
  }

  loadAll(): void {
    const projects = listProjects(this._hubDb)
    for (const project of projects) {
      this._loadProjectContext(project)
    }
  }

  addProject(opts: {
    id: string
    slug: string
    name: string
    path: string
  }): ProjectContext {
    const row = addProjectToHub(this._hubDb, opts)
    return this._loadProjectContext(row)
  }

  removeProject(id: string): void {
    const ctx = this._contexts.get(id)
    if (ctx) {
      // Close the DB connection
      try { ctx.db.close() } catch { /* ignore */ }
      this._contexts.delete(id)
    }
    removeProjectFromHub(this._hubDb, id)
  }

  getContext(id: string): ProjectContext | undefined {
    return this._contexts.get(id)
  }

  getContextByPath(projectPath: string): ProjectContext | undefined {
    const row = getProjectByPath(this._hubDb, projectPath)
    if (!row) return undefined
    return this._contexts.get(row.id)
  }

  listContexts(): ProjectContext[] {
    return Array.from(this._contexts.values())
  }

  touchProject(id: string): void {
    touchProject(this._hubDb, id)
  }

  getProjectRow(id: string): ProjectRow | undefined {
    return getProject(this._hubDb, id)
  }

  private _loadProjectContext(project: ProjectRow): ProjectContext {
    // Avoid double-loading
    const existing = this._contexts.get(project.id)
    if (existing) return existing

    const db = initDb(project.db_path)

    // Bind broadcast with projectId so all WS messages carry context
    const boundBroadcast = (msg: WsMessage): void => {
      const enriched = { ...msg, projectId: project.id }
      this._broadcast(enriched as WsMessage)
    }

    const queueManager = new QueueManager(boundBroadcast, db)
    const chatManager = new ChatManager(boundBroadcast, db)

    // Load commands for this project
    try {
      const config = getConfig(project.path, db, project.name)
      queueManager.setCommands(config.commands)
    } catch {
      // Non-fatal: project may not have commands yet
    }

    const ctx: ProjectContext = { project, db, queueManager, chatManager, broadcast: boundBroadcast }
    this._contexts.set(project.id, ctx)
    return ctx
  }
}
