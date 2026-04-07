import SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { encodeFunctionData, type Abi, type Address } from 'viem';

import type {
  ExecutionConfig,
  OperationResult,
  TransactionStatusUpdate,
} from '@openzeppelin/ui-types';

export interface SafeExecutableTransaction {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

function isIframeContext(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

export async function executeTransactionWithSafeApp(
  transactionData: SafeExecutableTransaction,
  executionConfig: ExecutionConfig,
  onStatusChange: (status: string, details: TransactionStatusUpdate) => void,
  expectedChainId?: number
): Promise<OperationResult | null> {
  if (!isIframeContext() || executionConfig.method !== 'eoa') {
    return null;
  }

  const sdk = new SafeAppsSDK();

  let safeInfo: { chainId: number; isReadOnly: boolean };
  try {
    safeInfo = await sdk.safe.getInfo();
  } catch {
    return null;
  }

  if (expectedChainId && safeInfo.chainId !== expectedChainId) {
    throw new Error(
      `Safe is connected to chain ${safeInfo.chainId}, but the selected network uses chain ${expectedChainId}.`
    );
  }

  if (safeInfo.isReadOnly) {
    throw new Error(
      'Safe app is in read-only mode. Open the Safe with a signing owner to submit transactions.'
    );
  }

  const data = encodeFunctionData({
    abi: transactionData.abi,
    functionName: transactionData.functionName as never,
    args: (transactionData.args ?? []) as never,
  });

  onStatusChange('pendingSignature', {});

  // Don't await — Safe's modal blocks the Promise until the user
  // confirms or adds to batch. Return immediately so the UI stays responsive.
  sdk.txs
    .send({
      txs: [
        {
          to: transactionData.address,
          value: (transactionData.value ?? 0n).toString(),
          data,
        },
      ],
    })
    .catch(() => {
      // User rejected or Safe communication failed
    });

  return { id: 'safe-pending' };
}
