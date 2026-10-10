import { BotApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger, describeError } from './log.js';

// Logging must never kill the bots: a closed stdout (EPIPE) would otherwise be an unhandled stream error
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let config;
try {
    config = loadConfig();
} catch (error) {
    if (error instanceof ConfigError) {
        createLogger('info', 'bots').error(error.message);
        process.exit(1);
    }
    throw error;
}

const log = createLogger(config.logLevel, 'bots');
const app = new BotApp({ config, log });

let signals = 0;
const onSignal = (signal: NodeJS.Signals): void => {
    signals++;
    if (signals > 1) {
        log.warn(`${signal} again, exiting without waiting for the cleanup`);
        process.exit(0);
    }
    void app.stop(signal).finally(() => process.exit(0));
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

// The loops catch their own errors; anything that slips through is logged instead of killing the bots
process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${describeError(reason)}`);
});

app.run().then(
    () => process.exit(0),
    (error: unknown) => {
        log.error(`fatal: ${describeError(error)}`);
        process.exit(1);
    },
);
