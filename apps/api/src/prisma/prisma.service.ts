import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Postgres sessions default to the server timezone (Asia/Kathmandu on dev), but every
// `timestamp without time zone` column stores UTC wall time. Without a forced UTC session,
// raw WHERE clauses that compare these columns against now() drift by the local offset.
const FORCE_UTC_SESSION = 'options=-c%20timezone%3DUTC';

// Sensible pool defaults for a single-node API on Postgres 15+. Tune via
// DATABASE_POOL_SIZE / DATABASE_POOL_TIMEOUT_MS.
const DEFAULT_POOL_SIZE = 10;
const DEFAULT_POOL_TIMEOUT_MS = 20_000;

function withUtcSession(url: string): string {
  if (!url) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${FORCE_UTC_SESSION}`;
}

function withPoolConfig(url: string): string {
  const poolSize = Number(process.env.DATABASE_POOL_SIZE) || DEFAULT_POOL_SIZE;
  const poolTimeoutMs = Number(process.env.DATABASE_POOL_TIMEOUT_MS) || DEFAULT_POOL_TIMEOUT_MS;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connection_limit=${poolSize}&pool_timeout=${poolTimeoutMs}&connect_prepared_statements=true&connect_prepared_statement_cache_size=500&connect_timeout=10`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly slowQueryMs = Number(process.env.DB_SLOW_QUERY_MS) || 500;
  private readonly logQueries =
    (process.env.DB_LOG_QUERIES ?? '').toLowerCase() === 'true';

  constructor() {
    let datasourceUrl = withUtcSession(process.env.DATABASE_URL ?? '');
    // Prisma bundles prepared statements and statement caching by default — the
    // pool sizing below is the lever that materially affects throughput under load.
    datasourceUrl = withPoolConfig(datasourceUrl);

    super({
      datasourceUrl,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    this.$on('query' as never, (e: { query: string; params: string; duration: number }) => {
      if (this.logQueries) {
        this.logger.debug(`DB query in ${e.duration}ms`, {
          query: e.query.slice(0, 400),
          params: e.params.slice(0, 200),
          durationMs: e.duration,
        });
      } else if (e.duration >= this.slowQueryMs) {
        this.logger.warn(`Slow DB query (${e.duration.toFixed(0)}ms)`, {
          query: e.query.slice(0, 400),
          durationMs: e.duration,
        });
      }
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}