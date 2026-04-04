import React, { useEffect, useMemo, useRef } from 'react';

import { useDerivedAccountStatus, useDerivedConnectStatus } from '@openzeppelin/ui-react';
import { logger } from '@openzeppelin/ui-utils';

import { useAllNetworks } from '../hooks/useAllNetworks';
import { useContractContext } from './ContractContext';

export interface SafeAppSyncProviderProps {
  children: React.ReactNode;
}

const SAFE_CONNECTOR_ID = 'safe';

/**
 * Syncs the app with Safe iframe context.
 *
 * When loaded inside Safe, the app should proactively connect to the Safe
 * wallet and align its selected network to the Safe's chain.
 */
export function SafeAppSyncProvider({ children }: SafeAppSyncProviderProps): React.ReactElement {
  const { selectedNetwork, setSelectedNetwork } = useContractContext();
  const { networks } = useAllNetworks();
  const { connect, connectors, isConnecting } = useDerivedConnectStatus();
  const { isConnected, chainId } = useDerivedAccountStatus();

  const attemptedNetworkIdRef = useRef<string | null>(null);
  const isIframe = typeof window !== 'undefined' && window.parent !== window;

  const safeConnector = useMemo(
    () => connectors.find((connector) => connector.id === SAFE_CONNECTOR_ID),
    [connectors]
  );

  useEffect(() => {
    if (!isIframe || !selectedNetwork || !connect || !safeConnector) return;
    if (isConnected || isConnecting) return;
    if (attemptedNetworkIdRef.current === selectedNetwork.id) return;

    attemptedNetworkIdRef.current = selectedNetwork.id;
    logger.info(
      'SafeAppSyncProvider',
      `Attempting Safe auto-connect for network ${selectedNetwork.id}.`
    );

    const connectResult = connect({ connector: safeConnector });
    void Promise.resolve(connectResult).catch((error) => {
      logger.warn('SafeAppSyncProvider', 'Safe auto-connect failed.', error);
    });
  }, [connect, isConnected, isConnecting, isIframe, safeConnector, selectedNetwork]);

  useEffect(() => {
    if (!isIframe || !isConnected || !chainId) return;

    const matchingNetwork = networks.find((network) => {
      const maybeChainId = (network as { chainId?: unknown }).chainId;
      return (
        network.ecosystem === 'evm' && typeof maybeChainId === 'number' && maybeChainId === chainId
      );
    });

    if (!matchingNetwork || selectedNetwork?.id === matchingNetwork.id) return;

    logger.info(
      'SafeAppSyncProvider',
      `Syncing selected network to Safe chain ${chainId} (${matchingNetwork.id}).`
    );
    setSelectedNetwork(matchingNetwork);
  }, [chainId, isConnected, isIframe, networks, selectedNetwork?.id, setSelectedNetwork]);

  return <>{children}</>;
}
