import type { TaskInput } from './contracts.js'

export const LOCAL_HOST_PROTOCOL_VERSION = 1
export const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

export interface LocalHostAgentEvent {
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  stage?: string
}

export interface LocalHostRunEvent {
  executionId: string
  sequence: number
  timestamp: string
  type: string
  data: unknown
}

export interface HandshakeRequest {
  id: string
  kind: 'handshake'
  protocolVersion: number
}

export interface HealthRequest {
  id: string
  kind: 'health'
}

export interface RunRequest {
  id: string
  kind: 'run'
  executionId: string
  input: TaskInput
}

export interface CancelRequest {
  id: string
  kind: 'cancel'
  executionId: string
}

export type ClientMessage = HandshakeRequest | HealthRequest | RunRequest | CancelRequest

export interface HandshakeResponse {
  id: string
  kind: 'handshake'
  ok: boolean
  protocolVersion: number
  hostVersion?: string
  capabilities?: string[]
  error?: string
}

export interface HealthResponse {
  id: string
  kind: 'health'
  ok: boolean
  activeRuns?: number
  error?: string
}

export interface RunAcceptedMessage {
  id: string
  kind: 'run-accepted'
  executionId: string
}

export interface RunEventMessage {
  id: string
  kind: 'run-event'
  executionId: string
  event: LocalHostRunEvent
}

export interface AgentEventMessage {
  id: string
  kind: 'event'
  executionId: string
  event: LocalHostAgentEvent
}

export interface RunResultMessage {
  id: string
  kind: 'run-result'
  executionId: string
  outcome: unknown
}

export interface RunErrorMessage {
  id: string
  kind: 'run-error'
  executionId: string
  error: string
  cancelled: boolean
}

export interface CancelledMessage {
  id: string
  kind: 'cancelled'
  executionId: string
}

export interface ErrorMessage {
  id: string
  kind: 'error'
  message: string
}

export type HostMessage =
  | HandshakeResponse
  | HealthResponse
  | RunAcceptedMessage
  | RunEventMessage
  | AgentEventMessage
  | RunResultMessage
  | RunErrorMessage
  | CancelledMessage
  | ErrorMessage
