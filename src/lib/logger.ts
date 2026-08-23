// ============================================================
//  Structured Logger — single source of truth for all logging.
//  Replaces scattered console.log/error/warn calls.
//
//  Features:
//  - Log levels: debug, info, warn, error
//  - Structured output: { level, msg, data, timestamp }
//  - Environment-aware: debug in dev, info+ in prod
//  - Non-blocking: error stack traces only in dev
//
//  Usage:
//    import { logger } from '@/lib/logger';
//    logger.info('analysis completed', { durationMs: 8000, cacheHit: false });
//    logger.error('query failed', { error: e.message, query: 'execSummary' });
// ============================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// In production, only log info+. In dev, log debug+.
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function format(entry: LogEntry): string {
  const { level, msg, data, timestamp } = entry;
  if (data && Object.keys(data).length > 0) {
    return `[${timestamp}] ${level.toUpperCase()}: ${msg} ${JSON.stringify(data)}`;
  }
  return `[${timestamp}] ${level.toUpperCase()}: ${msg}`;
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog('debug')) return;
    const entry: LogEntry = { level: 'debug', msg, data, timestamp: new Date().toISOString() };
    if (process.env.NODE_ENV !== 'production') {
      console.debug(format(entry));
    }
  },

  info(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog('info')) return;
    const entry: LogEntry = { level: 'info', msg, data, timestamp: new Date().toISOString() };
    console.log(format(entry));
  },

  warn(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog('warn')) return;
    const entry: LogEntry = { level: 'warn', msg, data, timestamp: new Date().toISOString() };
    console.warn(format(entry));
  },

  error(msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog('error')) return;
    const entry: LogEntry = { level: 'error', msg, data, timestamp: new Date().toISOString() };
    console.error(format(entry));
  },
};
