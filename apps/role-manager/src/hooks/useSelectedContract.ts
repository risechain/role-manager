/**
 * useSelectedContract hook
 * Feature: 007-dashboard-real-data
 *
 * Convenience wrapper for ContractContext that provides access to
 * the selected contract, network, and runtime.
 *
 * This hook is the primary way for components to access contract
 * selection state throughout the application.
 */

import { useMemo, useRef } from 'react';

import type { ExecutionConfig, TransactionStatusUpdate } from '@openzeppelin/ui-types';

import { useContractContext } from '../context/ContractContext';
import { wrapSignAndBroadcastForSafe } from '../core/ecosystems/evm/safeSignAndBroadcast';
import type { RoleManagerRuntime } from '../core/runtimeAdapter';
import type { UseSelectedContractReturn } from '../types/dashboard';

/**
 * Hook that provides access to the currently selected contract and related state.
 *
 * This is a convenience wrapper around useContractContext that returns all
 * the values needed by components that need to interact with the selected contract.
 *
 * @returns Selected contract, network, runtime, and related state
 * @throws Error if used outside of ContractProvider
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const { selectedContract, runtime, isRuntimeLoading } = useSelectedContract();
 *
 *   if (!selectedContract) {
 *     return <DashboardEmptyState />;
 *   }
 *
 *   if (isRuntimeLoading) {
 *     return <LoadingSpinner />;
 *   }
 *
 *   return <DashboardContent contract={selectedContract} runtime={runtime} />;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Updating selection
 * function ContractList() {
 *   const { contracts, selectedContract, setSelectedContract } = useSelectedContract();
 *
 *   return (
 *     <ul>
 *       {contracts.map((contract) => (
 *         <li
 *           key={contract.id}
 *           onClick={() => setSelectedContract(contract)}
 *           className={contract.id === selectedContract?.id ? 'selected' : ''}
 *         >
 *           {contract.address}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useSelectedContract(): UseSelectedContractReturn {
  const context = useContractContext();
  const patchedRef = useRef<WeakSet<object>>(new WeakSet());

  // Patch runtime.execution.signAndBroadcast for Safe iframe support.
  // All pages consume runtime through this hook, so patching here ensures
  // every write operation (AC mutations, Contract page, AM mutations)
  // routes through the Safe SDK when in a Safe iframe.
  const runtime = useMemo(() => {
    const rt = context.runtime as RoleManagerRuntime | null;
    if (!rt?.execution?.signAndBroadcast) return rt;
    if (patchedRef.current.has(rt.execution)) return rt;

    const original = rt.execution.signAndBroadcast.bind(rt.execution) as (
      transactionData: unknown,
      executionConfig: ExecutionConfig,
      onStatusChange: (status: string, details: TransactionStatusUpdate) => void,
      runtimeApiKey?: string
    ) => Promise<{ txHash: string }>;

    const wrapped = wrapSignAndBroadcastForSafe(original);
    rt.execution.signAndBroadcast = wrapped as typeof rt.execution.signAndBroadcast;

    // Also patch accessControl's internal executeTransaction callback.
    // The AC service captures its own execution reference at construction time,
    // so patching rt.execution alone doesn't cover AC mutations (grantRole, etc.).
    const ac = rt.accessControl as
      | { executeTransaction?: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    if (ac?.executeTransaction) {
      const originalAcExec = ac.executeTransaction.bind(ac);
      ac.executeTransaction = (async (...args: unknown[]) => {
        const [txData, execConfig, onStatus, apiKey] = args as [
          unknown,
          ExecutionConfig,
          (status: string, details: TransactionStatusUpdate) => void,
          string | undefined,
        ];
        const result = await wrapped(txData, execConfig, onStatus, apiKey);
        return { id: result.txHash };
      }) as typeof ac.executeTransaction;
      // Keep original as fallback if Safe wrapper returns non-Safe result
      void originalAcExec;
    }

    patchedRef.current.add(rt.execution);

    return rt;
  }, [context.runtime]);

  return {
    selectedContract: context.selectedContract,
    setSelectedContract: context.setSelectedContract,
    selectedNetwork: context.selectedNetwork,
    setSelectedNetwork: context.setSelectedNetwork,
    runtime,
    isRuntimeLoading: context.isRuntimeLoading,
    contracts: context.contracts,
    isContractsLoading: context.isContractsLoading,
    isContractRegistered: context.isContractRegistered,
    selectContractById: context.selectContractById,
  };
}
