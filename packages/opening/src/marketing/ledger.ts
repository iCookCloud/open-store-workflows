import {
  type Money,
  type Need,
  type ParamScope,
  type StepCtx,
  type Verification,
  convertMoney,
  divMoney,
  sumMoney,
} from '@osw/core';
import { inputNeed, verification } from '../helpers.js';
import { type LedgerEntry, LedgerRow } from './models.js';

const COOPERATION = ['candidate', 'contacted', 'agreed', 'visited', 'published', 'settled'];
export function marketingLedger(
  entries: LedgerEntry[],
  previous: LedgerEntry[],
  currency: string,
  ctx: StepCtx,
  scope: ParamScope,
  requireJurisdictionDisclosure = false,
) {
  const needs: Need[] = [];
  const missingEvidence: string[] = [];
  const rows: ReturnType<typeof LedgerRow.parse>[] = [];
  const verifications: Verification[] = [];
  const prior = new Map(previous.map((row) => [row.id, row]));
  for (const row of entries) {
    const old = prior.get(row.id);
    if (row.creatorRef && old && old.status !== row.status) {
      const index = COOPERATION.indexOf(old.status);
      if (index < 0 || COOPERATION[index + 1] !== row.status)
        needs.push(
          inputNeed(
            `ledger.${row.id}.status`,
            'Creator cooperation may advance only one state at a time',
          ),
        );
    }
    const amount = row.barterCost ?? row.spend;
    if (amount.amount < 0)
      needs.push(inputNeed(`ledger.${row.id}.spend`, 'Marketing spend must be nonnegative'));
    if (
      (requireJurisdictionDisclosure || row.paid || amount.amount > 0) &&
      ['published', 'settled'].includes(row.status) &&
      !row.disclosureEvidence?.trim()
    )
      needs.push(
        inputNeed(
          `ledger.${row.id}.disclosureEvidence`,
          'Paid, barter, and jurisdiction-required publications need disclosure evidence',
        ),
      );
    if (
      ['done', 'published', 'settled'].includes(row.status) &&
      amount.amount > 0 &&
      !row.evidence.some((evidence) => evidence.trim())
    )
      missingEvidence.push(row.id);
    const converted = convertMoney(amount, currency, ctx.params, scope);
    needs.push(...converted.needs);
    if (!converted.value) continue;
    const spend = converted.value;
    rows.push(LedgerRow.parse({ ...row, spend }));
    if (row.creatorRef && ['published', 'settled'].includes(row.status)) {
      const verdict = row.visits > 0 ? 'holds' : row.status === 'settled' ? 'fails' : 'pending';
      const v = verification(
        ctx,
        row.creatorRef,
        'opening/planMarketing',
        'cac',
        verdict,
        row.visits > 0
          ? 'Published collaboration produced attributed visits'
          : 'No attributed visits recorded',
        row.evidence,
      );
      if (row.visits > 0 && spend.amount > 0)
        v.measured = {
          field: 'cac',
          expected: null,
          actual: divMoney(spend, row.visits)!.amount,
          unit: currency,
        };
      verifications.push(v);
    }
  }
  const spend: Money = sumMoney(
    rows.map((row) => row.spend),
    currency,
  );
  const visits = rows.reduce((sum, row) => sum + row.visits, 0);
  const cac = spend.amount > 0 && visits > 0 ? divMoney(spend, visits) : null;
  return { rows, spend, visits, cac, missingEvidence, needs, verifications };
}
