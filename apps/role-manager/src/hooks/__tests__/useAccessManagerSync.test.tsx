import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessManagerService } from '../../types/access-manager';
import { useAccessManagerSync } from '../useAccessManagerSync';

const MANAGER = '0x1000000000000000000000000000000000000001';
const seed = {
  roleId: '7',
  label: 'Operator',
  adminRoleId: '0',
  guardianRoleId: '0',
  grantDelay: 0,
  members: [],
};
const hydrated = { ...seed, adminRoleId: '2', grantDelay: 60 };
const graph = vi.hoisted(() => ({
  isSubgraphAvailable: vi.fn(),
  fetchRolesFromSubgraph: vi.fn(),
  fetchTargetsFromSubgraph: vi.fn(),
  fetchEventsFromSubgraph: vi.fn(),
  fetchOperationsFromSubgraph: vi.fn(),
}));
const storage = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), clear: vi.fn() }));
vi.mock('../../core/ecosystems/evm/accessManagerGraphql', () => graph);
vi.mock('../../core/storage/AccessManagerSyncStorage', () => ({
  accessManagerSyncStorage: storage,
}));

function createService() {
  return {
    getDeploymentBlock: vi.fn().mockResolvedValue(42n),
    hydrateRolesFromSubgraph: vi.fn().mockResolvedValue([hydrated]),
    hydrateTargetsFromSubgraph: vi.fn().mockResolvedValue([]),
    hydrateOperationsFromSubgraph: vi.fn().mockResolvedValue([]),
    getRoles: vi.fn().mockResolvedValue([seed]),
    getTargets: vi.fn().mockResolvedValue([]),
    getScheduledOperations: vi.fn().mockResolvedValue([]),
    getEventHistory: vi.fn().mockResolvedValue([]),
  };
}

describe('useAccessManagerSync authority integration', () => {
  beforeEach(() => {
    storage.get.mockResolvedValue(null);
    storage.save.mockResolvedValue(undefined);
    graph.isSubgraphAvailable.mockImplementation(
      async (_chain, _address, _network, deployment) => deployment !== undefined
    );
    graph.fetchRolesFromSubgraph.mockResolvedValue([seed]);
    graph.fetchTargetsFromSubgraph.mockResolvedValue([]);
    graph.fetchEventsFromSubgraph.mockResolvedValue([]);
    graph.fetchOperationsFromSubgraph.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('hydrates graph discoveries, checks deployment coverage and verifies indexed operations', async () => {
    const service = createService();
    const operation = {
      operationId: '0x01',
      nonce: 1,
      schedule: 100,
      caller: MANAGER,
      target: MANAGER,
      data: '0x',
      isReady: true,
      isExpired: false,
    };
    graph.fetchOperationsFromSubgraph.mockResolvedValue([operation]);
    service.hydrateOperationsFromSubgraph.mockResolvedValue([operation]);
    const { result, unmount } = renderHook(() =>
      useAccessManagerSync(service as unknown as AccessManagerService, MANAGER, 1, 'testnet')
    );
    await waitFor(() => expect(result.current.roles).toEqual([hydrated]));
    expect(result.current.operations).toEqual([operation]);
    expect(graph.isSubgraphAvailable).toHaveBeenCalledWith(1, MANAGER, 'testnet', 42);
    expect(service.hydrateOperationsFromSubgraph).toHaveBeenCalledWith(MANAGER, [operation]);
    expect(service.getScheduledOperations).not.toHaveBeenCalled();
    expect(service.getRoles).not.toHaveBeenCalled();
    expect(storage.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastSyncedBlock: 0, deploymentBlock: 42 })
    );
    unmount();
  });

  it.each([
    'fetchRolesFromSubgraph',
    'fetchTargetsFromSubgraph',
    'fetchOperationsFromSubgraph',
    'fetchEventsFromSubgraph',
  ] as const)('falls back to RPC when %s fails', async (method) => {
    graph[method].mockResolvedValue(null);
    const service = createService();
    const { result, unmount } = renderHook(() =>
      useAccessManagerSync(service as unknown as AccessManagerService, MANAGER, 1, 'testnet')
    );
    await waitFor(() => expect(result.current.roles).toEqual([seed]));
    expect(service.getRoles).toHaveBeenCalledWith(
      MANAGER,
      expect.objectContaining({ fromBlock: 42n })
    );
    expect(service.hydrateRolesFromSubgraph).not.toHaveBeenCalled();
    unmount();
  });

  it('falls back when live hydration fails instead of caching default metadata', async () => {
    const service = createService();
    service.hydrateRolesFromSubgraph.mockRejectedValue(new Error('RPC unavailable'));
    const { result, unmount } = renderHook(() =>
      useAccessManagerSync(service as unknown as AccessManagerService, MANAGER, 1, 'testnet')
    );
    await waitFor(() => expect(result.current.roles).toEqual([seed]));
    expect(service.getRoles).toHaveBeenCalled();
    expect(storage.save).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('replays from deployment if a subsequent poll loses graph coverage', async () => {
    vi.useFakeTimers();
    let cached: unknown = null;
    storage.get.mockImplementation(async () => cached);
    storage.save.mockImplementation(async (record) => {
      cached = record;
    });
    const service = createService();
    const { unmount } = renderHook(() =>
      useAccessManagerSync(service as unknown as AccessManagerService, MANAGER, 1, 'testnet')
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    graph.isSubgraphAvailable.mockResolvedValue(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(service.getRoles).toHaveBeenCalledWith(
      MANAGER,
      expect.objectContaining({ fromBlock: 42n })
    );
    unmount();
  });
  it('loads unverified managers without explorer lookup when graph coverage starts at genesis', async () => {
    graph.isSubgraphAvailable.mockResolvedValue(true);
    const service = createService();
    service.getDeploymentBlock.mockRejectedValue(new Error('unverified'));
    const { result, unmount } = renderHook(() =>
      useAccessManagerSync(service as unknown as AccessManagerService, MANAGER, 1, 'testnet')
    );
    await waitFor(() => expect(result.current.roles).toEqual([hydrated]));
    expect(service.getDeploymentBlock).not.toHaveBeenCalled();
    expect(service.getScheduledOperations).not.toHaveBeenCalled();
    unmount();
  });
});
