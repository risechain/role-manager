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
const ACCESS_MANAGER_SPEC_IDS = [
  'core.operation-scheduled',
  'core.operation-executed',
  'core.operation-canceled',
  'core.access-manager-role-admin-changed',
  'core.role-guardian-changed',
  'core.role-grant-delay-changed',
  'core.access-manager-role-granted',
  'core.access-manager-role-revoked',
  'core.role-label',
  'core.target-closed',
  'core.target-function-role-updated',
  'core.target-admin-delay-updated',
];

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

function mockEvidence(
  entries: Array<{ specId: string; args: Record<string, string>; block: number }>
) {
  getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const { query } = requestFrom(init);
    if (query.includes('authorityRelationCurrents'))
      return response({ authorityRelationCurrents: { items: [] } });
    if (query.includes('authorityGraphEventArguments'))
      return response({
        authorityGraphEventArguments: {
          items: entries.flatMap((entry) =>
            Object.entries(entry.args).map(([name, rawValue]) => ({
              eventId: String(entry.block),
              name,
              rawValue,
              jsonValue: null,
            }))
          ),
        },
      });
    return response({
      authorityGraphEvents: {
        items: entries.map((entry) => ({
          id: String(entry.block),
          specId: entry.specId,
          blockNumber: String(entry.block),
          transactionIndex: 0,
          logIndex: 0,
          transactionHash: '0x01',
          timestamp: '100',
        })),
      },
    });
  });
}

describe('AccessManager authority graph client', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    getMock.mockReset();
  });

  it('uses manager-scoped authority events and source coverage for availability', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);
      expect(query).toContain('authorityGraphEvents');
      expect(query).toContain('authoritySourceCoverages');
      expect(variables).toMatchObject({
        chainId: 1,
        managerNodeId: `eip155:1:${MANAGER}`,
      });
      expect(variables.specIds).toContain('core.role-label');
      expect(variables.coverageIds).toEqual(
        ACCESS_MANAGER_SPEC_IDS.map((specId) => `1:coverage:${specId}`)
      );

      return response({
        _meta: { status: {} },
        authoritySourceCoverages: {
          items: ACCESS_MANAGER_SPEC_IDS.map((specId) => ({
            id: `1:coverage:${specId}`,
            configuredStartBlock: '24166604',
          })),
        },
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
        authoritySourceCoverages: {
          items: ACCESS_MANAGER_SPEC_IDS.map((specId) => ({
            id: `1:coverage:${specId}`,
            configuredStartBlock: '24166604',
          })),
        },
        authorityGraphEvents: { totalCount: 1 },
      })
    );

    await expect(isSubgraphAvailable(1, MANAGER, 'coverage-gap', 24_166_603)).resolves.toBe(false);
  });

  it('falls back to RPC when any consumed event specification starts too late', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        _meta: { status: {} },
        authoritySourceCoverages: {
          items: ACCESS_MANAGER_SPEC_IDS.map((specId) => ({
            id: `1:coverage:${specId}`,
            configuredStartBlock:
              specId === 'core.target-function-role-updated' ? '24166605' : '24166604',
          })),
        },
        authorityGraphEvents: { totalCount: 1 },
      })
    );

    await expect(isSubgraphAvailable(1, MANAGER, 'partial-coverage', 24_166_604)).resolves.toBe(
      false
    );
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
              { eventId: 'revoked', name: 'account', rawValue: MEMBER, jsonValue: MEMBER },
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

  it('discovers roles referenced only by target function mappings', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);

      if (query.includes('authorityRelationCurrents')) {
        return response({ authorityRelationCurrents: { items: [] } });
      }

      if (query.includes('authorityGraphEventArguments')) {
        return response({
          authorityGraphEventArguments: {
            items: [
              { eventId: 'target-role', name: 'roleId', rawValue: '11', jsonValue: '11' },
              { eventId: 'target-role', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              {
                eventId: 'target-role',
                name: 'selector',
                rawValue: '0x12345678',
                jsonValue: '0x12345678',
              },
            ],
          },
        });
      }

      const includesTargetRoles = (variables.specIds as string[]).includes(
        'core.target-function-role-updated'
      );
      return response({
        authorityGraphEvents: {
          items: includesTargetRoles
            ? [
                {
                  id: 'target-role',
                  blockNumber: '10',
                  transactionIndex: 0,
                  logIndex: 0,
                  transactionHash: '0x01',
                  timestamp: '100',
                  specId: 'core.target-function-role-updated',
                },
              ]
            : [],
        },
      });
    });

    await expect(fetchRolesFromSubgraph(1, MANAGER, 'target-role-only')).resolves.toEqual([
      {
        roleId: AM_ADMIN_ROLE_ID,
        label: null,
        adminRoleId: AM_ADMIN_ROLE_ID,
        guardianRoleId: AM_PUBLIC_ROLE_ID,
        grantDelay: 0,
        members: [],
      },
      {
        roleId: '11',
        label: null,
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
      const { query, variables } = requestFrom(init);

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
              { eventId: 'closed', name: 'target', rawValue: TARGET, jsonValue: TARGET },
              { eventId: 'closed', name: 'closed', rawValue: 'true', jsonValue: true },
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
      expect(variables.specIds).not.toContain('core.target-closed');
      return response({
        authorityGraphEvents: {
          items: [
            {
              id: 'closed',
              blockNumber: '14',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x05',
              timestamp: '104',
              specId: 'core.target-closed',
            },
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
        expect((variables.eventIds as string[]).length).toBeLessThanOrEqual(100);
        return response({
          authorityGraphEventArguments: {
            items: (variables.eventIds as string[]).flatMap((eventId) => [
              { eventId, name: 'roleId', rawValue: '7', jsonValue: '7' },
              { eventId, name: 'account', rawValue: MEMBER, jsonValue: MEMBER },
            ]),
          },
        });
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

    await expect(fetchEventsFromSubgraph(1, MANAGER, 'pagination')).resolves.toHaveLength(1000);
    expect(eventOffsets).toEqual([0, 1000]);
  });
  it('normalizes manager addresses and paginates more than 1000 current members', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    const offsets: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);
      expect(variables.managerNodeId).toBe(`eip155:4153:${MANAGER}`);
      if (query.includes('authorityGraphEvents'))
        return response({ authorityGraphEvents: { items: [] } });
      const offset = variables.offset as number;
      offsets.push(offset);
      return response({
        authorityRelationCurrents: {
          items: Array.from({ length: offset === 0 ? 1000 : 1 }, (_, i) => ({
            scopeKey: '18446744073709551615',
            toNodeId: `eip155:4153:0x${(offset + i + 1).toString(16).padStart(40, '0')}`,
            attributes: JSON.stringify({ delay: '45', since: '1700000000' }),
          })),
        },
      });
    });
    const roles = await fetchRolesFromSubgraph(4153, MANAGER.toUpperCase(), 'member-pages');
    expect(roles?.[1].roleId).toBe(AM_PUBLIC_ROLE_ID);
    expect(roles?.[1].members).toHaveLength(1001);
    expect(offsets).toEqual([0, 1000]);
  });

  it('ignores non-EVM, other-chain, malformed member IDs and non-uint64 role scopes', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query } = requestFrom(init);
      if (query.includes('authorityGraphEvents'))
        return response({ authorityGraphEvents: { items: [] } });
      const invalid = [
        { scopeKey: '7', toNodeId: `eip155:2:${MEMBER}` },
        { scopeKey: '7', toNodeId: `remote:1:${MEMBER}` },
        { scopeKey: '7', toNodeId: 'eip155:1:0x1234' },
        { scopeKey: '18446744073709551616', toNodeId: `eip155:1:${MEMBER}` },
        { scopeKey: '-1', toNodeId: `eip155:1:${MEMBER}` },
      ];
      return response({
        authorityRelationCurrents: {
          items: invalid.map((item) => ({
            ...item,
            attributes: { delay: '0', since: '1' },
          })),
        },
      });
    });
    const roles = await fetchRolesFromSubgraph(1, MANAGER, 'invalid-identifiers');
    expect(roles).toHaveLength(1);
    expect(roles?.[0].members).toEqual([]);
  });

  it.each([
    ['core.access-manager-role-admin-changed', { roleId: '8', admin: '9' }, ['0', '8', '9']],
    ['core.role-guardian-changed', { roleId: '8', guardian: '10' }, ['0', '8', '10']],
    ['core.role-grant-delay-changed', { roleId: '8', delay: '60', since: '100' }, ['0', '8']],
  ])('discovers configured roles from %s without memberships', async (specId, args, expected) => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query } = requestFrom(init);
      if (query.includes('authorityRelationCurrents'))
        return response({ authorityRelationCurrents: { items: [] } });
      if (query.includes('authorityGraphEventArguments'))
        return response({
          authorityGraphEventArguments: {
            items: Object.entries(args).map(([name, rawValue]) => ({
              eventId: 'config',
              name,
              rawValue,
              jsonValue: null,
            })),
          },
        });
      return response({
        authorityGraphEvents: {
          items: [
            {
              id: 'config',
              blockNumber: '10',
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: '0x01',
              timestamp: '100',
              specId,
            },
          ],
        },
      });
    });
    expect(
      (await fetchRolesFromSubgraph(1, MANAGER, 'config'))?.map((role) => role.roleId)
    ).toEqual(expected);
  });

  it('returns empty target/history collections for valid empty responses', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response({ authorityGraphEvents: { items: [] } }));
    await expect(fetchTargetsFromSubgraph(1, MANAGER, 'empty')).resolves.toEqual([]);
    await expect(fetchEventsFromSubgraph(1, MANAGER, 'empty')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ok: false, json: async () => ({}) },
    {
      ok: true,
      json: async () => ({
        errors: [{ message: 'query failed' }],
        data: { authorityGraphEvents: { items: [] } },
      }),
    },
    response({}),
    response({ authorityGraphEvents: null }),
  ])('returns null for failed or incomplete responses', async (reply) => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply as Response);
    await expect(fetchTargetsFromSubgraph(1, MANAGER, 'failed')).resolves.toBeNull();
    await expect(fetchEventsFromSubgraph(1, MANAGER, 'failed')).resolves.toBeNull();
    await expect(fetchRolesFromSubgraph(1, MANAGER, 'failed')).resolves.toBeNull();
  });

  it('does not cache availability across endpoint changes', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://first.test/graphql' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        _meta: { status: {} },
        authoritySourceCoverages: {
          items: ACCESS_MANAGER_SPEC_IDS.map((specId) => ({
            id: `1:coverage:${specId}`,
            configuredStartBlock: '0',
          })),
        },
        authorityGraphEvents: { totalCount: 1 },
      })
    );
    await expect(isSubgraphAvailable(1, MANAGER, 'changed-endpoint', 100)).resolves.toBe(true);
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://second.test/graphql' });
    fetchMock.mockResolvedValue(response({ authorityGraphEvents: { totalCount: 0 } }));
    await expect(isSubgraphAvailable(1, MANAGER, 'changed-endpoint', 100)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the request timeout after network failure', async () => {
    vi.useFakeTimers();
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(fetchEventsFromSubgraph(1, MANAGER, 'offline')).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects missing event arguments instead of returning partial state', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (requestFrom(init).query.includes('authorityGraphEventArguments'))
        return response({ authorityGraphEventArguments: { items: [] } });
      return response({
        authorityGraphEvents: {
          items: [
            {
              id: 'missing',
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
    await expect(fetchTargetsFromSubgraph(1, MANAGER, 'missing-args')).resolves.toBeNull();
  });
  it('reconstructs scheduled operations by nonce across cancellation, execution and rescheduling', async () => {
    const id = `0x${'11'.repeat(32)}`;
    const otherId = `0x${'22'.repeat(32)}`;
    const schedule = {
      operationId: id,
      nonce: '1',
      schedule: '1700000000',
      caller: MEMBER,
      target: TARGET,
      data: '0x12345678',
    };
    mockEvidence([
      { block: 5, specId: 'core.operation-executed', args: { operationId: otherId, nonce: '1' } },
      { block: 3, specId: 'core.operation-scheduled', args: { ...schedule, nonce: '2' } },
      { block: 1, specId: 'core.operation-scheduled', args: schedule },
      { block: 4, specId: 'core.operation-scheduled', args: { ...schedule, operationId: otherId } },
      { block: 2, specId: 'core.operation-canceled', args: { operationId: id, nonce: '1' } },
    ]);
    expect(await fetchOperationsFromSubgraph(1, MANAGER, 'operations')).toEqual([
      expect.objectContaining({
        operationId: id,
        nonce: 2,
        schedule: 1700000000,
        caller: MEMBER,
        target: TARGET,
        data: '0x12345678',
      }),
    ]);
  });

  it('fails operation discovery on malformed identifiers or missing evidence', async () => {
    mockEvidence([
      { block: 1, specId: 'core.operation-canceled', args: { operationId: '0x01', nonce: '1' } },
    ]);
    await expect(
      fetchOperationsFromSubgraph(1, MANAGER, 'malformed-operation')
    ).resolves.toBeNull();
  });

  it('retains zero-address grant candidates omitted by the graph relation policy', async () => {
    mockEvidence([
      {
        block: 1,
        specId: 'core.access-manager-role-granted',
        args: { roleId: '7', account: `0x${'0'.repeat(40)}` },
      },
    ]);
    expect((await fetchRolesFromSubgraph(1, MANAGER, 'zero-member'))?.[1].members).toEqual([
      { address: `0x${'0'.repeat(40)}`, since: 0, executionDelay: 0 },
    ]);
  });

  it('rejects invalid selectors and replays valid selector reassignment chronologically', async () => {
    mockEvidence([
      {
        block: 3,
        specId: 'core.target-function-role-updated',
        args: { roleId: '9', target: TARGET, selector: '0x12345678' },
      },
      {
        block: 1,
        specId: 'core.target-function-role-updated',
        args: { roleId: '7', target: TARGET, selector: '0x12345678' },
      },
      {
        block: 2,
        specId: 'core.target-function-role-updated',
        args: { roleId: '8', target: TARGET, selector: '0x12' },
      },
    ]);
    expect((await fetchTargetsFromSubgraph(1, MANAGER, 'selectors'))?.[0].functionRoles).toEqual([
      { selector: '0x12345678', roleId: '9' },
    ]);
    expect(await fetchEventsFromSubgraph(1, MANAGER, 'selectors')).toHaveLength(2);
  });

  it.each([
    ['0', true],
    ['100', false],
  ])('requires genesis coverage when deployment is unknown (%s)', async (start, expected) => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        _meta: { status: {} },
        authorityGraphEvents: { totalCount: 1 },
        authoritySourceCoverages: {
          items: ACCESS_MANAGER_SPEC_IDS.map((specId) => ({
            id: `1:coverage:${specId}`,
            configuredStartBlock: start,
          })),
        },
      })
    );
    await expect(isSubgraphAvailable(1, MANAGER, `unknown-deployment-${start}`)).resolves.toBe(
      expected
    );
  });

  it('returns null if a later page fails instead of accepting a truncated role snapshot', async () => {
    getMock.mockReturnValue({ accessControlIndexerUrl: 'https://indexer.test/graphql' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { query, variables } = requestFrom(init);
      if (query.includes('authorityGraphEvents'))
        return response({ authorityGraphEvents: { items: [] } });
      if (variables.offset !== 0) return { ok: false } as Response;
      return response({
        authorityRelationCurrents: {
          items: Array.from({ length: 1000 }, () => ({
            scopeKey: '7',
            toNodeId: `eip155:1:${MEMBER}`,
            attributes: { delay: '0', since: '1' },
          })),
        },
      });
    });
    await expect(fetchRolesFromSubgraph(1, MANAGER, 'failed-page')).resolves.toBeNull();
  });
});
