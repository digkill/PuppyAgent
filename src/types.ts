export type PermissionMode = 'read-only' | 'ask' | 'workspace-write' | 'full-access';
export type Language = 'en' | 'ru';
export type JsonObject = Record<string, unknown>;
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Message = { role: 'user' | 'assistant'; content: Block[] };
export type StoredMessage = Message & { id: number; sessionId: string };
export type ToolCall = Extract<Block, { type: 'tool_use' }>;
export type ToolDefinition = { name: string; description: string; input_schema: JsonObject };
export type ProviderConfig = {
  protocol: 'anthropic' | 'openai-chat';
  baseUrl: string;
  auth: 'bearer' | 'x-api-key' | 'none';
  apiKeyEnv: string;
  model: string;
  modelsUrl?: string;
  stream?: boolean;
  promptCache?: 'off' | '5m' | '1h';
  pricing?: Pricing;
  maxTaskCredits?: number;
};
export type Pricing = {
  inputUsdPerMTok?: number; outputUsdPerMTok?: number; cacheReadUsdPerMTok?: number;
  cacheWrite5mUsdPerMTok?: number; cacheWrite1hUsdPerMTok?: number;
  usdPerCredit?: number; source?: string; asOf?: string;
};
export type TokenUsage = {
  inputTokens: number | null; uncachedInputTokens: number | null; outputTokens: number | null;
  cacheReadInputTokens: number | null; cacheCreationInputTokens: number | null;
  cacheWrite5mInputTokens: number | null; cacheWrite1hInputTokens: number | null;
};
export type RequestMetrics = {
  usage: TokenUsage; rawUsage: JsonObject; creditsConsumed: number | null;
  responseId: string | null; model: string; latencyMs: number; streamed: boolean;
};
export type RequestRecord = {
  id: string; runId: string; sessionId: string; purpose: string; provider: string; requestedModel: string;
  status: 'pending' | 'completed' | 'failed'; metrics: RequestMetrics | null; pricing: Pricing | null;
  startedAt: string; finishedAt: string | null;
};
export type TaskRun = { id: string; sessionId: string; status: string; creditLimit: number | null; createdAt: string; finishedAt: string | null };
export type Config = {
  language: Language;
  provider: string;
  providers: Record<string, ProviderConfig>;
  tmpDir: string;
  dataDir: string;
  permissionMode: PermissionMode;
  maxSteps: number;
  maxPackCalls: number;
  maxChildren: number;
  maxParallelChildren: number;
  maxDepth: number;
  maxOutputTokens: number;
  contextBudgetTokens: number;
  requestTimeoutMs: number;
  commandTimeoutMs: number;
  maxToolOutputChars: number;
  instructions: string;
  instructionFiles: string[];
};
export type Session = {
  language: Language;
  id: string;
  parentId: string | null;
  title: string;
  cwd: string;
  workspace: string;
  provider: string;
  model: string;
  permissionMode: PermissionMode;
  status: 'idle' | 'running' | 'completed' | 'interrupted' | 'failed';
  summary: string;
  summaryThrough: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
};
export type CompletionRequest = {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
};
export type Completion = { message: Message; inputTokens: number; outputTokens: number; stopReason: string; metrics?: RequestMetrics };
export interface Provider {
  complete(request: CompletionRequest): Promise<Completion>;
  models(signal?: AbortSignal): Promise<string[]>;
}
export type AgentEvent = { sessionId: string; type: string; detail: unknown };
