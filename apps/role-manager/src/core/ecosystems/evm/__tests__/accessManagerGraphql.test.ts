import { afterEach, describe, expect, it, vi } from 'vitest';

import { AM_ADMIN_ROLE_ID, AM_PUBLIC_ROLE_ID } from '../../../../constants';
import {
  fetchEventsFromSubgraph,
  fetchOperationsFromSubgraph,
  fetchRolesFromSubgraph,
  fetchTargetsFromSubgraph,
  isSubgraphAvailable,
} from '../accessManagerGraphql';

const getMock = vi.fn();

const MANAGER = '0x1000000000000000000000000000000000000001';
const MEMBER = '0x2000000000000000000000000000000000000002';
const TARGET = '0x3000000000000000000000000000000000000003';

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

function requestFrom(init?: RequestInit): GraphqlRequest {
  return JSON.parse(String(init?.body)) as GraphqlRequest;
}

function response(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ data }),
  } as Response;
}

vi.mock('@openzeppelin/ui-utils', () => ({
  userNetworkServiceConfigService: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

describe('AccessManager authority graph client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMock.mockReset();
  });

  it('uses manager-scoped authority events and source coverage for availability', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);
      expect(query).toContain('authorityGraphEvents');
      expect(query).toContain('authoritySourceCoverage');
      expect(variables).toMatchObject({
        chainId: 1,
        managerNodeId: `eip155:1:${MANAGER}`,
      });
      expect(variables.specIds).toContain('core.role-label');

      return response({
        _meta: { status: {} },
        authoritySourceCoverage: { configuredStartBlock: '24166604' },
        authorityGraphEvents: { totalCount: 1 },
      });
    });

    await expect(isSubgraphAvailable(1, MANAGER, 'testnet', 24_166_604)).resolves.toBe(true);
  });

  it('falls back to RPC when graph coverage starts after manager deployment', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        _meta: { status: {} },
        authoritySourceCoverage: { configuredStartBlock: '24166604' },
        authorityGraphEvents: { totalCount: 1 },
      })
    );

    await expect(isSubgraphAvailable(1, MANAGER, 'coverage-gap', 24_166_603)).resolves.toBe(false);
  });

  it('groups current role-member relations by numeric role scope', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);

      if (query.includes('authorityGraphEventArguments')) {
        return response({
          authorityGraphEventArguments: {
            items: [
              { eventId: 'revoked', name: 'roleId', rawValue: '9', jsonValue: '9' },
              { eventId: 'label', name: 'roleId', rawValue: '9', jsonValue: '9' },
              {
                eventId: 'label',
                name: 'label',
                rawValue: 'Operator',
                jsonValue: null,
              },
            ],
          },
        });
      }

      if (query.includes('authorityGraphEvents')) {
        expect(variables).toMatchObject({
          chainId: 1,
          managerNodeId: `eip155:1:${MANAGER}`,
          offset: 0,
        });
        return response({
          authorityGraphEvents: {
            items: [
              {
                id: 'label',
                blockNumber: '9',
                transactionIndex: 0,
                logIndex: 0,
                transactionHash: '0x10',
                timestamp: '91',
                specId: 'core.role-label',
              },
              {
                id: 'revoked',
                blockNumber: '8',
                transactionIndex: 0,
                logIndex: 0,
                transactionHash: '0x09',
                timestamp: '90',
                specId: 'core.access-manager-role-revoked',
              },
            ],
          },
        });
      }

      expect(query).toContain('authorityRelationCurrents');
      expect(query).not.toContain('roles(');
      expect(variables).toEqual({
        chainId: 1,
        managerNodeId: `eip155:1:${MANAGER}`,
        offset: 0,
      });

      return response({
        authorityRelationCurrents: {
          items: [
            {
              scopeKey: '7',
              toNodeId: `eip155:1:${MEMBER}`,
              attributes: { delay: '45', since: '1700000000', newMember: true },
            },
            {
              scopeKey: `0x${'00'.repeat(32)}`,
              toNodeId: `eip155:1:${MEMBER}`,
              attributes: { sender: MANAGER },
            },
          ],
        },
      });
    });

    await expect(fetchRolesFromSubgraph(1, MANAGER, 'testnet')).resolves.toEqual([
      {
        roleId: AM_ADMIN_ROLE_ID,
        label: null,
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [],
      },
      {
        roleId: '7',
        label: null,
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [
          {
            address: MEMBER,
            executionDelay: 45,
            since: 1_700_000_000,
          },
        ],
      },
      {
        roleId: '9',
        label: 'Operator',
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [],
      },
    ]);
  });

  it('reconstructs target configuration from generic event evidence', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);

      if (query.includes('authorityGraphEventArguments')) {
        return response({
          authorityGraphEventArguments: {
            items: [
              { eventId: 'function', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              { eventId: 'function', name: 'selector', rawValue: '0x12345678', jsonValue: null },
              { eventId: 'function', name: 'roleId', rawValue: '7', jsonValue: '7' },
              { eventId: 'closed', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              { eventId: 'closed', name: 'closed', rawValue: 'true', jsonValue: true },
              { eventId: 'delay', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              { eventId: 'delay', name: 'delay', rawValue: '30', jsonValue: 30 },
              { eventId: 'delay', name: 'since', rawValue: '0', jsonValue: '0' },
            ],
          },
        });
      }

      expect(query).toContain('authorityGraphEvents');
      expect(variables).toMatchObject({
        chainId: 1,
        managerNodeId: `eip155:1:${MANAGER}`,
      });
      return response({
        authorityGraphEvents: {
          items: [
            {
              id: 'delay',
              blockNumber: '12',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x03',
              timestamp: '102',
              specId: 'core.target-admin-delay-updated',
            },
            {
              id: 'closed',
              blockNumber: '11',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x02',
              timestamp: '101',
              specId: 'core.target-closed',
            },
            {
              id: 'function',
              blockNumber: '10',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x01',
              timestamp: '100',
              specId: 'core.target-function-role-updated',
            },
          ],
        },
      });
    });

    await expect(fetchTargetsFromSubgraph(1, MANAGER, 'testnet')).resolves.toEqual([
      {
        target: TARGET,
        isClosed: true,
        adminDelay: 30,
        functionRoles: [{ selector: '0x12345678', roleId: '7' }],
      },
    ]);
  });

  it('maps generic event arguments into Role Manager history', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query } = requestFrom(init);

      if (query.includes('authorityGraphEventArguments')) {
        return response({
          authorityGraphEventArguments: {
            items: [
              { eventId: 'grant', name: 'roleId', rawValue: '7', jsonValue: '7' },
              { eventId: 'grant', name: 'account', rawValue: MEMBER, jsonValue: MEMBER },
              { eventId: 'revoke', name: 'roleId', rawValue: '7', jsonValue: '7' },
              { eventId: 'revoke', name: 'account', rawValue: MEMBER, jsonValue: MEMBER },
              { eventId: 'target', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              { eventId: 'target', name: 'selector', rawValue: '0x12345678', jsonValue: null },
              { eventId: 'target', name: 'roleId', rawValue: '7', jsonValue: '7' },
              { eventId: 'label', name: 'roleId', rawValue: '7', jsonValue: '7' },
              {
                eventId: 'label',
                name: 'label',
                rawValue: 'Operator',
                jsonValue: null,
              },
            ],
          },
        });
      }

      expect(query).toContain('authorityGraphEvents');
      return response({
        authorityGraphEvents: {
          items: [
            {
              id: 'label',
              blockNumber: '13',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x04',
              timestamp: '103',
              specId: 'core.role-label',
            },
            {
              id: 'target',
              blockNumber: '12',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x03',
              timestamp: '102',
              specId: 'core.target-function-role-updated',
            },
            {
              id: 'revoke',
              blockNumber: '11',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x02',
              timestamp: '101',
              specId: 'core.access-manager-role-revoked',
            },
            {
              id: 'grant',
              blockNumber: '10',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x01',
              timestamp: '100',
              specId: 'core.access-manager-role-granted',
            },
          ],
        },
      });
    });

    await expect(fetchEventsFromSubgraph(1, MANAGER, 'testnet')).resolves.toEqual([
      {
        type: 'label',
        blockNumber: 13,
        transactionHash: '0x04',
        timestamp: 103,
        roleId: '7',
        label: 'Operator',
      },
      {
        type: 'target-role',
        blockNumber: 12,
        transactionHash: '0x03',
        timestamp: 102,
        roleId: '7',
        target: TARGET,
        selector: '0x12345678',
      },
      {
        type: 'revoke',
        blockNumber: 11,
        transactionHash: '0x02',
        timestamp: 101,
        roleId: '7',
        account: MEMBER,
      },
      {
        type: 'grant',
        blockNumber: 10,
        transactionHash: '0x01',
        timestamp: 100,
        roleId: '7',
        account: MEMBER,
      },
    ]);
  });

  it('paginates authority events at the generated schema limit', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    const eventOffsets: number[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);
      if (query.includes('authorityGraphEventArguments')) {
        return response({ authorityGraphEventArguments: { items: [] } });
      }

      const offset = variables.offset as number;
      eventOffsets.push(offset);
      return response({
        authorityGraphEvents: {
          items:
            offset === 0
              ? Array.from({ length: 1000 }, (_, index) => ({
                  id: `event-${index}`,
                  blockNumber: String(index + 1),
                  transactionIndex: 0,
                  logIndex: 0,
                  transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
                  timestamp: String(index + 1),
                  specId: 'core.access-manager-role-granted',
                }))
              : [],
        },
      });
    });

    await expect(fetchEventsFromSubgraph(1, MANAGER, 'pagination')).resolves.toEqual([]);
    expect(eventOffsets).toEqual([0, 1000]);
  });

  it('does not claim scheduled-operation support from the authority graph', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(fetchOperationsFromSubgraph(1, MANAGER, 'testnet')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
