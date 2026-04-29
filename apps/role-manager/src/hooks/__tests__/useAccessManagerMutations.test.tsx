import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';

import type { ExecutionConfig, OperationResult } from '@openzeppelin/ui-types';

import { useAMExecute } from '../useAccessManagerMutations';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../useAccessManagerService', () => ({
  useAccessManagerService: () => ({
    service: {
      execute: mocks.execute,
    },
    isReady: true,
  }),
}));

const EXECUTION_CONFIG = { method: 'eoa', allowAny: true } as ExecutionConfig;
const SAFE_PENDING_RESULT: OperationResult = { id: 'safe-pending' };

const createWrapper = (queryClient: QueryClient) => {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

describe('useAccessManagerMutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not invalidate or call onSuccess for Safe pending operation handoffs', async () => {
    const onSuccess = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');

    mocks.execute.mockResolvedValue(SAFE_PENDING_RESULT);

    const { result } = renderHook(() => useAMExecute({} as never, '0xManager', { onSuccess }), {
      wrapper: createWrapper(queryClient),
    });

    let operationResult: OperationResult | undefined;
    await act(async () => {
      operationResult = await result.current.mutateAsync({
        target: '0xTarget',
        data: '0x1234',
        executionConfig: EXECUTION_CONFIG,
      });
    });

    expect(operationResult).toEqual(SAFE_PENDING_RESULT);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
