import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { appConfigService } from '@openzeppelin/ui-utils';

import './index.css';

import App from './App';

/**
 * Initialize configuration and render the application.
 *
 * AppConfigService must be initialized before rendering to ensure
 * adapters can access configuration (indexer endpoints, RPC overrides, etc.)
 *
 * Configuration sources (priority order, later overrides earlier):
 * 1. app.config.json - Base config (committed, no secrets)
 * 2. Vite env vars - VITE_APP_CFG_* environment variables (.env.local, gitignored)
 *
 * Example env vars:
 * - VITE_APP_CFG_INDEXER_ENDPOINT_STELLAR_TESTNET=https://...?apikey=xxx
 * - VITE_APP_CFG_RPC_ENDPOINT_STELLAR_TESTNET=https://...
 */
/**
 * On deployed environments (non-localhost), auto-populate rpcEndpoints
 * to use same-origin Vercel rewrites (/api/rpc/<chainId>).
 * This avoids ad-blocker and CORS issues with third-party RPC domains.
 * Locally, direct RPC URLs work fine (no ad-blocker restrictions).
 */
function injectRpcProxy(): void {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocal) return;

  const chains: Record<string, number> = {
    'ethereum-mainnet': 1,
    'arbitrum-mainnet': 42161,
    'polygon-mainnet': 137,
    'optimism-mainnet': 10,
    'base-mainnet': 8453,
  };

  const config = (appConfigService as unknown as { config: { rpcEndpoints: Record<string, string> } }).config;
  for (const [networkId, chainId] of Object.entries(chains)) {
    const existing = appConfigService.getRpcEndpointOverride(networkId);
    if (!existing) {
      config.rpcEndpoints[networkId] = `/api/rpc/${chainId}`;
    }
  }
}

async function init(): Promise<void> {
  await appConfigService.initialize([
    { type: 'json', path: '/app.config.json' },
    { type: 'viteEnv', env: import.meta.env },
  ]);

  injectRpcProxy();

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element not found');

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

init();
