/**
 * useKnownContracts hook
 * Feature: 018-access-manager
 *
 * Provides a list of known contract addresses with resolved names and
 * ABI-derived function selectors for dropdown menus in Targets and
 * Operations pages.
 *
 * Data sources:
 * - AM sync targets (already managed by the AccessManager)
 * - Contract name cache (Sourcify + proxy resolution)
 * - ABI loading via runtime.contractLoading.loadContract() for function selectors
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import type { ContractFunction } from '@openzeppelin/ui-types';
import { logger } from '@openzeppelin/ui-utils';

import { useSharedAccessManagerSync } from '../context/AccessManagerSyncContext';
import type { RoleManagerRuntime } from '../core/runtimeAdapter';
import { useSelectedContract } from './useSelectedContract';

// =============================================================================
// Types
// =============================================================================

export interface KnownFunction {
  /** 4-byte selector (e.g., "0x12345678") */
  selector: string;
  /** Human-readable name (e.g., "transfer") */
  name: string;
  /** Full signature (e.g., "transfer(address,uint256)") */
  signature: string;
  /** Whether it's a view/pure function */
  isView: boolean;
}

export interface KnownContract {
  /** Contract address */
  address: string;
  /** Resolved display name (from Sourcify/proxy/alias) */
  name: string;
  /** Whether it's a proxy contract */
  isProxy: boolean;
  /** ABI-derived functions (loaded lazily) */
  functions: KnownFunction[];
  /** Whether functions are still loading */
  isLoadingFunctions: boolean;
}

// =============================================================================
// Module-level ABI cache (persist across renders)
// =============================================================================

const abiCache = new Map<string, KnownFunction[]>();

export function __resetKnownContractsAbiCacheForTests(): void {
  abiCache.clear();
}

export function __seedKnownContractsAbiCacheForTests(
  address: string,
  functions: KnownFunction[]
): void {
  abiCache.set(address.toLowerCase(), functions);
}

async function loadContractFunctions(
  runtime: RoleManagerRuntime,
  address: string
): Promise<KnownFunction[]> {
  const key = address.toLowerCase();
  if (abiCache.has(key)) return abiCache.get(key)!;

  try {
    const schema = await runtime.contractLoading.loadContract(address);
    if (!schema?.functions?.length) return [];

    const fns: KnownFunction[] = schema.functions.map((fn: ContractFunction) => {
      // Build signature from inputs
      const paramTypes = fn.inputs?.map((p) => p.type).join(',') ?? '';
      const signature = `${fn.name}(${paramTypes})`;

      // Compute selector from signature
      let selector = '';
      try {
        // Use a simple keccak256 of the signature to get the selector
        // We'll use the function ID from the schema if available
        selector = fn.id?.startsWith('0x') ? fn.id.slice(0, 10) : '';
      } catch {
        selector = '';
      }

      return {
        selector,
        name: fn.name,
        signature,
        isView: runtime.schema.isViewFunction(fn),
      };
    });

    abiCache.set(key, fns);
    return fns;
  } catch (err) {
    logger.warn('useKnownContracts', `Failed to load ABI for ${address}`, err);
    return [];
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Returns known contracts (from AM targets) with their resolved names
 * and ABI-derived function lists for dropdown selection.
 *
 * Functions are loaded lazily when `loadFunctionsFor(address)` is called.
 */
export function useKnownContracts(): {
  contracts: KnownContract[];
  loadFunctionsFor: (address: string) => void;
} {
  const { runtime } = useSelectedContract();
  const { targets } = useSharedAccessManagerSync();

  const [functionsByAddress, setFunctionsByAddress] = useState<Map<string, KnownFunction[]>>(
    new Map()
  );
  const [loadingAddresses, setLoadingAddresses] = useState<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());

  // Build contracts list from AM targets + any dynamically-loaded custom addresses
  const contracts = useMemo((): KnownContract[] => {
    const seen = new Set<string>();
    const result: KnownContract[] = [];

    for (const target of targets) {
      const addr = target.target.toLowerCase();
      if (seen.has(addr)) continue;
      seen.add(addr);

      const cached = abiCache.get(addr);
      const loaded = functionsByAddress.get(addr);
      const fns = loaded ?? cached ?? [];

      result.push({
        address: target.target,
        name: target.target,
        isProxy: false,
        functions: fns,
        isLoadingFunctions: loadingAddresses.has(addr),
      });
    }

    // Include custom addresses that were loaded via loadFunctionsFor
    // but aren't AM targets (e.g., pasted addresses in Operations/Targets forms)
    for (const [addr, fns] of functionsByAddress) {
      if (seen.has(addr)) continue;
      seen.add(addr);
      result.push({
        address: addr,
        name: addr,
        isProxy: false,
        functions: fns,
        isLoadingFunctions: false,
      });
    }

    return result;
  }, [targets, functionsByAddress, loadingAddresses]);

  // Lazy-load functions for a specific address
  const loadFunctionsFor = useCallback(
    (address: string) => {
      const addr = address.toLowerCase();
      const cached = abiCache.get(addr);
      if (cached) {
        setFunctionsByAddress((prev) => {
          if (prev.get(addr) === cached) return prev;
          const next = new Map(prev);
          next.set(addr, cached);
          return next;
        });
        return;
      }

      if (loadingRef.current.has(addr) || !runtime) return;

      loadingRef.current.add(addr);
      setLoadingAddresses((prev) => new Set(prev).add(addr));

      loadContractFunctions(runtime, address).then((fns) => {
        loadingRef.current.delete(addr);
        setLoadingAddresses((prev) => {
          const next = new Set(prev);
          next.delete(addr);
          return next;
        });
        if (fns.length > 0) {
          setFunctionsByAddress((prev) => {
            const next = new Map(prev);
            next.set(addr, fns);
            return next;
          });
        }
      });
    },
    [runtime]
  );

  // ABI loading is lazy — triggered by loadFunctionsFor() when the user
  // opens the Add Mapping / Schedule form and selects a target.

  return { contracts, loadFunctionsFor };
}

/**
 * Encode a function call from name + params for use as calldata.
 * Returns the ABI-encoded bytes including the 4-byte selector.
 */
export async function encodeFunctionCall(
  runtime: RoleManagerRuntime,
  targetAddress: string,
  functionId: string,
  args: Record<string, unknown>
): Promise<string> {
  const schema = await runtime.contractLoading.loadContract(targetAddress);
  const fn = schema.functions.find((f: ContractFunction) => f.id === functionId);
  if (!fn) throw new Error(`Function ${functionId} not found in contract ABI`);

  const fields = (fn.inputs ?? []).map((p) => ({
    id: p.name,
    name: p.name,
    label: p.name,
    type: runtime.typeMapping.mapParameterTypeToFieldType(
      p.type
    ) as import('@openzeppelin/ui-types').FieldType,
    validation: {},
  }));

  const txData = runtime.execution.formatTransactionData(schema, fn.id, args, fields);
  // txData has a `data` field with the encoded calldata
  return (txData as { data?: string }).data ?? '';
}
