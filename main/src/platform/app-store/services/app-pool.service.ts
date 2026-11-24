import { Injectable, Logger } from '@nestjs/common';
import { Pool as PgPool } from 'pg';

/**
 * Manages per-app PostgreSQL connection pools.
 * Each installed app gets an isolated pg.Pool using its dedicated role.
 */
export interface AppPoolCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * 父进程（主台）侧为该应用建池的上限。独立进程应用（MC09）的业务查询在子进程自己的池中执行，
 * 主台侧只留 2 个连接给迁移与平台操作；其余应用沿用 manifest 声明。
 */
export function parentPoolMax(manifest: {
  backend?: { runtime?: string };
  database?: { poolMax?: number };
}): number {
  if (manifest.backend?.runtime === 'process') return 2;
  return manifest.database?.poolMax ?? 3;
}

@Injectable()
export class AppPoolService {
  private readonly logger = new Logger(AppPoolService.name);
  private readonly pools = new Map<string, PgPool>();
  /** 建池时的连接参数，供独立进程应用的子进程握手使用（MC09）；只在内存中 */
  private readonly credentials = new Map<string, AppPoolCredentials>();

  /** Create or replace the connection pool for an app */
  async createPool(appId: string, opts: {
    host: string;
    port: number;
    database: string;
    user: string;    // app role name
    password: string;
    max: number;
  }): Promise<void> {
    await this.destroyPool(appId);

    const pool = new PgPool({
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      max: opts.max,
    });

    this.pools.set(appId, pool);
    this.credentials.set(appId, {
      host: opts.host, port: opts.port, database: opts.database, user: opts.user, password: opts.password,
    });
    this.logger.log(`Created pool for app ${appId} (max=${opts.max}, user=${opts.user})`);
  }

  /** 当前池的连接参数（含口令）；没有池时为 undefined */
  getCredentials(appId: string): AppPoolCredentials | undefined {
    const c = this.credentials.get(appId);
    return c ? { ...c } : undefined;
  }

  /** Get the pool for an app, or throw if not found */
  getPool(appId: string): PgPool {
    const pool = this.pools.get(appId);
    if (!pool) throw new Error(`No connection pool for app ${appId}`);
    return pool;
  }

  /** Check if a pool exists for the app */
  hasPool(appId: string): boolean {
    return this.pools.has(appId);
  }

  /** Run a function in a transaction on the app's pool */
  async transaction<T>(appId: string, fn: (client: any) => Promise<T>): Promise<T> {
    const pool = this.getPool(appId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Gracefully drain and remove the pool for an app */
  async destroyPool(appId: string): Promise<void> {
    const existing = this.pools.get(appId);
    if (existing) {
      await existing.end().catch(err =>
        this.logger.warn(`Error draining pool for app ${appId}: ${err.message}`),
      );
      this.pools.delete(appId);
      this.logger.log(`Destroyed pool for app ${appId}`);
    }
    this.credentials.delete(appId);
  }

  /** Drain all pools (called on module destroy) */
  async destroyAll(): Promise<void> {
    for (const [appId] of this.pools) {
      await this.destroyPool(appId);
    }
  }
}
