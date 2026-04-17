import 'fake-indexeddb/auto';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetKnownContractsAbiCacheForTests,
  __seedKnownContractsAbiCacheForTests,
  useKnownContracts,
} from '../useKnownContracts';

const mockUseSelectedContract = vi.fn();
const mockUseSharedAccessManagerSync = vi.fn();

vi.mock('../useSelectedContract', () => ({
  useSelectedContract: () => mockUseSelectedContract(),
}));

vi.mock('../../context/AccessManagerSyncContext', () => ({
  useSharedAccessManagerSync: () => mockUseSharedAccessManagerSync(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useKnownContracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetKnownContractsAbiCacheForTests();

    mockUseSelectedContract.mockReturnValue({
      runtime: {
        contractLoading: {
          loadContract: vi.fn(),
        },
        schema: {
          isViewFunction: vi.fn(),
        },
      },
    });

    mockUseSharedAccessManagerSync.mockReturnValue({
      targets: [
        {
          target: '0x1234567890abcdef1234567890abcdef12345678',
          isClosed: false,
          adminDelay: 0,
          functionRoles: [],
        },
      ],
    });
  });

  afterEach(() => {
    __resetKnownContractsAbiCacheForTests();
  });

  it('hydrates hook state from abi cache when loadFunctionsFor hits a cached address', async () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const { result } = renderHook(() => useKnownContracts(), { wrapper: createWrapper() });

    expect(result.current.contracts[0]?.functions).toHaveLength(0);

    __seedKnownContractsAbiCacheForTests(address, [
      {
        selector: '0xa9059cbb',
        name: 'transfer',
        signature: 'transfer(address,uint256)',
        isView: false,
        params: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
      },
    ]);

    act(() => {
      result.current.loadFunctionsFor(address);
    });

    expect(result.current.contracts[0]?.functions).toHaveLength(1);
    expect(result.current.contracts[0]?.functions[0]?.name).toBe('transfer');
  });

  it('preserves tuple component metadata from loaded contract functions', async () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const loadContract = vi.fn().mockResolvedValue({
      functions: [
        {
          id: 'setConfig(tuple)',
          name: 'setConfig',
          inputs: [
            {
              name: 'config',
              type: 'tuple',
              components: [
                { name: 'capacity', type: 'uint128' },
                { name: 'refillRate', type: 'uint128' },
              ],
            },
          ],
        },
      ],
    });

    mockUseSelectedContract.mockReturnValue({
      runtime: {
        contractLoading: { loadContract },
        schema: {
          isViewFunction: vi.fn().mockReturnValue(false),
        },
      },
    });

    const { result } = renderHook(() => useKnownContracts(), { wrapper: createWrapper() });

    act(() => {
      result.current.loadFunctionsFor(address);
    });

    await waitFor(() => {
      expect(result.current.contracts[0]?.functions).toHaveLength(1);
    });

    expect(result.current.contracts[0]?.functions[0]?.params[0]?.components).toEqual([
      { name: 'capacity', type: 'uint128', components: undefined },
      { name: 'refillRate', type: 'uint128', components: undefined },
    ]);
  });
});
