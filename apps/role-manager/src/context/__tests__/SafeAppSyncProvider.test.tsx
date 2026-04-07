import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkConfig } from '@openzeppelin/ui-types';

import { SafeAppSyncProvider } from '../SafeAppSyncProvider';

const mockConnect = vi.fn();
const mockSetSelectedNetwork = vi.fn();

const mockState = {
  selectedNetwork: {
    id: 'ethereum-mainnet',
    ecosystem: 'evm',
    network: 'ethereum',
    name: 'Ethereum',
    type: 'mainnet',
    isTestnet: false,
    chainId: 1,
  } as NetworkConfig,
  networks: [
    {
      id: 'ethereum-mainnet',
      ecosystem: 'evm',
      network: 'ethereum',
      name: 'Ethereum',
      type: 'mainnet',
      isTestnet: false,
      chainId: 1,
    },
    {
      id: 'rise-mainnet',
      ecosystem: 'evm',
      network: 'rise',
      name: 'RISE',
      type: 'mainnet',
      isTestnet: false,
      chainId: 4153,
    },
  ] as NetworkConfig[],
  connectStatus: {
    connect: mockConnect,
    connectors: [{ id: 'safe', name: 'Safe' }],
    isConnecting: false,
    error: null,
    pendingConnector: undefined,
  },
  accountStatus: {
    isConnected: false,
    isConnecting: false,
    isDisconnected: true,
    isReconnecting: false,
    status: 'disconnected',
    address: undefined,
    chainId: undefined,
  },
};

vi.mock('@openzeppelin/ui-react', () => ({
  useDerivedConnectStatus: () => mockState.connectStatus,
  useDerivedAccountStatus: () => mockState.accountStatus,
}));

vi.mock('../../hooks/useAllNetworks', () => ({
  useAllNetworks: () => ({
    networks: mockState.networks,
    isLoading: false,
  }),
}));

vi.mock('../ContractContext', () => ({
  useContractContext: () => ({
    selectedNetwork: mockState.selectedNetwork,
    setSelectedNetwork: mockSetSelectedNetwork,
  }),
}));

describe('SafeAppSyncProvider', () => {
  const originalParent = window.parent;

  beforeEach(() => {
    vi.clearAllMocks();

    mockState.selectedNetwork = mockState.networks[0]!;
    mockState.connectStatus = {
      connect: mockConnect,
      connectors: [{ id: 'safe', name: 'Safe' }],
      isConnecting: false,
      error: null,
      pendingConnector: undefined,
    };
    mockState.accountStatus = {
      isConnected: false,
      isConnecting: false,
      isDisconnected: true,
      isReconnecting: false,
      status: 'disconnected',
      address: undefined,
      chainId: undefined,
    };
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });
  });

  it('auto-connects the Safe connector when loaded inside an iframe', async () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {},
    });

    render(
      <SafeAppSyncProvider>
        <div>content</div>
      </SafeAppSyncProvider>
    );

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledWith({
        connector: mockState.connectStatus.connectors[0],
      });
    });

    expect(screen.getByText('content')).toBeDefined();
  });

  it('syncs the selected network to the Safe chain when connected', async () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {},
    });

    (mockState as unknown as { accountStatus: Record<string, unknown> }).accountStatus = {
      isConnected: true,
      isConnecting: false,
      isDisconnected: false,
      isReconnecting: false,
      status: 'connected',
      address: '0x1234',
      chainId: 4153,
    };

    render(
      <SafeAppSyncProvider>
        <div>content</div>
      </SafeAppSyncProvider>
    );

    await waitFor(() => {
      expect(mockSetSelectedNetwork).toHaveBeenCalledWith(mockState.networks[1]);
    });
  });

  it('handles synchronous Safe connector errors without crashing', async () => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: {},
    });

    mockConnect.mockImplementationOnce(() => {
      throw new Error('sync connect failure');
    });

    render(
      <SafeAppSyncProvider>
        <div>content</div>
      </SafeAppSyncProvider>
    );

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledWith({
        connector: mockState.connectStatus.connectors[0],
      });
    });

    expect(screen.getByText('content')).toBeDefined();
  });
});
