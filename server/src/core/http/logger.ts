/* Structured logger. One JSON object per line on stdout (or a readable
   single line in development). No dependency; small enough to own.

   Never log PHI or secrets. Log ids, counts, statuses, durations. Request
   lines carry the request id so an error can be matched to its request. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export interface LogRecord { level: LogLevel; time: string; msg: string; [k: string]: unknown }

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (record: LogRecord, line: string) => void;

export interface LoggerOptions {
    level: LogLevel;
    format: 'json' | 'pretty';
    sink?: LogSink;
    now?: () => Date;
}

export class Logger {
    private readonly threshold: number;
    private readonly format: 'json' | 'pretty';
    private sink: LogSink;
    private readonly now: () => Date;

    constructor(opts: LoggerOptions, private readonly base: LogFields = {}) {
        this.threshold = ORDER[opts.level];
        this.format = opts.format;
        this.now = opts.now ?? (() => new Date());
        this.sink = opts.sink ?? ((_r, line) => { process.stdout.write(line + '\n'); });
        this.options = opts;
    }
    private readonly options: LoggerOptions;

    /** Replace where lines go (tests collect them). Applies to children too. */
    setSink(sink: LogSink): void {
        this.sink = sink;
        this.options.sink = sink;
    }

    child(fields: LogFields): Logger {
        const c = new Logger(this.options, { ...this.base, ...fields });
        c.sink = this.sink;
        return c;
    }

    enabled(level: LogLevel): boolean {
        return ORDER[level] >= this.threshold;
    }

    log(level: LogLevel, msg: string, fields: LogFields = {}): void {
        if (!this.enabled(level)) return;
        const record: LogRecord = { level, time: this.now().toISOString(), msg, ...this.base, ...fields };
        this.sink(record, this.format === 'json' ? JSON.stringify(record) : pretty(record));
    }

    debug(msg: string, fields?: LogFields): void { this.log('debug', msg, fields); }
    info(msg: string, fields?: LogFields): void { this.log('info', msg, fields); }
    warn(msg: string, fields?: LogFields): void { this.log('warn', msg, fields); }
    error(msg: string, fields?: LogFields): void { this.log('error', msg, fields); }
}

function pretty(r: LogRecord): string {
    const { level, time, msg, ...rest } = r;
    const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    return `${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? '  ' + extra : ''}`;
}

/** Fields safe to log from an Error: name, message, stack. Callers decide what to keep. */
export function errorFields(err: unknown): LogFields {
    if (err instanceof Error) {
        const e = err as Error & { status?: number; code?: string };
        return { errName: e.name, errMessage: e.message, ...(e.status ? { status: e.status } : {}), ...(e.code ? { code: e.code } : {}), stack: e.stack };
    }
    return { errMessage: String(err) };
}
