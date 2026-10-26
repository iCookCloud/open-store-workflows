import type { AssetRef } from '@osw/core';
import { type EsignProvider, bytesHash } from './types.js';
export interface ManualSigningReceipt {
  contentHash: string;
  signedAt: string;
  envelopeRef: string;
  signers: AssetRef[];
  signedPdf: Uint8Array;
  signedPdfHash: string;
  auditCertificate: Uint8Array;
  auditHash: string;
}
// 宿主上传真实成品和审计证书；缺件保持 pending，不伪造签署过程。
export function manualEsign(receipts: readonly ManualSigningReceipt[]): EsignProvider {
  return {
    async collect(input) {
      const receipt = receipts.find((r) => r.contentHash === input.contentHash);
      if (!receipt) return null;
      if (
        !receipt.signedPdf.length ||
        !receipt.auditCertificate.length ||
        !receipt.envelopeRef ||
        input.signers.some(
          (s) =>
            !receipt.signers.some(
              (r) => r.slot === s.slot && r.id === s.id && r.versionHash === s.versionHash,
            ),
        )
      )
        throw new Error('Incomplete signing receipt');
      if (
        (await bytesHash(receipt.signedPdf)) !== receipt.signedPdfHash ||
        (await bytesHash(receipt.auditCertificate)) !== receipt.auditHash
      )
        throw new Error('Signing receipt hash mismatch');
      return structuredClone(receipt);
    },
  };
}
