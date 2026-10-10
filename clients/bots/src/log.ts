export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

export interface Logger {
    readonly name: string;
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    isDebug(): boolean;
    /** The same output with another name in the prefix, for example the name of a bot. */
    child(name: string): Logger;
}

const stdoutSink: LogSink = (line) => {
    process.stdout.write(line + '\n');
};

/** One line per event: `2026-10-10T15:04:05.123Z INFO  [maker-1] message`. */
export function createLogger(level: LogLevel, name: string, sink: LogSink = stdoutSink): Logger {
    const threshold = SEVERITY[level];
    const write = (lineLevel: LogLevel, message: string): void => {
        if (SEVERITY[lineLevel] >= threshold) {
            sink(`${new Date().toISOString()} ${lineLevel.toUpperCase().padEnd(5)} [${name}] ${message}`);
        }
    };
    return {
        name,
        debug: (message) => write('debug', message),
        info: (message) => write('info', message),
        warn: (message) => write('warn', message),
        error: (message) => write('error', message),
        isDebug: () => threshold <= SEVERITY.debug,
        child: (childName) => createLogger(level, childName, sink),
    };
}

/** A short description of any thrown value, for a log line. */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
        return `${error.message}${cause}`;
    }
    return String(error);
}
