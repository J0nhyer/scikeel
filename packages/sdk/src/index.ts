export type { AttachmentPromptContext } from "@ai4s/shared";
export * from './admin-analytics';
export { OpenCodeClient, ApiError, isApiStatus } from "./OpenCodeClient";
export { GatewayWorkspaceClient, GatewayWorkspaceError, isWorkspaceReport, decodeWorkspaceFailure } from "./GatewayWorkspaceClient";
export type { WorkspaceContext, WorkspaceReport, WorkspaceFailure, WorkspaceRecoveryCommand } from "./GatewayWorkspaceClient";
export type { OpenCodeCatalogReadOptions, CustomProviderModality, CustomProviderModel, ProjectEnvironmentInfo, ProjectEnvironmentApproval } from "./OpenCodeClient";
export type { AgentRuntime } from "./runtime";
export { BaseAgentRuntime } from "./base-runtime";
export {
  OPENCODE_VERSION,
  DEFAULT_OPENCODE_URL,
  type OpenCodeEvent,
  type TextUpdatedEvent,
  type ToolUpdatedEvent,
  type SessionIdleEvent,
  type SessionUpdatedEvent,
  type RuntimeErrorEvent,
  type SessionRetryEvent,
  type RetryAction,
  type OpenCodeClientOptions,
  type RuntimeStatus,
  type ToolCallStatus,
  type SessionMeta,
  type SessionQuery,
  type SessionPage,
  type SkillInfo,
  type AgentInfo,
  type CommandInfo,
  type HistoryMessage,
  type HistoryPart,
  type ProviderInfo,
  type ProviderModelInfo,
  type ProviderAuthMethod,
  type ProviderCatalogEntry,
  type AuthPrompt,
  type OAuthAuthorization,
  type McpConfig,
  type McpServer,
  type QuestionOption,
  type QuestionItem,
  type QuestionAskedEvent,
  type QuestionResolvedEvent,
  type PermissionAskedEvent,
  type PermissionResolvedEvent,
  type PermissionReply,
  type PromptFile,
} from "./types";

export { hasDefaultSessionTitle, titleExcerpt, TITLE_WAIT_MS, withManualSessionTitle } from "./sessionTitle";
export type { SessionTitlePresentation } from "./types";
