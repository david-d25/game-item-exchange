import http from 'node:http';
import https from 'node:https';
import { backoffDelay, type BackoffOptions } from './backoff.js';
import type { Logger } from './log.js';
import type { Rng } from './random.js';
import { abortError, sleep } from './sleep.js';

export interface HttpClientOptions {
    baseUrl: string;
    /** Time limit of one attempt, including reading the body. */
    timeoutMs: number;
    /** Attempts per request for retryable failures (429, 5xx, network errors, timeouts). */
    maxAttempts: number;
    backoff: BackoffOptions;
    rng: Rng;
    log: Logger;
}

export interface RequestSpec {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    /** Sent as JSON. The very same body is sent again on retries, so idempotency keys stay the same. */
    body?: unknown;
    headers?: Record<string, string>;
    /** Aborts the backoff waits and the request in flight. */
    signal: AbortSignal;
    /** Runs before every attempt, retries included: this is where order requests take a rate-limit token. */
    beforeAttempt?: () => Promise<void>;
    maxAttempts?: number;
}

export interface HttpResponse<T> {
    status: number;
    body: T;
}

/** A response with an error status. `type` is the Problem Details type, the part clients branch on. */
export class ApiError extends Error {
    override name = 'ApiError';

    constructor(
        readonly method: string,
        readonly path: string,
        readonly status: number,
        readonly type: string,
        readonly detail: string,
    ) {
        super(`${method} ${path}: ${status} ${type}${detail ? `: ${detail}` : ''}`);
    }

    /** The last segment of the type, for example "insufficient-funds" for "/problems/insufficient-funds". */
    get problem(): string {
        return this.type.slice(this.type.lastIndexOf('/') + 1);
    }

    is(problem: string): boolean {
        return this.problem === problem;
    }

    get retryable(): boolean {
        return isRetryableStatus(this.status);
    }
}

/** The request never got a response: connection refused or reset, DNS failure, timeout. */
export class TransportError extends Error {
    override name = 'TransportError';
}

function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

interface RawResponse {
    status: number;
    retryAfter: string | null;
    text: string;
}

const MAX_RETRY_AFTER_MS = 30_000;
/** No response of the API comes anywhere near this; a bigger one is a mistake and is cut off. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * JSON over HTTP with retries. Built on node:http rather than fetch: fetch (undici, with its WebAssembly
 * parser) costs tens of megabytes of resident memory more, and the bots run on a server with very little.
 */
export class HttpClient {
    private readonly transport: typeof http | typeof https;
    private readonly agent: http.Agent;

    constructor(private readonly options: HttpClientOptions) {
        const secure = options.baseUrl.startsWith('https:');
        this.transport = secure ? https : http;
        // Keep-alive: the bots talk to one host all the time. Idle sockets are closed after a while.
        const agentOptions = { keepAlive: true, keepAliveMsecs: 1_000, maxSockets: 16, maxFreeSockets: 8, timeout: 30_000 };
        this.agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    }

    get baseUrl(): string {
        return this.options.baseUrl;
    }

    /** Closes idle keep-alive connections. Requests still in flight are not affected. */
    close(): void {
        this.agent.destroy();
    }

    /**
     * Sends a request and parses the JSON response. Retries 429, 5xx and network errors with exponential
     * backoff and jitter; any other error status is thrown at once as an ApiError.
     */
    async request<T>(spec: RequestSpec): Promise<HttpResponse<T>> {
        const url = this.url(spec);
        const maxAttempts = spec.maxAttempts ?? this.options.maxAttempts;
        const headers: Record<string, string> = {
            accept: 'application/json, application/problem+json',
            'user-agent': 'game-item-exchange-bots/0.1',
            ...spec.headers,
        };
        let body: string | undefined;
        if (spec.body !== undefined) {
            body = JSON.stringify(spec.body);
            headers['content-type'] = 'application/json';
        }

        for (let attempt = 0; ; attempt++) {
            if (spec.signal.aborted) {
                throw abortError();
            }
            await spec.beforeAttempt?.();

            let failure: Error;
            let retryAfterMs = 0;
            try {
                const raw = await this.send(url, spec.method, headers, body, spec.signal);
                if (raw.status < 400) {
                    return { status: raw.status, body: this.parseBody<T>(spec, raw) };
                }
                const error = toApiError(spec, raw);
                if (!error.retryable) {
                    throw error;
                }
                failure = error;
                retryAfterMs = parseRetryAfter(raw.retryAfter);
            } catch (error) {
                if (error instanceof ApiError) {
                    throw error;
                }
                if (spec.signal.aborted) {
                    throw abortError();
                }
                failure = new TransportError(`${spec.method} ${spec.path}: ${describe(error)}`, { cause: error });
            }

            if (attempt + 1 >= maxAttempts) {
                throw failure;
            }
            const delay = Math.max(backoffDelay(attempt, this.options.backoff, this.options.rng), retryAfterMs);
            this.options.log.debug(`retry ${attempt + 1} of ${spec.method} ${spec.path} in ${Math.round(delay)} ms: ${failure.message}`);
            if (!(await sleep(delay, spec.signal))) {
                throw abortError();
            }
        }
    }

    private url(spec: RequestSpec): string {
        const url = new URL(this.options.baseUrl + spec.path);
        for (const [key, value] of Object.entries(spec.query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    /**
     * One attempt with its own timeout, which covers reading the body too: a stalled response must not hang
     * the bot. The abort signal is listened to only while the request runs, so a long-lived signal does not
     * collect references to finished requests.
     */
    private send(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string | undefined,
        outer: AbortSignal,
    ): Promise<RawResponse> {
        return new Promise<RawResponse>((resolve, reject) => {
            let done = false;
            const finish = (settle: () => void): void => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    outer.removeEventListener('abort', onAbort);
                    settle();
                }
            };
            const requestHeaders = body === undefined ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) };
            const request = this.transport.request(url, { method, headers: requestHeaders, agent: this.agent }, (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) {
                        request.destroy(new Error(`response larger than ${MAX_BODY_BYTES} bytes`));
                    } else {
                        chunks.push(chunk);
                    }
                });
                response.on('end', () =>
                    finish(() =>
                        resolve({
                            status: response.statusCode ?? 0,
                            retryAfter: firstHeader(response.headers['retry-after']),
                            text: Buffer.concat(chunks).toString('utf8'),
                        }),
                    ),
                );
                response.on('error', (error) => finish(() => reject(error)));
                response.on('close', () => {
                    if (!response.complete) {
                        finish(() => reject(new Error('the connection closed before the response was complete')));
                    }
                });
            });
            const onAbort = (): void => {
                request.destroy(abortError());
            };
            const timer = setTimeout(() => {
                const timeout = new Error(`no response within ${this.options.timeoutMs} ms`);
                timeout.name = 'TimeoutError';
                request.destroy(timeout);
            }, this.options.timeoutMs);
            outer.addEventListener('abort', onAbort, { once: true });
            request.on('error', (error) => finish(() => reject(error)));
            request.end(body);
        });
    }

    private parseBody<T>(spec: RequestSpec, raw: RawResponse): T {
        if (raw.text.trim() === '') {
            return undefined as T;
        }
        try {
            return JSON.parse(raw.text) as T;
        } catch {
            throw new ApiError(spec.method, spec.path, raw.status, '/client/invalid-response', 'the response is not JSON');
        }
    }
}

function toApiError(spec: RequestSpec, raw: RawResponse): ApiError {
    let type = 'about:blank';
    let detail = '';
    try {
        const problem: unknown = JSON.parse(raw.text);
        if (problem !== null && typeof problem === 'object') {
            const fields = problem as Record<string, unknown>;
            if (typeof fields['type'] === 'string') {
                type = fields['type'];
            }
            if (typeof fields['detail'] === 'string') {
                detail = fields['detail'];
            } else if (typeof fields['title'] === 'string') {
                detail = fields['title'];
            }
        }
    } catch {
        detail = raw.text.slice(0, 200);
    }
    return new ApiError(spec.method, spec.path, raw.status, type, detail);
}

function firstHeader(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

function parseRetryAfter(value: string | null): number {
    if (value === null) {
        return 0;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

function describe(error: unknown): string {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
        return `${error.message}${cause}`;
    }
    return String(error);
}
