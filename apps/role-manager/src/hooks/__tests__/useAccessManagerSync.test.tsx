import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessManagerRole, AccessManagerService } from '../../types/access-manager';
import { useAccessManagerSync } from '../useAccessManagerSync';

const roleSeed: AccessManagerRole = {
  roleId: '7',
  label: null,
  adminRoleId: '0',
  guardianRoleId: '18446744073709551615',
  grantDelay: 0,
  members: [],
};

const hydratedRole: AccessManagerRole = {
  ...roleSeed,
  adminRoleId: '2',
  guardianRoleId: '3',
  grantDelay: 60,
};

const targetSeed = {
  target: '0x3000000000000000000000000000000000000003',
  isClosed: false,
  adminDelay: 0,
  functionRoles: [{ selector: '0x12345678', roleId: '7' }],
};

const hydratedTarget = { ...targetSeed, isClosed: true, adminDelay: 30 };

const scheduledOperation = {
  operationId: `0x${'11'.repeat(32)}`,
  nonce: 1,
  schedule: 1_700_000_000,
  caller: '0x4000000000000000000000000000000000000004',
  target: targetSeed.target,
  data: '0x12345678',
  isReady: true,
  isExpired: false,
};

const graphqlMocks = vi.hoisted(() => ({
  isSubgraphAvailable: vi.fn(),
  fetchRolesFromSubgraph: vi.fn(),
  fetchTargetsFromSubgraph: vi.fn(),
  fetchEventsFromSubgraph: vi.fn(),
  buildEventHistoryFromRoles: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../core/ecosystems/evm/accessManagerGraphql', () => graphqlMocks);

vi.mock('../../core/storage/AccessManagerSyncStorage', () => ({
  accessManagerSyncStorage: storageMocks,
}));

describe('useAccessManagerSync authority graph strategy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates graph discoveries and loads non-indexed operations from RPC', async () => {
    storageMocks.get.mockResolvedValue(null);
    storageMocks.save.mockResolvedValue(undefined);
    graphqlMocks.isSubgraphAvailable.mockResolvedValue(true);
    graphqlMocks.fetchRolesFromSubgraph.mockResolvedValue([roleSeed]);
    graphqlMocks.fetchTargetsFromSubgraph.mockResolvedValue([targetSeed]);
    graphqlMocks.fetchEventsFromSubgraph.mockResolvedValue([]);
    graphqlMocks.buildEventHistoryFromRoles.mockReturnValue([]);

    const service = {
      getDeploymentBlock: vi.fn().mockResolvedValue(24_166_604n),
      hydrateRolesFromSubgraph: vi.fn().mockResolvedValue([hydratedRole]),
      hydrateTargetsFromSubgraph: vi.fn().mockResolvedValue([hydratedTarget]),
      getScheduledOperations: vi.fn().mockResolvedValue([scheduledOperation]),
    } as unknown as AccessManagerService;

    const { result, unmount } = renderHook(() =>
      useAccessManagerSync(
        service,
        '0x1000000000000000000000000000000000000001',
        1,
        'ethereum-mainnet'
      )
    );

    await waitFor(() => {
      expect(result.current.roles).toEqual([hydratedRole]);
      expect(result.current.targets).toEqual([hydratedTarget]);
      expect(result.current.operations).toEqual([scheduledOperation]);
    });

    expect(service.getScheduledOperations).toHaveBeenCalledWith(
      '0x1000000000000000000000000000000000000001',
      { fromBlock: 24_166_604n }
    );
    unmount();
  });

  it('polls operation logs incrementally from the last cached block', async () => {
    vi.useFakeTimers();
    let cached: Parameters<typeof storageMocks.save>[0] | null = null;
    storageMocks.get.mockImplementation(async () => cached);
    storageMocks.save.mockImplementation(async (record) => {
      cached = record;
    });
    graphqlMocks.isSubgraphAvailable.mockResolvedValue(true);
    graphqlMocks.fetchRolesFromSubgraph.mockResolvedValue([roleSeed]);
    graphqlMocks.fetchTargetsFromSubgraph.mockResolvedValue([targetSeed]);
    graphqlMocks.fetchEventsFromSubgraph.mockResolvedValue([]);
    graphqlMocks.buildEventHistoryFromRoles.mockReturnValue([]);

    const getBlockNumber = vi.fn().mockResolvedValueOnce(100n).mockResolvedValueOnce(105n);
    const service = {
      getDeploymentBlock: vi.fn().mockResolvedValue(42n),
      hydrateRolesFromSubgraph: vi.fn().mockResolvedValue([hydratedRole]),
      hydrateTargetsFromSubgraph: vi.fn().mockResolvedValue([hydratedTarget]),
      getScheduledOperations: vi.fn().mockResolvedValue([scheduledOperation]),
      publicClient: {
        getBlockNumber,
        readContract: vi.fn().mockResolvedValue(0),
      },
    } as unknown as AccessManagerService;

    const { unmount } = renderHook(() =>
      useAccessManagerSync(
        service,
        '0x1000000000000000000000000000000000000001',
        1,
        'ethereum-mainnet'
      )
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(service.getScheduledOperations).toHaveBeenNthCalledWith(
      1,
      '0x1000000000000000000000000000000000000001',
      { fromBlock: 42n, toBlock: 100n }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(service.getScheduledOperations).toHaveBeenNthCalledWith(
      2,
      '0x1000000000000000000000000000000000000001',
      {
        fromBlock: 101n,
        toBlock: 105n,
        previousOperations: [scheduledOperation],
      }
    );
    unmount();
    vi.useRealTimers();
  });
});
