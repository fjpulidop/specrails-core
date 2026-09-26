import { pipelineStateDirectory, type PipelineContext } from '../../../pipeline/pipeline-state.js'
import { contentDigest } from '../canonical-json.js'
import { EngineError, type PieceExecutionContext } from '../contracts.js'

export interface ImplementationBinding {
  context: PipelineContext
  change: string
  parentRunId: string
  scopeId: string
  nodePath: string
  directory: string
}

/** Bind one journal to one declared implementation instance without changing backlog semantics. */
export function deriveImplementationBinding(parent: PipelineContext, execution: PieceExecutionContext, change: string): ImplementationBinding {
  const { frame, state } = execution
  const standalone = frame.scope.id === 'root' && !frame.nodePath.includes('/') && state.$item === null
  let specs = parent.specs, repositories = parent.repositories
  if (state.$item !== null) {
    const item = state.$item.value
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new EngineError('implementation_item_scope', 'Implementation map items must identify a frozen ticket or repository')
    if (typeof item.path === 'string') {
      const repository = parent.repositories.find(value => value.id === item.id && value.path === item.path)
      if (!repository) throw new EngineError('implementation_item_scope', 'Repository item is outside the frozen execution scope')
      repositories = [repository]
      specs = parent.specs.filter(spec => !spec.repositoryIds?.length || spec.repositoryIds.includes(repository.id)).map(spec => ({ ...spec, repositoryIds: [repository.id] }))
    } else {
      const spec = parent.specs.find(value => String(value.id) === String(item.id))
      if (!spec || typeof item.title !== 'string') throw new EngineError('implementation_item_scope', 'Ticket item is outside the frozen execution scope')
      specs = [spec]
      if (spec.repositoryIds?.length) repositories = parent.repositories.filter(repository => spec.repositoryIds!.includes(repository.id))
    }
    if (!specs.length || !repositories.length) throw new EngineError('implementation_item_scope', 'Implementation item has no frozen obligations or repositories')
  }
  const digest = contentDigest({ parentRunId: parent.runId, scopeId: frame.scope.id, nodePath: frame.nodePath }).slice(0, 24)
  const artifact = repositories.find(repository => repository.id === parent.artifactRepositoryId) ?? repositories[0]
  const context: PipelineContext = standalone ? structuredClone(parent) : { ...structuredClone(parent),
    runId: parent.runId.slice(0, 80) + '-impl-' + digest,
    artifactRoot: artifact.id === parent.artifactRepositoryId ? parent.artifactRoot : artifact.path,
    artifactRepositoryId: artifact.id, repositories: structuredClone(repositories), specs: structuredClone(specs),
  }
  return { context, change: standalone ? change : change.slice(0, 38).replace(/-+$/, '') + '-' + digest,
    parentRunId: parent.runId, scopeId: frame.scope.id, nodePath: frame.nodePath, directory: pipelineStateDirectory(context) }
}
