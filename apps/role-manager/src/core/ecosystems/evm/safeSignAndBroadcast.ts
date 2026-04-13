/**
 * Patched signAndBroadcast wrapper.
 *
 * Two concerns:
 * 1. Safe iframe: route through Safe Apps SDK for tx proposals.
 * 2. EOA fallback: when the adapter's writeContract fails with "No chain",
 *    retry using viem directly with proper chain config.
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
 * Send transaction via Safe Apps SDK (fire-and-forget).
 */
async function sendViaSafe(
  address: string,
  abi: unknown[],
  functionName: string,
  args: unknown[],
  value: bigint,
  onStatusChange: (status: string, details: TransactionStatusUpdate) => void
): Promise<{ txHash: string }> {
  const { encodeFunctionData } = await import('viem');
  const data = encodeFunctionData({
    abi: abi as import('viem').Abi,
    functionName: functionName as never,
    args: args as never,
  });

  onStatusChange('pendingSignature', {} as TransactionStatusUpdate);

  const SafeAppsSDK = (await import('@safe-global/safe-apps-sdk')).default;
  const sdk = new SafeAppsSDK();

  sdk.txs
    .send({ txs: [{ to: address, value: value.toString(), data }] })
    .catch(() => {});

  return { txHash: 'safe-pending' };
}

/**
 * Send transaction directly via viem + window.ethereum.
 * Used as fallback when the adapter fails with "No chain".
 */
async function sendViaDirectEoa(
  address: string,
  abi: unknown[],
  functionName: string,
  args: unknown[],
  value: bigint,
  onStatusChange: (status: string, details: TransactionStatusUpdate) => void
): Promise<{ txHash: string }> {
  const { createWalletClient, createPublicClient, custom, http } = await import('viem');

  const provider = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!provider) throw new Error('No wallet detected');

  type EIP1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  const ethProvider = provider as EIP1193;

  await ethProvider.request({ method: 'eth_requestAccounts' });

  const chainHex = (await ethProvider.request({ method: 'eth_chainId' })) as string;
  const chainId = parseInt(chainHex, 16);

  const { defineChain } = await import('viem');
  const chain = defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });

  const walletClient = createWalletClient({
    chain,
    transport: custom(provider as Parameters<typeof custom>[0]),
  });

  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('No account connected');

  onStatusChange('pendingSignature', {} as TransactionStatusUpdate);

  const { writeContract } = await import('viem/actions');
  const hash = await writeContract(walletClient, {
    account,
    chain,
    address: address as `0x${string}`,
    abi: abi as import('viem').Abi,
    functionName: functionName as never,
    args: args as never,
    value,
  });

  // Wait for receipt
  const rpcUrl = (chain.rpcUrls.default.http as readonly string[])[0] as string | undefined;
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  try {
    await publicClient.waitForTransactionReceipt({ hash });
  } catch {
    // Receipt wait failed — tx was still submitted
  }

  return { txHash: hash };
}

/**
 * Wraps signAndBroadcast to handle both Safe and EOA edge cases.
 */
export function wrapSignAndBroadcastForSafe(
  original: SignAndBroadcastFn
): SignAndBroadcastFn {
  return async (transactionData, executionConfig, onStatusChange, runtimeApiKey) => {
    const txData = transactionData as {
      address?: string;
      abi?: unknown[];
      functionName?: string;
      args?: unknown[];
      value?: bigint;
    };

    const hasEnoughInfo = !!(txData.address && txData.abi && txData.functionName);

    // Safe iframe: always route through Safe SDK
    if (isIframe() && hasEnoughInfo) {
      return sendViaSafe(
        txData.address!,
        txData.abi!,
        txData.functionName!,
        txData.args ?? [],
        txData.value ?? 0n,
        onStatusChange
      );
    }

    // EOA: try original first, fall back to direct viem on "No chain" error
    try {
      return await original(transactionData, executionConfig, onStatusChange, runtimeApiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (hasEnoughInfo && msg.includes('No chain was provided')) {
        return sendViaDirectEoa(
          txData.address!,
          txData.abi!,
          txData.functionName!,
          txData.args ?? [],
          txData.value ?? 0n,
          onStatusChange
        );
      }
      throw err;
    }
  };
}
