import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionConfig, OperationResult } from '@openzeppelin/ui-types';

import { EvmAccessManagerService } from '../EvmAccessManagerService';

const EXECUTION_CONFIG = { method: 'eoa', allowAny: true } as ExecutionConfig;
const MANAGER_ADDRESS = '0x1000000000000000000000000000000000000001';
const ACCOUNT_ADDRESS = '0x2000000000000000000000000000000000000002';

describe('EvmAccessManagerService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('hydrates authority graph role seeds from live AccessManager getters', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'getRoleAdmin':
          return 2n;
        case 'getRoleGuardian':
          return 3n;
        case 'getRoleGrantDelay':
          return 60;
        case 'getAccess':
          return [1_700_000_000n, 45, 90, 1_700_000_100n];
        default:
          throw new Error(`unexpected function ${functionName}`);
      }
    });
    const service = new EvmAccessManagerService(
      { readContract } as unknown as import('viem').PublicClient,
      null,
      1
    );

    const roles = await service.hydrateRolesFromSubgraph(MANAGER_ADDRESS, [
      {
        roleId: '7',
        label: null,
        adminRoleId: '0',
        guardianRoleId: '0',
        grantDelay: 0,
        members: [{ address: ACCOUNT_ADDRESS, since: 1, executionDelay: 0 }],
      },
    ]);

    expect(roles).toEqual([
      {
        roleId: '7',
        label: null,
        adminRoleId: '2',
        guardianRoleId: '3',
        grantDelay: 60,
        members: [
          {
            address: ACCOUNT_ADDRESS,
            since: 1_700_000_000,
            executionDelay: 45,
            pendingDelay: { newDelay: 90, effect: 1_700_000_100 },
          },
        ],
      },
    ]);
  });

  it('rejects unverified indexed state when live access hydration fails', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'getRoleAdmin':
          return 2n;
        case 'getRoleGuardian':
          return 3n;
        case 'getRoleGrantDelay':
          return 60;
        case 'getAccess':
          throw new Error('rate limited');
        default:
          throw new Error(`unexpected function ${functionName}`);
      }
    });
    const service = new EvmAccessManagerService(
      { readContract } as unknown as import('viem').PublicClient,
      null,
      1
    );
    const member = { address: ACCOUNT_ADDRESS, since: 123, executionDelay: 45 };

    await expect(
      service.hydrateRolesFromSubgraph(MANAGER_ADDRESS, [
        {
          roleId: '7',
          label: null,
          adminRoleId: '0',
          guardianRoleId: '0',
          grantDelay: 0,
          members: [member],
        },
      ])
    ).rejects.toThrow('rate limited');
  });

  it('hydrates authority graph targets from live AccessManager getters', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isTargetClosed') return true;
      if (functionName === 'getTargetAdminDelay') return 30;
      throw new Error(`unexpected function ${functionName}`);
    });
    const service = new EvmAccessManagerService(
      { readContract } as unknown as import('viem').PublicClient,
      null,
      1
    );

    const targets = await service.hydrateTargetsFromSubgraph(MANAGER_ADDRESS, [
      {
        target: ACCOUNT_ADDRESS,
        isClosed: false,
        adminDelay: 0,
        functionRoles: [{ selector: '0x12345678', roleId: '7' }],
      },
    ]);

    expect(targets).toEqual([
      {
        target: ACCOUNT_ADDRESS,
        isClosed: true,
        adminDelay: 30,
        functionRoles: [{ selector: '0x12345678', roleId: '7' }],
      },
    ]);
  });

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
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.objectContaining({ id: 1 }),
      })
    );
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
  it('removes revoked members and preserves pending delay reductions to zero', async () => {
    const service = new EvmAccessManagerService(
      {
        readContract: vi.fn(async ({ functionName, args }) => {
          if (functionName === 'getAccess')
            return args[1] === ACCOUNT_ADDRESS ? [100, 45, 0, 200] : [0, 0, 0, 0];
          return 0;
        }),
      } as unknown as import('viem').PublicClient,
      null,
      1
    );
    const [role] = await service.hydrateRolesFromSubgraph(MANAGER_ADDRESS, [
      {
        roleId: '7',
        label: null,
        adminRoleId: '0',
        guardianRoleId: '0',
        grantDelay: 0,
        members: [ACCOUNT_ADDRESS, MANAGER_ADDRESS].map((address) => ({
          address,
          since: 1,
          executionDelay: 0,
        })),
      },
    ]);
    expect(role.members).toEqual([
      {
        address: ACCOUNT_ADDRESS,
        since: 100,
        executionDelay: 45,
        pendingDelay: { newDelay: 0, effect: 200 },
      },
    ]);
  });

  it('validates live operation schedule, nonce, readiness and expiration without log scans', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const schedules = [1_700_000_100, 1_699_999_999, 0, 1_700_000_100, 1_699_999_900];
    const nonces = [1, 1, 1, 2, 1];
    const readContract = vi.fn(async ({ functionName, args }) => {
      if (functionName === 'expiration') return 100;
      const i = Number(BigInt(args[0])) - 1;
      return functionName === 'getSchedule' ? schedules[i] : nonces[i];
    });
    const service = new EvmAccessManagerService(
      { readContract } as unknown as import('viem').PublicClient,
      null,
      1
    );
    const candidates = schedules.map((_, i) => ({
      operationId: `0x${(i + 1).toString(16).padStart(64, '0')}`,
      nonce: 1,
      schedule: 1,
      caller: ACCOUNT_ADDRESS,
      target: MANAGER_ADDRESS,
      data: '0x12345678',
      isReady: true,
      isExpired: false,
    }));
    const operations = await service.hydrateOperationsFromSubgraph(MANAGER_ADDRESS, candidates);
    expect(operations).toEqual([
      { ...candidates[0], schedule: schedules[0], isReady: false },
      { ...candidates[1], schedule: schedules[1], isReady: true },
    ]);
    readContract.mockClear();
    await expect(service.hydrateOperationsFromSubgraph(MANAGER_ADDRESS, [])).resolves.toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
    readContract.mockRejectedValue(new Error('offline'));
    await expect(
      service.hydrateOperationsFromSubgraph(MANAGER_ADDRESS, candidates)
    ).rejects.toThrow('offline');
  });
});
