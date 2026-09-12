declare module "sql.js" {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export type { Database, QueryExecResult, SqlJsStatic };
  export default function initSqlJs(): Promise<SqlJsStatic>;
}
