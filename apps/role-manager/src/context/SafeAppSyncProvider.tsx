import React, { useEffect, useMemo, useRef, useState } from 'react';

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
  const { isConnected, chainId: wagmiChainId } = useDerivedAccountStatus();

  const attemptedNetworkIdRef = useRef<string | null>(null);
  const isIframe = typeof window !== 'undefined' && window.parent !== window;

  // Direct Safe SDK chain detection — fallback when wagmi reports wrong chain
  const [safeChainId, setSafeChainId] = useState<number | null>(null);

  useEffect(() => {
    if (!isIframe) return;

    (async () => {
      try {
        const SafeAppsSDK = (await import('@safe-global/safe-apps-sdk')).default;
        const sdk = new SafeAppsSDK();
        const info = await sdk.safe.getChainInfo();
        const id = parseInt(info.chainId, 10);
        if (!isNaN(id) && id > 0) {
          logger.info('SafeAppSyncProvider', `Safe SDK reports chain ${id}`);
          setSafeChainId(id);
        }
      } catch (err) {
        logger.warn('SafeAppSyncProvider', 'Failed to get Safe chain info', err);
      }
    })();
  }, [isIframe]);

  // Use Safe SDK chain ID if wagmi doesn't match or isn't available
  const chainId = safeChainId ?? wagmiChainId;

  const safeConnector = useMemo(
    () => connectors.find((connector) => connector.id === SAFE_CONNECTOR_ID),
    [connectors]
  );

  // Auto-connect to Safe when in iframe
  useEffect(() => {
    if (!isIframe || !connect || !safeConnector) return;
    if (isConnected || isConnecting) return;

    // Wait for either a selected network or Safe chain detection
    if (!selectedNetwork && !safeChainId) return;
    const networkKey = selectedNetwork?.id ?? `chain-${safeChainId}`;
    if (attemptedNetworkIdRef.current === networkKey) return;

    attemptedNetworkIdRef.current = networkKey;
    logger.info('SafeAppSyncProvider', `Attempting Safe auto-connect (network: ${networkKey}).`);

    try {
      const connectResult = connect({ connector: safeConnector });
      void Promise.resolve(connectResult).catch((error) => {
        logger.warn('SafeAppSyncProvider', 'Safe auto-connect failed.', error);
      });
    } catch (error) {
      logger.warn('SafeAppSyncProvider', 'Safe auto-connect failed.', error);
    }
  }, [connect, isConnected, isConnecting, isIframe, safeConnector, selectedNetwork, safeChainId]);

  // Sync selected network to Safe's chain
  useEffect(() => {
    if (!isIframe || !chainId) return;
    // Allow sync even if not yet connected — Safe SDK gave us the chain ID directly
    if (!isConnected && !safeChainId) return;

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
  }, [chainId, isConnected, isIframe, networks, safeChainId, selectedNetwork?.id, setSelectedNetwork]);

  return <>{children}</>;
}
