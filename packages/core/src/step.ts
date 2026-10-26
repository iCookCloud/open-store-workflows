import { Hash, ParamKey, SlotName, StepId, z } from './base.js';
import type { AssetRef, WorkflowKey } from './base.js';
import type { SlotDef } from './slot.js';
import type { AssetReader } from './source.js';
import type { Approval, Fill, Verification } from './verification.js';
export const Need = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    step: StepId,
    subject: z.string().optional(),
    subjectHash: Hash,
    question: z.string(),
    blocking: z.boolean(),
  }),
  z.object({
    kind: z.literal('param'),
    key: ParamKey,
    unit: z.string().optional(),
    reason: z.enum(['missing', 'ambiguous']),
    blocking: z.boolean(),
  }),
  z.object({
    kind: z.literal('asset'),
    slot: SlotName,
    filter: z.unknown().nullable(),
    reason: z.string(),
    blocking: z.boolean(),
  }),
  z.object({
    kind: z.literal('input'),
    path: z.string(),
    reason: z.string(),
    blocking: z.boolean(),
  }),
  z.object({
    kind: z.literal('provider'),
    name: z.string(),
    reason: z.string(),
    blocking: z.boolean(),
  }),
  z.object({
    kind: z.literal('action'),
    action: z.string(),
    ref: z.string().optional(),
    reason: z.string(),
    blocking: z.boolean(),
  }),
]);
export type Need = z.infer<typeof Need>;
export interface ParamScope {
  jurisdiction?: string;
  track?: string;
  qualifier?: string;
}
export interface ParamReader {
  refs?(key: string, at?: ParamScope): readonly AssetRef[];
  get(
    key: string,
    at?: ParamScope,
  ): { value: number | string | boolean; unit?: string } | undefined;
  need?(key: string, at?: ParamScope): Need | undefined;
}
// biome-ignore lint/suspicious/noEmptyInterface: 各工作流通过声明合并扩展 provider 接口
export interface OswProviders {}
export interface QuotaStore {
  consume(scope: string, key: string, limit: number, windowSec: number): Promise<boolean>;
}
export interface CacheStore {
  get(key: string): Promise<unknown>;
  put(key: string, v: unknown, ttlSec: number): Promise<void>;
}
export interface StepCtx {
  assets: AssetReader;
  params: ParamReader;
  approvals: readonly Approval[];
  providers: Partial<OswProviders>;
  now: string;
  actor: string;
  stores?: { quota: QuotaStore; cache: CacheStore };
}
export interface StepResult<O> {
  output: O | null;
  verifications: Verification[];
  fills?: Fill[];
  needs: Need[];
}
export interface ParamDecl {
  key: string;
  unit?: string;
  required: boolean;
  description: string;
}
export interface StepDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  input: I;
  output: O;
  reads: readonly string[];
  params: readonly ParamDecl[];
  approval?: { question: string; decision: z.ZodType };
  outputPrivate?: readonly string[];
  run(input: z.infer<I>, ctx: StepCtx): Promise<StepResult<z.infer<O>>>;
}
export interface WorkflowModule {
  key: WorkflowKey;
  version: string;
  steps: readonly StepDef<any, any>[];
  slots: readonly SlotDef[];
  run(
    input: unknown,
    ctx: StepCtx,
  ): Promise<{
    steps: Record<string, StepResult<unknown>>;
    artifact: unknown | null;
    needs: Need[];
  }>;
}
export function stepResult<O>(
  output: O,
  needs: Need[] = [],
  verifications: Verification[] = [],
): StepResult<O> {
  return { output: needs.some((n) => n.blocking) ? null : output, needs, verifications };
}
