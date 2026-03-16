/**
 * Returns the base URL prefix for project-scoped API calls.
 *
 * Single-project mode: '/api'
 * Hub mode with active project: '/api/projects/<id>'
 *
 * Components and hooks call useApiBase() to get this prefix, then append
 * resource paths (e.g., `${base}/jobs`).
 */

// Module-level store for active project ID — set by HubProvider/App
let _activeProjectId: string | null = null
let _isHubMode = false

export function setApiContext(isHub: boolean, projectId: string | null): void {
  _isHubMode = isHub
  _activeProjectId = projectId
}

export function getApiBase(): string {
  if (_isHubMode && _activeProjectId) {
    return `/api/projects/${_activeProjectId}`
  }
  return '/api'
}
