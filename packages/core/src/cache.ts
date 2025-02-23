import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import {
    type UUID,
    type ICacheManager,
    type CacheOptions,
    type IDatabaseCacheAdapter,
} from "./types.js";

const require = createRequire(import.meta.url);

export interface ICacheAdapter {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export class MemoryCacheAdapter implements ICacheAdapter {
    data: Map<string, string>;

    constructor(initalData?: Map<string, string>) {
        this.data = initalData ?? new Map<string, string>();
    }

    async get(key: string): Promise<string | undefined> {
        return this.data.get(key);
    }

    async set(key: string, value: string): Promise<void> {
        this.data.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.data.delete(key);
    }
}

export class FileCacheAdapter implements ICacheAdapter {
    constructor(private dataDir: string) {}

    async get(key: string): Promise<string | undefined> {
        try {
            return await readFile(resolve(this.dataDir, key), "utf8");
        } catch {
            return undefined;
        }
    }

    async set(key: string, value: string): Promise<void> {
        try {
            const filePath = resolve(this.dataDir, key);
            // Ensure the directory exists
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, value, "utf8");
        } catch (error) {
            console.error(error);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            const filePath = resolve(this.dataDir, key);
            await unlink(filePath);
        } catch {
            // Ignore errors if file doesn't exist
        }
    }
}

export class DbCacheAdapter implements ICacheAdapter {
    constructor(
        private db: IDatabaseCacheAdapter,
        private agentId: UUID
    ) {}

    async get(key: string): Promise<string | undefined> {
        return this.db.getCache({ agentId: this.agentId, key });
    }

    async set(key: string, value: string): Promise<void> {
        await this.db.setCache({ agentId: this.agentId, key, value });
    }

    async delete(key: string): Promise<void> {
        await this.db.deleteCache({ agentId: this.agentId, key });
    }
}

export class CacheManager<CacheAdapter extends ICacheAdapter = ICacheAdapter>
    implements ICacheManager
{
    adapter: CacheAdapter;

    constructor(adapter: CacheAdapter) {
        this.adapter = adapter;
    }

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const data = await this.adapter.get(key);

        if (data) {
            const { value, expires } = JSON.parse(data) as {
                value: T;
                expires: number;
            };

            if (!expires || expires > Date.now()) {
                return value;
            }

            this.adapter.delete(key).catch(() => {});
        }

        return undefined;
    }

    async set<T>(key: string, value: T, opts?: CacheOptions): Promise<void> {
        return this.adapter.set(
            key,
            JSON.stringify({ value, expires: opts?.expires ?? 0 })
        );
    }

    async delete(key: string): Promise<void> {
        return this.adapter.delete(key);
    }
}

export class CacheStore {
    private cache: Map<string, any>;
    private adapter: ICacheAdapter;

    constructor(adapter: ICacheAdapter) {
        this.cache = new Map();
        this.adapter = adapter;
    }

    async get<T>(key: string): Promise<T | undefined> {
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        const value = await this.adapter.get(key);
        if (value) {
            const parsed = JSON.parse(value);
            this.cache.set(key, parsed);
            return parsed;
        }

        return undefined;
    }

    async set<T>(key: string, value: T): Promise<void> {
        this.cache.set(key, value);
        await this.adapter.set(key, JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        this.cache.delete(key);
        await this.adapter.delete(key);
    }

    async clear(): Promise<void> {
        this.cache.clear();
    }
}
