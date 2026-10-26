import { HttpSource } from '../http/index.js';
import {
  Approval,
  type AssetSource,
  Fill,
  IsoDateTime,
  Need,
  type ParamScope,
  type RecordResult,
  SHARED_SLOTS,
  type StepCtx,
  type StepDef,
  type StepResult,
  Verification,
  type WorkflowModule,
  createParamReader,
  loadParameterRecords,
} from '../index.js';
import { collectSlots } from './discover.js';
import { FileSource } from './file-source.js';

export interface RunOptions {
  source: AssetSource;
  now?: string;
  actor?: string;
  approvals?: readonly Approval[];
  providers?: StepCtx['providers'];
  stores?: StepCtx['stores'];
  record?: boolean;
}

export interface WriteReceipt {
  kind: 'verification' | 'fill';
  index: number;
  result: RecordResult;
}

export type WorkflowResult = Awaited<ReturnType<WorkflowModule['run']>>;
export interface Execution<T> {
  result: T;
  exitCode: 0 | 2 | 3;
  records?: WriteReceipt[];
}

export async function openSource(
  assets: string,
  workflows: readonly WorkflowModule[],
): Promise<AssetSource> {
  if (/^https?:\/\//u.test(assets)) {
    return new HttpSource(assets, { token: process.env.OSW_TOKEN });
  }
  return FileSource.open(assets, collectSlots(SHARED_SLOTS, workflows));
}

function inputScope(input: unknown): ParamScope {
  if (!input || typeof input !== 'object') return {};
  const object = input as Record<string, unknown>;
  const nested = object.brief ?? object.input;
  const base = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : object;
  return {
    ...(typeof base.jurisdiction === 'string' ? { jurisdiction: base.jurisdiction } : {}),
    ...(typeof base.track === 'string' ? { track: base.track } : {}),
  };
}

export async function prepareContext(
  steps: readonly StepDef[],
  input: unknown,
  options: RunOptions,
): Promise<StepCtx> {
  const now = IsoDateTime.parse(options.now ?? new Date().toISOString());
  const keys = [...new Set(steps.flatMap((step) => step.params.map((param) => param.key)))];
  const records = await loadParameterRecords(options.source, [...keys, 'fx'], true);

  return {
    assets: options.source,
    params: createParamReader(records, now, inputScope(input)),
    approvals: (options.approvals ?? []).map((approval) => Approval.parse(approval)),
    now,
    actor: options.actor ?? 'osw:runner@0.1.0',
    providers: options.providers ?? {},
    ...(options.stores ? { stores: options.stores } : {}),
  };
}

export function validateStepResult(step: StepDef, result: StepResult<unknown>): void {
  for (const need of result.needs) Need.parse(need);
  for (const verification of result.verifications) Verification.parse(verification);
  for (const fill of result.fills ?? []) Fill.parse(fill);
  if ((result.output === null) !== result.needs.some((need) => need.blocking)) {
    throw new Error(`${step.id} violated output/blocking-need invariant`);
  }
  if (result.output !== null) step.output.parse(result.output);
}

export async function recordResults(
  source: AssetSource,
  results: readonly StepResult<unknown>[],
): Promise<WriteReceipt[]> {
  const receipts: WriteReceipt[] = [];
  const verifications = results.flatMap((result) => result.verifications);
  const fills = results.flatMap((result) => result.fills ?? []);
  for (const [kind, items] of [
    ['verification', verifications],
    ['fill', fills],
  ] as const) {
    for (let offset = 0; offset < items.length; offset += 200) {
      const batch = items.slice(offset, offset + 200);
      let outcomes: RecordResult[];
      try {
        if (kind === 'verification') {
          outcomes = await source.recordVerification(batch as Verification[]);
        } else if (source.applyFills) {
          outcomes = await source.applyFills(batch as Fill[]);
        } else {
          outcomes = batch.map(() => ({ status: 'unsupported' }));
        }
        if (outcomes.length !== batch.length) throw new Error('Invalid write response length');
      } catch (error) {
        outcomes = batch.map(() => ({
          status: 'rejected',
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
      outcomes.forEach((result, index) => receipts.push({ kind, index: offset + index, result }));
    }
  }
  return receipts;
}

function exitCode(blocked: boolean, receipts: readonly WriteReceipt[]): 0 | 2 | 3 {
  if (blocked) return 2;
  return receipts.some(({ result }) => !['recorded', 'duplicate'].includes(result.status)) ? 3 : 0;
}

export async function executeStep(
  step: StepDef,
  input: unknown,
  options: RunOptions,
): Promise<Execution<StepResult<unknown>>> {
  const parsed = step.input.safeParse(input);
  if (!parsed.success) {
    return {
      result: {
        output: null,
        verifications: [],
        needs: parsed.error.issues.map((issue) => ({
          kind: 'input' as const,
          path: issue.path.map(String).join('.') || 'input',
          reason: issue.message,
          blocking: true,
        })),
      },
      exitCode: 2,
    };
  }
  const context = await prepareContext([step], parsed.data, options);
  const result = await step.run(parsed.data, context);
  validateStepResult(step, result);
  const records = options.record ? await recordResults(options.source, [result]) : undefined;
  return {
    result,
    exitCode: exitCode(result.output === null, records ?? []),
    ...(records ? { records } : {}),
  };
}

export async function executeWorkflow(
  workflow: WorkflowModule,
  input: unknown,
  options: RunOptions,
): Promise<Execution<WorkflowResult>> {
  const context = await prepareContext(workflow.steps, input, options);
  const result = await workflow.run(input, context);
  for (const [id, output] of Object.entries(result.steps)) {
    const step = workflow.steps.find(
      (candidate) => candidate.id === id || candidate.id.endsWith(`/${id}`),
    );
    if (!step) throw new Error(`Workflow returned unknown step ${id}`);
    validateStepResult(step, output);
  }
  for (const need of result.needs) Need.parse(need);
  if ((result.artifact === null) !== result.needs.some((need) => need.blocking)) {
    throw new Error(`${workflow.key} violated artifact/blocking-need invariant`);
  }
  const records = options.record
    ? await recordResults(options.source, Object.values(result.steps))
    : undefined;
  return {
    result,
    exitCode: exitCode(result.artifact === null, records ?? []),
    ...(records ? { records } : {}),
  };
}
