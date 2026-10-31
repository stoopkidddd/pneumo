export type Session = {
  deviceId: string;
  token: string;
  mk: Uint8Array<ArrayBuffer>;
  contentKey: CryptoKey;
};

const DATABASE_NAME = "pneumo";
const DATABASE_VERSION = 1;
const STORE_NAME = "session";
const SESSION_KEY = "current";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.addEventListener("success", () => resolve(request.result), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
  return promise;
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  transaction.addEventListener("complete", () => resolve(), { once: true });
  transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  return promise;
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME);
    }
  });

  const database = await requestResult(request);
  database.addEventListener("versionchange", () => database.close());
  return database;
}

export async function load(): Promise<Session | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = requestResult(transaction.objectStore(STORE_NAME).get(SESSION_KEY));
    const [session] = await Promise.all([value, transactionComplete(transaction)]);
    return (session as Session | undefined) ?? null;
  } finally {
    database.close();
  }
}

export async function save(session: Session): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(session, SESSION_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function clear(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(SESSION_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
