import {
  type AssetReader,
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  ParamsSlot,
  type SlotDef,
  type StepCtx,
  type StepDef,
  type StepResult,
  type Verification,
  assetRef,
  createParamReader,
  findApproval,
  getMany,
  stepResult,
  versionHash,
  type z,
} from '@osw/core';
import { DeliveryInput, DeliveryState, initialState } from './models.js';

export const idFor = (name: string) => `landed-delivery/${name}`;
export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function inputNeed(path: string, reason: string, blocking = true): Need {
  return { kind: 'input', path, reason, blocking };
}
export function assetNeed(
  slot: string,
  reason: string,
  blocking = true,
  filter: unknown = null,
): Need {
  return { kind: 'asset', slot, reason, blocking, filter };
}
export function actionNeed(action: string, reason: string, ref?: string, blocking = false): Need {
  return { kind: 'action', action, reason, ref, blocking };
}
export const refMatches = (ref: AssetRef, record: AssetRecordOf<unknown>) =>
  ref.slot === record.slot &&
  ref.id === record.id &&
  ref.versionHash === (ref.fieldset ? record.fieldsetHashes?.[ref.fieldset] : record.versionHash);
export function uniqueRefs(refs: AssetRef[]) {
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()].sort((a, b) =>
    compare(JSON.stringify(a), JSON.stringify(b)),
  );
}
export async function queryAll<S extends z.ZodObject>(
  reader: AssetReader,
  slot: SlotDef<S>,
  filter: Filter | null,
): Promise<AssetRecordOf<z.infer<S>>[]> {
  const records: AssetRecordOf<z.infer<S>>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Page<z.infer<S>> = await reader.query(slot, filter, { limit: 200, cursor });
    records.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Asset source repeated a pagination cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records.sort((a, b) => compare(a.id, b.id));
}
export async function queryIn<S extends z.ZodObject>(
  reader: AssetReader,
  slot: SlotDef<S>,
  field: string,
  ids: string[],
  filter?: Filter,
) {
  const keys = [...new Set(ids)].sort();
  const records: AssetRecordOf<z.infer<S>>[] = [];
  for (let offset = 0; offset < keys.length; offset += 200) {
    const clause: Filter = { field, op: 'in', value: keys.slice(offset, offset + 200) };
    records.push(...(await queryAll(reader, slot, filter ? { all: [clause, filter] } : clause)));
  }
  return records;
}
export function verification(
  ctx: StepCtx,
  step: string,
  asset: AssetRef,
  dimension: string,
  verdict: Verification['verdict'],
  reason: string,
  measured?: Verification['measured'],
  evidence?: string[],
): Verification {
  return {
    asset,
    purpose: idFor(step),
    dimension,
    verdict,
    reason,
    at: ctx.now,
    by: ctx.actor,
    ...(measured ? { measured } : {}),
    ...(evidence ? { evidence: [...new Set(evidence)].slice(0, 20) } : {}),
  };
}
export function approval(
  ctx: StepCtx,
  name: string,
  subject: string,
  hash: string,
  roles: string[],
  decisions: string[],
  needs: Need[],
) {
  const found = findApproval(
    ctx.approvals.filter((a) => a.at <= ctx.now),
    idFor(name),
    hash,
    subject,
  );
  if (found && roles.includes(found.role ?? '') && decisions.includes(found.decision)) return found;
  needs.push({
    kind: 'approval',
    step: idFor(name),
    subject,
    subjectHash: hash,
    question: `Review ${subject}: ${decisions.join(', ')}`,
    blocking: true,
  });
  return undefined;
}
export function numericParam(
  ctx: StepCtx,
  key: string,
  jurisdiction: string,
  needs: Need[],
): number | undefined {
  const scope = { jurisdiction };
  const found = ctx.params.get(key, scope);
  if (!found) {
    needs.push(
      ctx.params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
    );
    return;
  }
  if (typeof found.value !== 'number' || !Number.isFinite(found.value) || found.value < 0) {
    needs.push(inputNeed(`params.${key}`, 'Expected a finite nonnegative value'));
    return;
  }
  return found.value;
}
export async function loadFx(ctx: StepCtx, keys: string[], jurisdiction: string): Promise<StepCtx> {
  const missing = [...new Set(keys)].filter(
    (key) => ctx.params.get(key, { jurisdiction }) === undefined,
  );
  if (!missing.length) return ctx;
  const records = await queryIn(ctx.assets, ParamsSlot, 'key', missing);
  const extra = createParamReader(records, ctx.now, { jurisdiction });
  return {
    ...ctx,
    params: {
      get(key, scope) {
        const prior = ctx.params.need?.(key, scope);
        return prior?.kind === 'param' && prior.reason === 'ambiguous'
          ? undefined
          : (ctx.params.get(key, scope) ?? extra.get(key, scope));
      },
      need(key, scope) {
        const prior = ctx.params.need?.(key, scope);
        return prior?.kind === 'param' && prior.reason === 'ambiguous'
          ? prior
          : (extra.need?.(key, scope) ?? prior);
      },
      refs(key, scope) {
        return ctx.params.get(key, scope) === undefined
          ? (extra.refs?.(key, scope) ?? [])
          : (ctx.params.refs?.(key, scope) ?? []);
      },
    },
  };
}
export const PARAMS = [
  {
    key: 'customs.declarationCurrency',
    required: true,
    description: 'Declaration currency; no implicit default',
  },
  ...[
    'delivery.tolerance.weightPct',
    'delivery.tolerance.volumePct',
    'freight.tolerance.rateCardPct',
    'freight.tolerance.transitDays',
  ].map((key) => ({
    key,
    required: false,
    description: 'Explicit tolerance (Pct values are fractional ratios)',
  })),
];
type Handler = (state: DeliveryState, ctx: StepCtx) => Promise<StepResult<DeliveryState>>;
export function deliveryStep(
  name: string,
  reads: string[],
  handler: Handler,
  initial = false,
): StepDef<any, typeof DeliveryState> {
  return {
    id: idFor(name),
    input: initial ? DeliveryInput : DeliveryState,
    output: DeliveryState,
    reads,
    params: PARAMS,
    async run(raw, ctx) {
      const parsed = (initial ? DeliveryInput : DeliveryState).safeParse(raw);
      if (!parsed.success)
        return {
          output: null,
          verifications: [],
          needs: parsed.error.issues.map((issue) => inputNeed(issue.path.join('.'), issue.message)),
        };
      const state = initial
        ? initialState(parsed.data as DeliveryInput)
        : (parsed.data as DeliveryState);
      const refs: AssetRef[] = [];
      const parameterRefs: AssetRef[] = [];
      let example = state.example;
      const remember = (records: AssetRecordOf<unknown>[]) => {
        for (const record of records) {
          refs.push(assetRef(record));
          if (!record.example) example = false;
        }
      };
      const traced: StepCtx = {
        ...ctx,
        assets: {
          async query(slot, filter, opts) {
            const page = await ctx.assets.query(slot, filter, opts);
            remember(page.items);
            return page;
          },
          async get(slot, id) {
            const record = await ctx.assets.get(slot, id);
            if (record) remember([record]);
            return record;
          },
        },
        params: {
          ...ctx.params,
          get(key, scope) {
            const found = ctx.params.get(key, scope);
            if (found) {
              const used = ctx.params.refs?.(key, scope) ?? [];
              refs.push(...used);
              parameterRefs.push(...used);
              if (!used.length) example = false;
            }
            return found;
          },
        },
      };
      const result = await handler(state, traced);
      if (result.output) {
        const parameters = await getMany(
          ctx.assets,
          ParamsSlot,
          parameterRefs.map((ref) => ref.id),
        );
        if (
          parameterRefs.some(
            (ref) => !parameters.some((record) => refMatches(ref, record) && record.example),
          )
        )
          example = false;
        result.output.sources = uniqueRefs([...result.output.sources, ...refs]);
        result.output.example = example;
        DeliveryState.parse(result.output);
      }
      return result;
    },
  };
}
export async function validateArtifact(
  artifact: { kind: string; artifactVersion: string; hash: string; body: unknown },
  needs: Need[],
) {
  if (
    artifact.artifactVersion.split('.')[0] !== '0' ||
    (await versionHash(artifact.body)) !== artifact.hash
  )
    needs.push(inputNeed(artifact.kind, 'Artifact version or body hash does not match'));
}
export { stepResult };
