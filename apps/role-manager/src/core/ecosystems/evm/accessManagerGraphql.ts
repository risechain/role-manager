/**
 * AccessManager GraphQL client for the generic RISE authority graph.
 *
 * The graph provides addressless event evidence and materialized relations. It
 * intentionally does not expose the old consumer-specific roles, targets, or
 * operations tables, so this module translates the generic records into Role
 * Manager discovery models. Live metadata is hydrated by the EVM service.
 */

import { userNetworkServiceConfigService } from '@openzeppelin/ui-utils';

import { AM_ADMIN_ROLE_ID, AM_PUBLIC_ROLE_ID } from '../../../constants';
import type {
  AccessManagerMember,
  AccessManagerRole,
  ScheduledOperation,
  TargetConfig,
} from '../../../types/access-manager';
import type { AccessManagerEventLog } from '../../storage/AccessManagerSyncStorage';

const SUBGRAPH_TIMEOUT = 10_000;
const ACCESS_MANAGER_GRANT_SPEC = 'core.access-manager-role-granted';
const ACCESS_MANAGER_REVOKE_SPEC = 'core.access-manager-role-revoked';
const ROLE_LABEL_SPEC = 'core.role-label';
const TARGET_CLOSED_SPEC = 'core.target-closed';
const TARGET_FUNCTION_ROLE_SPEC = 'core.target-function-role-updated';
const TARGET_ADMIN_DELAY_SPEC = 'core.target-admin-delay-updated';
const ACCESS_MANAGER_EVENT_SPECS = [
  ACCESS_MANAGER_GRANT_SPEC,
  ACCESS_MANAGER_REVOKE_SPEC,
  ROLE_LABEL_SPEC,
  TARGET_CLOSED_SPEC,
  TARGET_FUNCTION_ROLE_SPEC,
  TARGET_ADMIN_DELAY_SPEC,
] as const;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

/**
 * Resolve the subgraph URL for a given network.
 *
 * Priority:
 * 1. User-configured (Network Settings -> Access Control Indexer)
 * 2. VITE_SUBGRAPH_URL
 * 3. null, which enables RPC event scanning
 */
export function getSubgraphUrl(networkId?: string): string | null {
  if (networkId) {
    const userCfg = userNetworkServiceConfigService.get(networkId, 'access-control-indexer') as
      | { accessControlIndexerUrl?: string }
      | undefined;
    if (userCfg?.accessControlIndexerUrl) return userCfg.accessControlIndexerUrl;
  }

  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_SUBGRAPH_URL || null;
}

const AVAILABILITY_QUERY = `
  query AuthorityAvailability(
    $chainId: Int!
    $managerNodeId: String!
    $coverageId: String!
    $specIds: [String!]!
  ) {
    _meta { status }
    authoritySourceCoverage(id: $coverageId) {
      configuredStartBlock
    }
    authorityGraphEvents(
      where: {
        chainId: $chainId
        emitterNodeId: $managerNodeId
        specId_in: $specIds
      }
      limit: 1
    ) {
      totalCount
    }
  }
`;

const ROLES_QUERY = `
  query GetAuthorityRoles($chainId: Int!, $managerNodeId: String!, $offset: Int!) {
    authorityRelationCurrents(
      where: {
        sourceChainId: $chainId
        fromNodeId: $managerNodeId
        relationKind: "core.role-member"
      }
      limit: 1000
      offset: $offset
    ) {
      items {
        scopeKey
        toNodeId
        attributes
      }
    }
  }
`;

const EVENTS_QUERY = `
  query GetAuthorityEvents(
    $chainId: Int!
    $managerNodeId: String!
    $specIds: [String!]!
    $offset: Int!
  ) {
    authorityGraphEvents(
      where: {
        chainId: $chainId
        emitterNodeId: $managerNodeId
        specId_in: $specIds
      }
      limit: 1000
      offset: $offset
      orderBy: "id"
      orderDirection: "asc"
    ) {
      items {
        id
        blockNumber
        transactionIndex
        logIndex
        transactionHash
        timestamp
        specId
      }
    }
  }
`;

const EVENT_ARGUMENTS_QUERY = `
  query GetAuthorityEventArguments($eventIds: [String!]!) {
    authorityGraphEventArguments(
      where: { eventId_in: $eventIds }
      limit: 1000
      orderBy: "ordinal"
      orderDirection: "asc"
    ) {
      items {
        eventId
        name
        rawValue
        jsonValue
      }
    }
  }
`;

async function gqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  networkId?: string
): Promise<T | null> {
  const url = getSubgraphUrl(networkId);
  if (!url) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = (await response.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) return null;

    return json.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function managerNodeId(chainId: number, manager: string): string {
  return `eip155:${chainId}:${manager.toLowerCase()}`;
}

function sourceCoverageId(chainId: number, specId: string): string {
  return `${chainId}:coverage:${specId}`;
}

function localAddressFromNodeId(chainId: number, nodeId: string): string | null {
  const prefix = `eip155:${chainId}:`;
  if (!nodeId.toLowerCase().startsWith(prefix)) return null;

  const address = nodeId.slice(prefix.length).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function parseAttributes(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isUint64String(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

interface AuthorityGraphEventRow {
  id: string;
  blockNumber: string;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
  timestamp: string;
  specId: string;
}

interface AuthorityGraphArgumentRow {
  eventId: string;
  name: string;
  rawValue: string;
  jsonValue: unknown;
}

interface AuthorityEventsWithArguments {
  events: AuthorityGraphEventRow[];
  argumentsByEvent: Map<string, Map<string, AuthorityGraphArgumentRow>>;
}

async function fetchAuthorityEventsWithArguments(
  chainId: number,
  manager: string,
  specIds: readonly string[],
  networkId?: string
): Promise<AuthorityEventsWithArguments | null> {
  type EventsData = {
    authorityGraphEvents: { items: AuthorityGraphEventRow[] };
  };

  const events: AuthorityGraphEventRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const eventsData = await gqlQuery<EventsData>(
      EVENTS_QUERY,
      {
        chainId,
        managerNodeId: managerNodeId(chainId, manager),
        specIds,
        offset,
      },
      networkId
    );
    if (!eventsData) return null;

    const page = eventsData.authorityGraphEvents.items;
    events.push(...page);
    if (page.length < 1000) break;
  }

  if (events.length === 0) return { events, argumentsByEvent: new Map() };

  type ArgumentsData = {
    authorityGraphEventArguments: { items: AuthorityGraphArgumentRow[] };
  };
  const argumentRows: AuthorityGraphArgumentRow[] = [];
  for (let start = 0; start < events.length; start += 100) {
    const argumentsData = await gqlQuery<ArgumentsData>(
      EVENT_ARGUMENTS_QUERY,
      { eventIds: events.slice(start, start + 100).map((event) => event.id) },
      networkId
    );
    if (!argumentsData) return null;

    argumentRows.push(...argumentsData.authorityGraphEventArguments.items);
  }

  const argumentsByEvent = new Map<string, Map<string, AuthorityGraphArgumentRow>>();
  for (const argument of argumentRows) {
    let byName = argumentsByEvent.get(argument.eventId);
    if (!byName) {
      byName = new Map();
      argumentsByEvent.set(argument.eventId, byName);
    }
    byName.set(argument.name, argument);
  }

  return { events, argumentsByEvent };
}

function argumentValue(
  argumentsByEvent: AuthorityEventsWithArguments['argumentsByEvent'],
  eventId: string,
  name: string
): unknown {
  const argument = argumentsByEvent.get(eventId)?.get(name);
  if (!argument) return undefined;
  return argument.jsonValue ?? argument.rawValue;
}

function compareEventOrder(a: AuthorityGraphEventRow, b: AuthorityGraphEventRow): number {
  const blockA = BigInt(a.blockNumber);
  const blockB = BigInt(b.blockNumber);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

const availabilityCache = new Map<string, { available: boolean; checkedAt: number }>();
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;

/**
 * Check whether the authority graph contains this manager and covers its
 * lifetime. Managers deployed before the source boundary must use RPC replay.
 */
export async function isSubgraphAvailable(
  chainId: number,
  manager: string,
  networkId?: string,
  deploymentBlock?: number
): Promise<boolean> {
  const key = `${networkId ?? ''}:${chainId}:${manager.toLowerCase()}:${deploymentBlock ?? ''}`;
  const cached = availabilityCache.get(key);
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) {
    return cached.available;
  }

  type AvailabilityData = {
    _meta: { status: unknown };
    authoritySourceCoverage: { configuredStartBlock: string } | null;
    authorityGraphEvents: { totalCount: number };
  };

  const data = await gqlQuery<AvailabilityData>(
    AVAILABILITY_QUERY,
    {
      chainId,
      managerNodeId: managerNodeId(chainId, manager),
      coverageId: sourceCoverageId(chainId, ACCESS_MANAGER_GRANT_SPEC),
      specIds: ACCESS_MANAGER_EVENT_SPECS,
    },
    networkId
  );

  const coverageStart = data?.authoritySourceCoverage
    ? finiteNumber(data.authoritySourceCoverage.configuredStartBlock, Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  const coversDeployment = deploymentBlock === undefined || coverageStart <= deploymentBlock;
  const available = Boolean(
    data?._meta && data.authorityGraphEvents.totalCount > 0 && coversDeployment
  );

  availabilityCache.set(key, { available, checkedAt: Date.now() });
  return available;
}

/** Fetch current AccessManager role membership from generic graph relations. */
export async function fetchRolesFromSubgraph(
  chainId: number,
  manager: string,
  networkId?: string
): Promise<AccessManagerRole[] | null> {
  type RolesData = {
    authorityRelationCurrents: {
      items: Array<{
        scopeKey: string;
        toNodeId: string;
        attributes: unknown;
      }>;
    };
  };

  const relationItemsPromise = (async (): Promise<
    RolesData['authorityRelationCurrents']['items'] | null
  > => {
    const items: RolesData['authorityRelationCurrents']['items'] = [];
    for (let offset = 0; ; offset += 1000) {
      const pageData = await gqlQuery<RolesData>(
        ROLES_QUERY,
        {
          chainId,
          managerNodeId: managerNodeId(chainId, manager),
          offset,
        },
        networkId
      );
      if (!pageData) return null;

      const page = pageData.authorityRelationCurrents.items;
      items.push(...page);
      if (page.length < 1000) return items;
    }
  })();

  const [relationItems, roleEvents] = await Promise.all([
    relationItemsPromise,
    fetchAuthorityEventsWithArguments(
      chainId,
      manager,
      [ACCESS_MANAGER_GRANT_SPEC, ACCESS_MANAGER_REVOKE_SPEC, ROLE_LABEL_SPEC],
      networkId
    ),
  ]);
  if (!relationItems || !roleEvents) return null;

  const roles = new Map<string, AccessManagerRole>();
  roles.set(AM_ADMIN_ROLE_ID, {
    roleId: AM_ADMIN_ROLE_ID,
    label: null,
    adminRoleId: AM_ADMIN_ROLE_ID,
    guardianRoleId: AM_PUBLIC_ROLE_ID,
    grantDelay: 0,
    members: [],
  });

  for (const event of [...roleEvents.events].sort(compareEventOrder)) {
    const roleId = String(argumentValue(roleEvents.argumentsByEvent, event.id, 'roleId'));
    if (!isUint64String(roleId)) continue;

    let role = roles.get(roleId);
    if (!role) {
      role = {
        roleId,
        label: null,
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [],
      };
      roles.set(roleId, role);
    }

    if (event.specId === ROLE_LABEL_SPEC) {
      const label = argumentValue(roleEvents.argumentsByEvent, event.id, 'label');
      if (typeof label === 'string') role.label = label;
    }
  }

  for (const relation of relationItems) {
    if (!isUint64String(relation.scopeKey)) continue;

    const attributes = parseAttributes(relation.attributes);
    if (attributes.delay === undefined || attributes.since === undefined) continue;

    const address = localAddressFromNodeId(chainId, relation.toNodeId);
    if (!address) continue;

    let role = roles.get(relation.scopeKey);
    if (!role) {
      role = {
        roleId: relation.scopeKey,
        label: null,
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [],
      };
      roles.set(relation.scopeKey, role);
    }

    const member: AccessManagerMember = {
      address,
      executionDelay: finiteNumber(attributes.delay),
      since: finiteNumber(attributes.since),
    };
    role.members.push(member);
  }

  return [...roles.values()]
    .map((role) => ({
      ...role,
      members: [...role.members].sort((a, b) => a.address.localeCompare(b.address)),
    }))
    .sort((a, b) => {
      const roleA = BigInt(a.roleId);
      const roleB = BigInt(b.roleId);
      return roleA === roleB ? 0 : roleA < roleB ? -1 : 1;
    });
}

/** Reconstruct observed target configuration from generic event evidence. */
export async function fetchTargetsFromSubgraph(
  chainId: number,
  manager: string,
  networkId?: string
): Promise<TargetConfig[] | null> {
  const result = await fetchAuthorityEventsWithArguments(
    chainId,
    manager,
    [TARGET_CLOSED_SPEC, TARGET_FUNCTION_ROLE_SPEC, TARGET_ADMIN_DELAY_SPEC],
    networkId
  );
  if (!result) return null;

  type MutableTarget = Omit<TargetConfig, 'functionRoles'> & {
    functionRoles: Map<string, string>;
  };
  const targets = new Map<string, MutableTarget>();

  const ensureTarget = (address: string): MutableTarget => {
    const normalized = address.toLowerCase();
    let target = targets.get(normalized);
    if (!target) {
      target = {
        target: normalized,
        isClosed: false,
        adminDelay: 0,
        functionRoles: new Map(),
      };
      targets.set(normalized, target);
    }
    return target;
  };

  for (const event of [...result.events].sort(compareEventOrder)) {
    const targetValue = argumentValue(result.argumentsByEvent, event.id, 'target');
    if (typeof targetValue !== 'string' || !/^0x[0-9a-f]{40}$/i.test(targetValue)) continue;
    const target = ensureTarget(targetValue);

    if (event.specId === TARGET_CLOSED_SPEC) {
      const closed = argumentValue(result.argumentsByEvent, event.id, 'closed');
      target.isClosed = closed === true || closed === 'true';
    } else if (event.specId === TARGET_FUNCTION_ROLE_SPEC) {
      const selector = argumentValue(result.argumentsByEvent, event.id, 'selector');
      const roleId = argumentValue(result.argumentsByEvent, event.id, 'roleId');
      if (typeof selector === 'string' && isUint64String(String(roleId))) {
        target.functionRoles.set(selector.toLowerCase(), String(roleId));
      }
    } else if (event.specId === TARGET_ADMIN_DELAY_SPEC) {
      const delay = finiteNumber(argumentValue(result.argumentsByEvent, event.id, 'delay'));
      const since = finiteNumber(argumentValue(result.argumentsByEvent, event.id, 'since'));
      if (since > Math.floor(Date.now() / 1000)) {
        target.pendingAdminDelay = { newDelay: delay, since };
      } else {
        target.adminDelay = delay;
        delete target.pendingAdminDelay;
      }
    }
  }

  return [...targets.values()]
    .map((target) => ({
      ...target,
      functionRoles: [...target.functionRoles.entries()]
        .map(([selector, roleId]) => ({ selector, roleId }))
        .sort((a, b) => a.selector.localeCompare(b.selector)),
    }))
    .sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * Scheduled operations are deliberately outside the authority graph model.
 * Returning null tells the sync layer to load them from the chain.
 */
export async function fetchOperationsFromSubgraph(
  chainId: number,
  manager: string,
  networkId?: string
): Promise<ScheduledOperation[] | null> {
  void chainId;
  void manager;
  void networkId;
  return null;
}

/** Fetch grant, revoke, and target history from generic event evidence. */
export async function fetchEventsFromSubgraph(
  chainId: number,
  manager: string,
  networkId?: string
): Promise<AccessManagerEventLog[] | null> {
  const result = await fetchAuthorityEventsWithArguments(
    chainId,
    manager,
    ACCESS_MANAGER_EVENT_SPECS,
    networkId
  );
  if (!result) return null;

  const history: AccessManagerEventLog[] = [];
  for (const event of [...result.events].sort((a, b) => -compareEventOrder(a, b))) {
    const base = {
      blockNumber: finiteNumber(event.blockNumber),
      transactionHash: event.transactionHash,
      timestamp: finiteNumber(event.timestamp),
    };

    if (event.specId === ACCESS_MANAGER_GRANT_SPEC || event.specId === ACCESS_MANAGER_REVOKE_SPEC) {
      const roleId = argumentValue(result.argumentsByEvent, event.id, 'roleId');
      const account = argumentValue(result.argumentsByEvent, event.id, 'account');
      if (!isUint64String(String(roleId)) || typeof account !== 'string') continue;
      history.push({
        ...base,
        type: event.specId === ACCESS_MANAGER_GRANT_SPEC ? 'grant' : 'revoke',
        roleId: String(roleId),
        account: account.toLowerCase(),
      });
    } else if (event.specId === TARGET_FUNCTION_ROLE_SPEC) {
      const roleId = argumentValue(result.argumentsByEvent, event.id, 'roleId');
      const target = argumentValue(result.argumentsByEvent, event.id, 'target');
      const selector = argumentValue(result.argumentsByEvent, event.id, 'selector');
      if (
        !isUint64String(String(roleId)) ||
        typeof target !== 'string' ||
        typeof selector !== 'string'
      ) {
        continue;
      }
      history.push({
        ...base,
        type: 'target-role',
        roleId: String(roleId),
        target: target.toLowerCase(),
        selector: selector.toLowerCase(),
      });
    } else if (event.specId === TARGET_CLOSED_SPEC) {
      const target = argumentValue(result.argumentsByEvent, event.id, 'target');
      if (typeof target !== 'string') continue;
      history.push({ ...base, type: 'target-closed', target: target.toLowerCase() });
    } else if (event.specId === ROLE_LABEL_SPEC) {
      const roleId = argumentValue(result.argumentsByEvent, event.id, 'roleId');
      const label = argumentValue(result.argumentsByEvent, event.id, 'label');
      if (!isUint64String(String(roleId)) || typeof label !== 'string') continue;
      history.push({ ...base, type: 'label', roleId: String(roleId), label });
    }
  }

  return history;
}

/** Build grant-only history when event evidence cannot be loaded. */
export function buildEventHistoryFromRoles(roles: AccessManagerRole[]): AccessManagerEventLog[] {
  const events: AccessManagerEventLog[] = [];

  for (const role of roles) {
    for (const member of role.members) {
      events.push({
        type: 'grant',
        blockNumber: 0,
        transactionHash: '',
        timestamp: member.since,
        roleId: role.roleId,
        account: member.address,
      });
    }
  }

  events.sort((a, b) => b.timestamp - a.timestamp);
  return events;
}
