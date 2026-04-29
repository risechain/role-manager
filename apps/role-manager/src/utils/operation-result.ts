import type { OperationResult } from '@openzeppelin/ui-types';

export const SAFE_PENDING_RESULT_ID = 'safe-pending';

export function isSafePendingResult(result: OperationResult | null | undefined): boolean {
  return result?.id === SAFE_PENDING_RESULT_ID;
}
