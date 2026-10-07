// SciKeel managed title policy. Keep this module independent of runtime services.
export type TitleJob = {
  version: 1
  source: 'default' | 'manual' | 'automatic'
  revision: number
  firstMessageID?: string
  model?: { providerID: string; modelID: string }
  attempts: 0 | 1 | 2
  status: 'ready' | 'running' | 'failed' | 'completed'
  attemptID?: string
  runID?: string
  triggerMessageID?: string
}
export const key = 'scikeelSessionTitle'
export const enabled = () => process.env.SCIKEEL_SESSION_TITLE_POLICY === 'conversation-v1'
export const initialJob = (): TitleJob => ({ version: 1, source: 'default', revision: 0, attempts: 0, status: 'ready' })
export function readJob(metadata: Record<string, unknown> | undefined): TitleJob | undefined {
  const value = metadata?.[key] as TitleJob | undefined
  if (!value || value.version !== 1 || !['default', 'manual', 'automatic'].includes(value.source) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || ![0, 1, 2].includes(value.attempts) ||
      !['ready', 'running', 'failed', 'completed'].includes(value.status)) return
  if (value.attempts && (typeof value.firstMessageID !== 'string' || !value.model ||
      typeof value.model.providerID !== 'string' || typeof value.model.modelID !== 'string' ||
      typeof value.attemptID !== 'string' || typeof value.runID !== 'string' || typeof value.triggerMessageID !== 'string')) return
  return value
}
export function captureFirstMessage(job: TitleJob, message: { id: string; model: { providerID: string; modelID: string } }): TitleJob {
  if (job.firstMessageID || job.source !== 'default') return job
  return { ...job, firstMessageID: message.id, model: { providerID: message.model.providerID, modelID: message.model.modelID } }
}
export function beginAttempt(job: TitleJob, triggerMessageID: string, runID: string, attemptID: string): TitleJob | undefined {
  if (job.source !== 'default' || !job.firstMessageID || !job.model || job.attempts >= 2 ||
      job.status === 'completed' || job.status === 'running' && job.runID === runID ||
      job.triggerMessageID === triggerMessageID) return
  return { ...job, attempts: (job.attempts + 1) as 1 | 2, status: 'running', triggerMessageID, runID, attemptID }
}
export function finishAttempt(job: TitleJob, attemptID: string, revision: number, success: boolean): TitleJob | undefined {
  if (job.source !== 'default' || job.status !== 'running' || job.attemptID !== attemptID || job.revision !== revision) return
  return { ...job, source: success ? 'automatic' : 'default', status: success ? 'completed' : 'failed' }
}
export const manualRename = (job: TitleJob): TitleJob => ({ ...job, source: 'manual', revision: job.revision + 1, status: 'failed' })
export function titleText(text: string): string | undefined {
  const line = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').split('\n').map(line => line.trim()).find(Boolean)
  return line && (line.length > 100 ? line.slice(0, 97) + '...' : line)
}

export * as TitlePolicy from "./title-policy.ts"
