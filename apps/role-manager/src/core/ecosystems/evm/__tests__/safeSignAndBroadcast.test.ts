import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionConfig } from '@openzeppelin/ui-types';

import { wrapSignAndBroadcastForSafe } from '../safeSignAndBroadcast';

const viemMocks = vi.hoisted(() => ({
  createWalletClient: vi.fn(),
  custom: vi.fn((provider: unknown) => ({ provider })),
  defineChain: vi.fn((chain: unknown) => chain),
  writeContract: vi.fn(),
}));

vi.mock('viem', () => ({
  createWalletClient: viemMocks.createWalletClient,
  custom: viemMocks.custom,
  defineChain: viemMocks.defineChain,
}));

vi.mock('viem/actions', () => ({
  writeContract: viemMocks.writeContract,
}));

const EXECUTION_CONFIG = { method: 'eoa', allowAny: true } as ExecutionConfig;

describe('wrapSignAndBroadcastForSafe', () => {
  const originalParent = window.parent;
  const originalEthereum = (window as unknown as { ethereum?: unknown }).ethereum;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });

    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: originalEthereum,
    });
  });

  it('returns the tx hash from direct EOA fallback without requiring an RPC URL', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_requestAccounts') return ['0x2000000000000000000000000000000000000002'];
        return null;
      }),
    };
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: provider,
    });

    viemMocks.createWalletClient.mockReturnValue({
      getAddresses: vi.fn().mockResolvedValue(['0x2000000000000000000000000000000000000002']),
    });
    viemMocks.writeContract.mockResolvedValue('0xsubmittedhash');

    const original = vi
      .fn()
      .mockRejectedValue(new Error('Transaction failed (EOA): No chain was provided'));
    const onStatus = vi.fn();
    const signAndBroadcast = wrapSignAndBroadcastForSafe(original);

    const result = await signAndBroadcast(
      {
        address: '0x1000000000000000000000000000000000000001',
        abi: [
          {
            type: 'function',
            name: 'grantRole',
            stateMutability: 'nonpayable',
            inputs: [],
            outputs: [],
          },
        ],
        functionName: 'grantRole',
        args: [],
        value: 0n,
      },
      EXECUTION_CONFIG,
      onStatus
    );

    expect(result).toEqual({ txHash: '0xsubmittedhash' });
    expect(onStatus).toHaveBeenCalledWith('pendingSignature', {});
    expect(viemMocks.writeContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chain: expect.objectContaining({ id: 1 }),
      })
    );
  });
});
