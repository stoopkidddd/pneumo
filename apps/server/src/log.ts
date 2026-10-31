import pino from "pino";

const REDACTED = "[Redacted]";

// Pino's paths are defense in depth for common shapes. The log hook below also
// handles secrets at arbitrary depths and case-insensitive header names.
const REDACTION_PATHS = [
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "req.headers.Authorization",
  "request.headers.authorization",
  "request.headers.Authorization",
  "token",
  "authKey",
  "setupToken",
  "envelope",
  "*.token",
  "*.authKey",
  "*.setupToken",
  "*.envelope",
  "*.*.token",
  "*.*.authKey",
  "*.*.setupToken",
  "*.*.envelope",
  "*.*.*.token",
  "*.*.*.authKey",
  "*.*.*.setupToken",
  "*.*.*.envelope",
  "webPush.keys.p256dh",
  "webPush.keys.auth",
  "subscription.keys.p256dh",
  "subscription.keys.auth",
  "*.webPush.keys.p256dh",
  "*.webPush.keys.auth",
  "*.subscription.keys.p256dh",
  "*.subscription.keys.auth",
] as const;

const SECRET_KEYS: Record<string, true> = {
  authorization: true,
  token: true,
  authkey: true,
  setuptoken: true,
  envelope: true,
};
const WEB_PUSH_CONTAINERS: Record<string, true> = {
  webpush: true,
  subscription: true,
};

type SanitizeContext = {
  readonly inWebPush: boolean;
  readonly isUrl: boolean;
};

const ROOT_CONTEXT: SanitizeContext = {
  inWebPush: false,
  isUrl: false,
};

function isUrlField(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "href" || normalized.endsWith("url");
}

function removeUrlQuery(value: string): string {
  const queryStart = value.search(/[?#]/u);
  if (queryStart === -1) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return value;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.startsWith("/") ? value.slice(0, queryStart) : value;
  }
}

function isSensitiveKey(key: string, inWebPush: boolean): boolean {
  const normalized = key.toLowerCase();
  return (
    SECRET_KEYS[normalized] === true ||
    (inWebPush && (normalized === "p256dh" || normalized === "auth"))
  );
}

function sanitizeValue(
  value: unknown,
  context: SanitizeContext,
  seen: WeakMap<object, Map<number, unknown>>,
): unknown {
  if (typeof value === "string") {
    return context.isUrl ? removeUrlQuery(value) : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof URL) {
    return removeUrlQuery(value.href);
  }
  if (value instanceof Error) {
    return { type: value.name };
  }
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }

  const contextKey = (context.inWebPush ? 1 : 0) | (context.isUrl ? 2 : 0);
  let contextCopies = seen.get(value);
  const existing = contextCopies?.get(contextKey);
  if (existing !== undefined) {
    return existing;
  }
  if (contextCopies === undefined) {
    contextCopies = new Map();
    seen.set(value, contextCopies);
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    contextCopies.set(contextKey, copy);
    for (const item of value) {
      copy.push(sanitizeValue(item, context, seen));
    }
    return copy;
  }

  const copy: Record<string, unknown> = {};
  contextCopies.set(contextKey, copy);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      continue;
    }

    const normalized = key.toLowerCase();
    const inWebPush = context.inWebPush || WEB_PUSH_CONTAINERS[normalized] === true;
    if (isSensitiveKey(key, inWebPush)) {
      copy[key] = REDACTED;
      continue;
    }

    copy[key] = sanitizeValue(
      descriptor.value,
      {
        inWebPush,
        isUrl: context.isUrl || isUrlField(key),
      },
      seen,
    );
  }
  return copy;
}

function sanitizeStructured(value: unknown): unknown {
  return sanitizeValue(value, ROOT_CONTEXT, new WeakMap());
}

function installSafeBindingMethods(logger: pino.Logger): void {
  const child = logger.child;
  logger.child = function safeChild<ChildCustomLevels extends string = never>(
    this: pino.Logger,
    bindings: pino.Bindings,
    options?: pino.ChildLoggerOptions<ChildCustomLevels>,
  ): pino.Logger<ChildCustomLevels> {
    const safeBindings = sanitizeStructured(bindings) as pino.Bindings;
    return Reflect.apply(child, this, [safeBindings, options]) as pino.Logger<ChildCustomLevels>;
  };

  const setBindings = logger.setBindings;
  logger.setBindings = function safeSetBindings(this: pino.Logger, bindings: pino.Bindings): void {
    setBindings.call(this, sanitizeStructured(bindings) as pino.Bindings);
  };
}

export function createLogger(
  level: pino.LevelWithSilent,
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: {
      paths: [...REDACTION_PATHS],
      censor: REDACTED,
    },
    hooks: {
      logMethod(args, method) {
        const safeArgs = args.map((argument) =>
          sanitizeStructured(argument),
        ) as Parameters<pino.LogFn>;
        method.apply(this, safeArgs);
      },
    },
  };
  const logger = destination === undefined ? pino(options) : pino(options, destination);
  installSafeBindingMethods(logger);
  return logger;
}

export function createRequestLogger(logger: pino.Logger, requestId: string): pino.Logger {
  return logger.child({ requestId });
}
