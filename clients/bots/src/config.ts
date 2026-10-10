import type { LogLevel } from './log.js';

export interface Config {
    /** Core itself, not the gateway: the internal API is not reachable through the gateway. */
    coreUrl: string;
    /** Value of the X-Internal-Token header. */
    internalToken: string;
    makers: number;
    takers: number;
    /** Global cap on order and cancel requests per second, shared by all bots. */
    ordersPerSecond: number;
    logLevel: LogLevel;
}

export class ConfigError extends Error {
    override name = 'ConfigError';
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const internalToken = (env['INTERNAL_TOKEN'] ?? '').trim();
    if (internalToken === '') {
        throw new ConfigError('INTERNAL_TOKEN is required: the shared secret core expects in X-Internal-Token');
    }
    return {
        coreUrl: parseUrl(env['CORE_URL'] ?? 'http://localhost:8080'),
        internalToken,
        makers: parseInteger(env, 'BOT_MAKERS', 2, 0, 20),
        takers: parseInteger(env, 'BOT_TAKERS', 3, 0, 50),
        ordersPerSecond: parseNumber(env, 'BOT_ORDERS_PER_SECOND', 2, 0.01, 10_000),
        logLevel: parseLogLevel(env['LOG_LEVEL']),
    };
}

function parseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new ConfigError(`CORE_URL is not a valid URL: "${value}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConfigError(`CORE_URL must be an http or https URL: "${value}"`);
    }
    // Paths are appended to it, so it must not end with a slash
    return url.toString().replace(/\/+$/, '');
}

function parseInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const value = parseNumber(env, name, fallback, min, max);
    if (!Number.isInteger(value)) {
        throw new ConfigError(`${name} must be a whole number, got "${env[name]}"`);
    }
    return value;
}

function parseNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new ConfigError(`${name} must be a number from ${min} to ${max}, got "${raw}"`);
    }
    return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
    const value = (raw ?? '').trim().toLowerCase();
    if (value === '') {
        return 'info';
    }
    if (!(LOG_LEVELS as readonly string[]).includes(value)) {
        throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
    }
    return value as LogLevel;
}
