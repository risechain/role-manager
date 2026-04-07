import { describe, expect, it, vi } from 'vitest';

import type { ExecutionConfig, OperationResult } from '@openzeppelin/ui-types';

import { EvmAccessManagerService } from '../EvmAccessManagerService';

const EXECUTION_CONFIG = { method: 'eoa', allowAny: true } as ExecutionConfig;
const MANAGER_ADDRESS = '0x1000000000000000000000000000000000000001';
const ACCOUNT_ADDRESS = '0x2000000000000000000000000000000000000002';

describe('EvmAccessManagerService', () => {
  it('delegates write operations to the injected transaction executor', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    } as unknown as import('viem').PublicClient;

    const service = new EvmAccessManagerService(publicClient, null, 1);
    const expectedResult: OperationResult = { id: '0xsafehash' };
    const executor = vi.fn().mockResolvedValue(expectedResult);
    const onStatus = vi.fn();

    service.setTransactionExecutor(executor);

    const result = await service.grantRole(
      MANAGER_ADDRESS,
      '1',
      ACCOUNT_ADDRESS,
      0,
      EXECUTION_CONFIG,
      onStatus
    );

    expect(result).toEqual(expectedResult);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        address: MANAGER_ADDRESS,
        functionName: 'grantRole',
        args: [1n, ACCOUNT_ADDRESS, 0],
        value: 0n,
      }),
      EXECUTION_CONFIG,
      onStatus
    );
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('returns after wallet submission in fallback mode without waiting for a receipt', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    } as unknown as import('viem').PublicClient;

    const service = new EvmAccessManagerService(publicClient, null, 1);
    const walletClient = {
      account: ACCOUNT_ADDRESS,
      chain: undefined,
      sendTransaction: vi.fn().mockResolvedValue('0xsubmittedhash'),
    };
    const onStatus = vi.fn();

    service.setWalletClientProvider(
      async () => walletClient as unknown as import('viem').WalletClient
    );

    const result = await service.grantRole(
      MANAGER_ADDRESS,
      '1',
      ACCOUNT_ADDRESS,
      60,
      EXECUTION_CONFIG,
      onStatus
    );

    expect(result).toEqual({ id: '0xsubmittedhash' });
    expect(onStatus).toHaveBeenCalledWith('pendingSignature', {});
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('falls back to direct wallet execution when the runtime executor has no bound chain', async () => {
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    } as unknown as import('viem').PublicClient;

    const service = new EvmAccessManagerService(publicClient, null, 1);
    const walletClient = {
      account: ACCOUNT_ADDRESS,
      chain: { id: 1 },
      sendTransaction: vi.fn().mockResolvedValue('0xfallbackhash'),
    };
    const executor = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Transaction failed (EOA): No chain was provided to the request. Please provide a chain.'
        )
      );

    service.setTransactionExecutor(executor);
    service.setWalletClientProvider(
      async () => walletClient as unknown as import('viem').WalletClient
    );

    const result = await service.grantRole(
      MANAGER_ADDRESS,
      '0',
      ACCOUNT_ADDRESS,
      0,
      EXECUTION_CONFIG,
      vi.fn()
    );

    expect(result).toEqual({ id: '0xfallbackhash' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});
