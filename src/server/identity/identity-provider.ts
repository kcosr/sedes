import type Database from "better-sqlite3";

export type RequestScope = Readonly<{
  tenantId: string;
  principalId: string;
}>;

export interface IdentityProvider<RequestLike = unknown> {
  resolve(request: RequestLike): Promise<RequestScope>;
}

type ScopeRow = {
  tenantId: string;
  principalId: string;
};

export class SingleUserIdentityProvider<RequestLike = unknown>
  implements IdentityProvider<RequestLike>
{
  readonly #scope: RequestScope;

  constructor(database: Database.Database) {
    const rows = database
      .prepare(
        `
          SELECT p.tenant_id AS tenantId, p.id AS principalId
          FROM principals p
          WHERE p.kind = 'local_human'
          ORDER BY p.tenant_id, p.id
        `,
      )
      .all() as ScopeRow[];
    if (rows.length !== 1) {
      throw new Error(
        `Expected exactly one seeded local principal; found ${rows.length}.`,
      );
    }
    const row = rows[0];
    if (!row) {
      throw new Error("The seeded local principal is missing.");
    }
    this.#scope = Object.freeze({
      tenantId: row.tenantId,
      principalId: row.principalId,
    });
  }

  async resolve(_request: RequestLike): Promise<RequestScope> {
    return this.#scope;
  }

  getScope(): RequestScope {
    return this.#scope;
  }
}
