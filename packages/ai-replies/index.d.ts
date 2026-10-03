import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

export type TriggerType = 'new_inquiry' | 'inbound_reply' | 'manual';
export type AiReplyErrorKind = 'not_configured' | 'refusal' | 'parse' | 'rate_limit' | 'api' | 'network';

export interface Venue {
  name: string;
  /** Host-rendered inner text of <venue>. Neutralise guest/admin-supplied values with neutraliseTags. */
  facts?: string | null;
  /** The venue admin's free-text instructions. */
  instructions?: string | null;
}

export interface AvailabilityTool {
  /** Anthropic tool definition; name must be 'check_availability'. */
  definition: Anthropic.Tool;
  /** Returns a JSON-serialisable result. A throw becomes { error } for the model. */
  execute(input: any): unknown | Promise<unknown>;
}

export interface Inquiry {
  name?: string | null;
  /** Rendered in insertion order; null, undefined and '' are skipped. */
  fields?: Record<string, string | number | null | undefined>;
  message?: string | null;
  /** Pre-rendered XML placed inside <inquiry> after the fields. */
  extra?: string;
}

export interface ThreadMessage {
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: Date | string;
}

export interface GenerateReplyOptions<B extends z.ZodObject<any> | null = null> {
  venue: Venue;
  /** Host-specific prompt sections, frozen per host. */
  rules?: string;
  availabilityTool?: AvailabilityTool | null;
  bookingSchema?: B;
  inquiry: Inquiry;
  thread?: ThreadMessage[];
  triggerType?: TriggerType;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  client?: Anthropic;
}

export interface ReplyResult<P = null> {
  body: string;
  summary: string | null;
  quality_score: number;
  requires_human: boolean;
  requires_human_reason: string | null;
  proposed_booking: P | null;
  model: string;
  usage: { input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null };
}

export function generateReply<B extends z.ZodObject<any> | null = null>(
  opts: GenerateReplyOptions<B>
): Promise<ReplyResult<B extends z.ZodObject<any> ? z.infer<B> : null>>;
export function buildRequest(opts: GenerateReplyOptions<any>): Record<string, unknown>;
export function neutraliseTags(text: unknown): string;
export function findCorruption(text: string): string | null;
export function isConfigured(): boolean;
export class AiReplyError extends Error {
  kind: AiReplyErrorKind;
  cause?: unknown;
  constructor(message: string, opts?: { kind: AiReplyErrorKind; cause?: unknown });
}
export const MODEL: string;
export const EFFORT: string;
