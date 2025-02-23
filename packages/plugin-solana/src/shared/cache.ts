import { ICacheManager, CacheOptions } from "@elizaos/core";
import { IDatabaseAdapter } from "@elizaos/core";

export class DatabaseCacheManager implements ICacheManager {
    constructor(private adapter: IDatabaseAdapter) {}

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const result = await this.adapter.db.query(
            "SELECT value FROM cache WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())",
            [key]
        );

        if (!result[0]) return undefined;

        try {
            return JSON.parse(result[0].value);
        } catch {
            return undefined;
        }
    }

    async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
        const expiresAt = options?.expires ? new Date(Date.now() + options.expires) : null;
        
        await this.adapter.db.query(
            `INSERT INTO cache (key, value, expires_at) 
             VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE 
             SET value = $2, expires_at = $3`,
            [key, JSON.stringify(value), expiresAt]
        );
    }

    async delete(key: string): Promise<void> {
        await this.adapter.db.query(
            "DELETE FROM cache WHERE key = $1",
            [key]
        );
    }
} 