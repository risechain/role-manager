/**
 * Safe-aware signAndBroadcast wrapper.
 *
 * When running inside a Safe iframe, intercepts write transactions and
 * routes them through the Safe Apps SDK instead of the adapter's EOA strategy.
 * This ensures all CRUD operations create Safe proposals regardless of which
 * page or mutation hook initiates them.
 */

import type { ExecutionConfig, TransactionStatusUpdate } from '@openzeppelin/ui-types';

type SignAndBroadcastFn = (
  transactionData: unknown,
  executionConfig: ExecutionConfig,
  onStatusChange: (status: string, details: TransactionStatusUpdate) => void,
  runtimeApiKey?: string
) => Promise<{ txHash: string }>;

function isIframe(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/**
 * Wraps a runtime's signAndBroadcast so that Safe iframe contexts
 * route through the Safe Apps SDK. Falls back to the original
 * signAndBroadcast for non-Safe contexts.
 */
export function wrapSignAndBroadcastForSafe(
  original: SignAndBroadcastFn
): SignAndBroadcastFn {
  if (!isIframe()) return original;

  return async (transactionData, executionConfig, onStatusChange, runtimeApiKey) => {
    // Extract tx params from the adapter's formatted transaction data
    const txData = transactionData as {
      address?: string;
      abi?: unknown[];
      functionName?: string;
      args?: unknown[];
      value?: bigint;
      data?: string;
    };

    // Only intercept if we have enough info to encode
    if (txData.address && txData.abi && txData.functionName) {
      try {
        const { encodeFunctionData } = await import('viem');
        const data = encodeFunctionData({
          abi: txData.abi as import('viem').Abi,
          functionName: txData.functionName as never,
          args: (txData.args ?? []) as never,
        });

        onStatusChange('pendingSignature', {} as TransactionStatusUpdate);

        const SafeAppsSDK = (await import('@safe-global/safe-apps-sdk')).default;
        const sdk = new SafeAppsSDK();

        // Fire-and-forget: Safe's modal blocks the Promise until user
        // confirms or adds to batch. Return immediately for responsive UI.
        sdk.txs
          .send({
            txs: [
              {
                to: txData.address,
                value: (txData.value ?? 0n).toString(),
                data,
              },
            ],
          })
          .catch(() => {
            // User rejected or Safe communication failed
          });

        return { txHash: 'safe-pending' };
      } catch {
        // Encoding failed — fall through to original
      }
    }

    return original(transactionData, executionConfig, onStatusChange, runtimeApiKey);
  };
}
