/**
 * Agent Client Protocol v1 vocabulary used by this plugin.
 *
 * Only fields the runtime reads or writes are declared; `_meta` remains
 * available for agents that attach extension data. Protocol version 1 is the
 * supported version (design decision Q9).
 */

export const ACP_PROTOCOL_VERSION = 1

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: JsonRpcErrorObject
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export type ClientCapabilities = {
  readonly fs?: {
    readonly readTextFile?: boolean
    readonly writeTextFile?: boolean
  }
  readonly terminal?: boolean
  readonly _meta?: Record<string, unknown>
}

export interface InitializeParams {
  readonly protocolVersion: number
  readonly clientInfo: { readonly name: string; readonly version: string }
  readonly clientCapabilities: ClientCapabilities
}

export interface InitializeResult {
  readonly protocolVersion: number
  readonly agentInfo?: { readonly name: string; readonly version: string }
  readonly agentCapabilities?: {
    readonly loadSession?: boolean
    readonly promptCapabilities?: Record<string, boolean>
    readonly sessionCapabilities?: Record<string, unknown>
  }
}

export interface McpServerSpec {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface SessionMode {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}

export interface SessionModeState {
  readonly currentModeId: string
  readonly availableModes: readonly SessionMode[]
}

export interface SessionConfigSelectOption {
  readonly value: string
  readonly name: string
  readonly description?: string | null
}

export interface SessionConfigSelectGroup {
  readonly group: string
  readonly name: string
  readonly options: readonly SessionConfigSelectOption[]
}

export interface SessionConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly category?: string | null
  readonly type: 'select' | 'boolean'
  readonly currentValue?: string | boolean
  readonly options?: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[]
}

export interface NewSessionParams {
  readonly cwd: string
  readonly mcpServers: readonly McpServerSpec[]
}

export interface NewSessionResult {
  readonly sessionId: string
  readonly modes?: SessionModeState
  readonly configOptions?: readonly SessionConfigOption[]
}

export interface LoadSessionParams {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: readonly McpServerSpec[]
}

export interface LoadSessionResult {
  readonly modes?: SessionModeState
  readonly configOptions?: readonly SessionConfigOption[]
}

export interface PromptParams {
  readonly sessionId: string
  readonly prompt: readonly ContentBlock[]
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export interface PromptResult {
  readonly stopReason: StopReason
  readonly usage?: Record<string, number>
}

export interface SetConfigOptionParams {
  readonly sessionId: string
  readonly configId: string
  readonly value: string | boolean
}

export interface SetModeParams {
  readonly sessionId: string
  readonly modeId: string
}

export interface CancelParams {
  readonly sessionId: string
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface ToolCallLocation {
  readonly path: string
  readonly line?: number | null
}

export interface ContentBlock {
  readonly type: string
  readonly [key: string]: unknown
}

export type ToolCallContent =
  | { readonly type: 'content'; readonly content: ContentBlock }
  | { readonly type: 'diff'; readonly path: string; readonly oldText?: string | null; readonly newText: string }
  | { readonly type: 'terminal'; readonly terminalId: string }

export interface ToolCall {
  readonly toolCallId: string
  readonly title: string
  readonly name?: string | null
  readonly kind?: ToolKind | string
  readonly status?: ToolCallStatus | string
  readonly content?: readonly ToolCallContent[]
  readonly locations?: readonly ToolCallLocation[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export type ToolCallUpdate = Partial<Omit<ToolCall, 'toolCallId'>> & { readonly toolCallId: string }

export interface PermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: string
  readonly _meta?: Record<string, unknown>
}

export interface RequestPermissionParams {
  readonly sessionId: string
  readonly toolCall: ToolCallUpdate
  readonly options: readonly PermissionOption[]
}

export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface RequestPermissionResult {
  readonly outcome: PermissionOutcome
}

export interface PlanEntry {
  readonly content: string
  readonly priority: string
  readonly status: string
}

export interface AvailableCommand {
  readonly name: string
  readonly description: string
  readonly input?: unknown
}

export type SessionUpdate =
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: ContentBlock }
  | ({ readonly sessionUpdate: 'tool_call' } & ToolCall)
  | ({ readonly sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
  | { readonly sessionUpdate: 'plan'; readonly entries: readonly PlanEntry[] }
  | { readonly sessionUpdate: 'available_commands_update'; readonly availableCommands: readonly AvailableCommand[] }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
  | { readonly sessionUpdate: 'config_option_update'; readonly [key: string]: unknown }
  | { readonly sessionUpdate: 'session_info_update'; readonly [key: string]: unknown }
  | { readonly sessionUpdate: 'usage_update'; readonly [key: string]: unknown }

export interface SessionNotification {
  readonly sessionId: string
  readonly update: SessionUpdate
}
