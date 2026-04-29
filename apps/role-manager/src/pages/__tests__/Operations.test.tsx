import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Operations } from '../Operations';

const mocks = vi.hoisted(() => ({
  executeMutateAsync: vi.fn(),
  refetch: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock('@openzeppelin/ui-react', () => ({
  useDerivedAccountStatus: () => ({
    address: '0xConnectedWallet',
  }),
}));

vi.mock('../../context/AccessManagerSyncContext', () => ({
  useSharedAccessManagerSync: () => ({
    operations: [],
    expiration: null,
    minSetback: null,
    isAccessManager: true,
    isLoading: false,
    isSyncing: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock('../../hooks', () => ({
  useContractDisplayName: () => 'AccessManager',
}));

vi.mock('../../hooks/useSelectedContract', () => ({
  useSelectedContract: () => ({
    selectedContract: {
      address: '0xManager',
    },
    runtime: {},
  }),
}));

vi.mock('../../hooks/useAccessManagerMutations', () => ({
  useAMExecute: () => ({
    mutateAsync: mocks.executeMutateAsync,
    isPending: false,
  }),
  useAMCancel: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAMSchedule: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('../../hooks/useKnownContracts', () => ({
  useKnownContracts: () => ({
    contracts: [],
    loadFunctionsFor: vi.fn(),
  }),
}));

describe('Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the execute form open and unchanged after Safe batch handoff', async () => {
    const target = '0x1111111111111111111111111111111111111111';
    const calldata = '0x12345678';
    mocks.executeMutateAsync.mockResolvedValue({ id: 'safe-pending' });

    render(<Operations />);

    fireEvent.click(screen.getByRole('button', { name: /^Execute$/ }));

    const inputs = screen.getAllByPlaceholderText('0x...');
    const targetInput = inputs[0] as HTMLInputElement;
    const calldataInput = inputs[1] as HTMLInputElement;

    fireEvent.change(targetInput, { target: { value: target } });
    fireEvent.change(calldataInput, { target: { value: calldata } });
    fireEvent.click(screen.getByRole('button', { name: /^Execute$/ }));

    await waitFor(() => {
      expect(mocks.executeMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(mocks.toastInfo).toHaveBeenCalledWith('Transaction sent to Safe');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(screen.getByText('Execute Immediately')).toBeInTheDocument();
    expect(targetInput.value).toBe(target);
    expect(calldataInput.value).toBe(calldata);
  });
});
