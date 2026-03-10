declare module "node:sqlite" {
  interface StatementSync {
    all<T = Record<string, unknown>>(...parameters: unknown[]): T[];
    get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
    run(...parameters: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
