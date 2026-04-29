import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionConfig } from '@openzeppelin/ui-types';

import { ACCESS_MANAGER_ABI } from '../accessManagerAbi';
import { executeTransactionWithSafeApp } from '../safeAppExecution';

const mockGetInfo = vi.fn();
const mockSend = vi.fn();

vi.mock('@safe-global/safe-apps-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    safe: { getInfo: mockGetInfo },
    txs: { send: mockSend },
  })),
}));

const EXECUTION_CONFIG = { method: 'eoa', allowAny: true } as ExecutionConfig;
const MANAGER_ADDRESS = '0x1000000000000000000000000000000000000001';
const ACCOUNT_ADDRESS = '0x2000000000000000000000000000000000000002';

describe('executeTransactionWithSafeApp', () => {
  const originalParent = window.parent;

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
  });

  it('returns null outside iframe contexts', async () => {
    const result = await executeTransactionWithSafeApp(
      {
        address: MANAGER_ADDRESS,
        abi: ACCESS_MANAGER_ABI,
        functionName: 'grantRole',
        args: [1n, ACCOUNT_ADDRESS, 0],
        value: 0n,
      },
      EXECUTION_CONFIG,
      vi.fn(),
      4153
    );

    expect(result).toBeNull();
    expect(mockGetInfo).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns the Safe pending sentinel without waiting for the Safe modal', async () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {},
    });

    mockGetInfo.mockResolvedValue({ chainId: 4153, isReadOnly: false });
    mockSend.mockReturnValue(new Promise(() => {}));

    const onStatus = vi.fn();
    const result = await executeTransactionWithSafeApp(
      {
        address: MANAGER_ADDRESS,
        abi: ACCESS_MANAGER_ABI,
        functionName: 'grantRole',
        args: [1n, ACCOUNT_ADDRESS, 0],
        value: 0n,
      },
      EXECUTION_CONFIG,
      onStatus,
      4153
    );

    expect(result).toEqual({ id: 'safe-pending' });
    expect(onStatus).toHaveBeenCalledWith('pendingSignature', {});
    expect(mockSend).toHaveBeenCalledWith({
      txs: [
        expect.objectContaining({
          to: MANAGER_ADDRESS,
          value: '0',
          data: expect.stringMatching(/^0x/),
        }),
      ],
    });
  });

  it('throws when the Safe chain does not match the selected network', async () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {},
    });

    mockGetInfo.mockResolvedValue({ chainId: 1, isReadOnly: false });

    await expect(
      executeTransactionWithSafeApp(
        {
          address: MANAGER_ADDRESS,
          abi: ACCESS_MANAGER_ABI,
          functionName: 'grantRole',
          args: [1n, ACCOUNT_ADDRESS, 0],
          value: 0n,
        },
        EXECUTION_CONFIG,
        vi.fn(),
        4153
      )
    ).rejects.toThrow('Safe is connected to chain 1, but the selected network uses chain 4153.');

    expect(mockSend).not.toHaveBeenCalled();
  });
});
