// packages/plugin-solana/src/shared/memory/PostgresMemoryManager.ts

import { IAgentRuntime, Memory, UUID, elizaLogger } from "@elizaos/core";
import { BaseMemoryManager, VersionHistory } from "./BaseMemoryManager.ts";
import { MemoryQueryOptions } from "../types/memory.ts";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { BaseContent, isUniqueMemoryType, isVersionedMemoryType, UNIQUE_MEMORY_TYPES } from "../types/base.ts";

/**
 * PostgreSQL implementation of the memory manager.
 * Handles all memory operations using a PostgreSQL database.
 */
export class PostgresMemoryManager extends BaseMemoryManager {
    private adapter: PostgresDatabaseAdapter;
    private currentTransaction: any | null = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private writeQueueLock = false;
    protected _isInTransaction = false;
    protected transactionLevel = 0;
    protected savepointCounter = 0;

    constructor(
        runtime: IAgentRuntime,
        connectionConfig: {
            connectionString: string;
            maxConnections?: number;
            idleTimeoutMillis?: number;
            ssl?: boolean;
        }
    ) {
        super(runtime, { tableName: "memories" });
        this.adapter = new PostgresDatabaseAdapter({
            ...connectionConfig,
            beginTransaction: async () => {
                await this.adapter.query('BEGIN');
            },
            commitTransaction: async () => {
                await this.adapter.query('COMMIT');
            },
            rollbackTransaction: async () => {
                await this.adapter.query('ROLLBACK');
            }
        });
    }

    get isInTransaction(): boolean {
        return this._isInTransaction;
    }

    get currentTransactionLevel(): number {
        return this.transactionLevel;
    }

    async initialize(): Promise<void> {
        await this.adapter.init();
        
        // Create memories table with all required columns and constraints
        await this.adapter.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id UUID PRIMARY KEY,
                content JSONB NOT NULL,
                room_id UUID NOT NULL,
                user_id UUID NOT NULL,
                agent_id UUID NOT NULL,
                unique BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                embedding FLOAT[]
            );

            -- Index for room-based queries (heavily used in getMemories)
            CREATE INDEX IF NOT EXISTS idx_memories_room_id 
            ON ${this.tableName}(room_id);

            -- Index for content type lookups (used in memory subscriptions)
            CREATE INDEX IF NOT EXISTS idx_memories_content_type 
            ON ${this.tableName}((content->>'type'));

            -- Index for timestamp-based queries
            CREATE INDEX IF NOT EXISTS idx_memories_created_at 
            ON ${this.tableName}(created_at DESC);

            -- Partial unique index for distributed locks
            CREATE UNIQUE INDEX IF NOT EXISTS idx_active_distributed_locks 
            ON ${this.tableName} ((content->>'key'))
            WHERE content->>'type' = 'distributed_lock' 
            AND content->>'lockState' = 'active';

            -- Composite index for room + type queries
            CREATE INDEX IF NOT EXISTS idx_memories_room_type 
            ON ${this.tableName}(room_id, (content->>'type'));

            -- Index for user-specific queries
            CREATE INDEX IF NOT EXISTS idx_memories_user_id 
            ON ${this.tableName}(user_id);

            -- Index for agent-specific queries
            CREATE INDEX IF NOT EXISTS idx_memories_agent_id 
            ON ${this.tableName}(agent_id);
        `);

        // Create versions table for versioned memory types
        await this.adapter.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName}_versions (
                id UUID NOT NULL,
                version INTEGER NOT NULL,
                content JSONB NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                version_reason TEXT,
                PRIMARY KEY (id, version),
                FOREIGN KEY (id) REFERENCES ${this.tableName}(id) ON DELETE CASCADE
            );

            -- Index for version history queries
            CREATE INDEX IF NOT EXISTS idx_memory_versions_id_version 
            ON ${this.tableName}_versions(id, version DESC);
        `);

        // Add triggers for automatic timestamp updates
        await this.adapter.query(`
            CREATE OR REPLACE FUNCTION update_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';

            DROP TRIGGER IF EXISTS update_memories_updated_at 
            ON ${this.tableName};

            CREATE TRIGGER update_memories_updated_at
            BEFORE UPDATE ON ${this.tableName}
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
        `);

        // Add row-level security if enabled
        if (process.env.ENABLE_RLS === 'true') {
            await this.adapter.query(`
                ALTER TABLE ${this.tableName} ENABLE ROW LEVEL SECURITY;
                
                -- Policy: Agents can only access memories in their rooms
                CREATE POLICY agent_room_access ON ${this.tableName}
                FOR ALL
                TO authenticated
                USING (
                    room_id = current_setting('app.current_room_id')::uuid
                    OR agent_id = current_setting('app.current_agent_id')::uuid
                );
            `);
        }

        elizaLogger.info(`Initialized PostgresMemoryManager tables and indexes`);
    }

    protected async beginTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            // Start a new top-level transaction
            this.currentTransaction = await this.adapter.query('BEGIN');
            this._isInTransaction = true;
        } else {
            // Create a savepoint for nested transaction
            const savepointName = `sp_${++this.savepointCounter}`;
            await this.adapter.query(`SAVEPOINT ${savepointName}`);
        }
        this.transactionLevel++;
    }

    protected async commitTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            throw new Error('No transaction in progress');
        }

        this.transactionLevel--;

        if (this.transactionLevel === 0) {
            // Commit the top-level transaction
            await this.adapter.query('COMMIT');
            this.currentTransaction = null;
            this._isInTransaction = false;
            this.savepointCounter = 0;
        } else {
            // Release the savepoint
            const savepointName = `sp_${this.savepointCounter--}`;
            await this.adapter.query(`RELEASE SAVEPOINT ${savepointName}`);
        }
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            throw new Error('No transaction in progress');
        }

        if (this.transactionLevel === 1) {
            // Rollback the entire transaction
            await this.adapter.query('ROLLBACK');
            this.currentTransaction = null;
            this._isInTransaction = false;
            this.savepointCounter = 0;
        } else {
            // Rollback to the last savepoint
            const savepointName = `sp_${this.savepointCounter--}`;
            await this.adapter.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        }
        this.transactionLevel--;
    }

    private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
        // If we're in a transaction, execute immediately
        if (this._isInTransaction) {
            return operation();
        }

        // Otherwise, queue the write
        await this.writeQueue;
        let resolve: () => void;
        const newPromise = new Promise<void>((r) => { resolve = r; });

        try {
            this.writeQueue = newPromise;
            const result = await operation();
            resolve!();
            return result;
        } catch (error) {
            resolve!();
            throw error;
        }
    }

    protected async createMemoryInternal(memory: Memory): Promise<void> {
        return this.enqueueWrite(async () => {
            try {
                // Run pre-create hook for validation and uniqueness checks
                await this.preCreateHook(memory);

                const content = memory.content as BaseContent;
                
                // Handle versioning if needed
                if (isVersionedMemoryType(content.type)) {
                    const version = content.metadata?.version || 1;
                    const versionReason = content.metadata?.versionReason || 'Initial version';

                    // First store in versions table
                    await this.adapter.query(
                        `INSERT INTO ${this.tableName}_versions 
                        (id, version, content, room_id, user_id, agent_id, created_at, updated_at, version_reason)
                        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), to_timestamp($8/1000.0), $9)`,
                        [
                            memory.id,
                            version,
                            JSON.stringify(content),
                            memory.roomId,
                            memory.userId,
                            memory.agentId,
                            memory.content.createdAt || Date.now(),
                            memory.content.updatedAt || Date.now(),
                            versionReason
                        ]
                    );
                }

                // Insert into main memories table
                await this.adapter.query(
                    `INSERT INTO ${this.tableName} 
                    (id, content, room_id, user_id, agent_id, created_at, updated_at, embedding)
                    VALUES ($1, $2, $3, $4, $5, to_timestamp($6/1000.0), to_timestamp($7/1000.0), $8)`,
                    [
                        memory.id,
                        JSON.stringify(content),
                        memory.roomId,
                        memory.userId,
                        memory.agentId,
                        memory.content.createdAt || Date.now(),
                        memory.content.updatedAt || Date.now(),
                        memory.embedding ? `[${memory.embedding.join(",")}]` : null
                    ]
                );

                elizaLogger.debug(`Created memory ${memory.id}`, {
                    type: content.type,
                    roomId: memory.roomId,
                    versioned: isVersionedMemoryType(content.type)
                });
            } catch (error) {
                elizaLogger.error(`Error creating memory:`, error);
                if (this.currentTransaction) {
                    await this.rollbackTransaction();
                }
                throw error;
            }
        });
    }

    private async checkDuplicate(memory: Memory): Promise<boolean> {
        try {
            // Check for exact content match if memory has an ID
            if (memory.id) {
                const existing = await this.getMemoryById(memory.id);
                if (existing) {
                    return true;
                }
            }

            // Check for content-based duplicates
            const query = `
                SELECT COUNT(*) as count 
                FROM ${this.tableName} 
                WHERE room_id = $1 
                AND content->>'type' = $2
                AND content->>'id' = $3
            `;

            const result = await this.adapter.query(query, [
                memory.roomId,
                memory.content.type,
                memory.content.id
            ]);

            return result.rows[0].count > 0;
        } catch (error) {
            elizaLogger.error(`Error checking for duplicate memory:`, error);
            return false;
        }
    }

    /**
     * Maps a database row to a Memory object
     */
    private mapRowToMemory(row: any): Memory {
        return {
            id: row.id,
            roomId: row.room_id,
            userId: row.user_id,
            agentId: row.agent_id,
            content: row.content,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined
        };
    }

    protected async getMemoriesInternal(options: MemoryQueryOptions & {
        lastId?: UUID;
        timestamp?: number;
        offset?: number;
        limit?: number;
    }): Promise<Memory[]> {
        const {
            domain,
            unique = false,
            count = this.DEFAULT_PAGE_SIZE,
            lastId,
            timestamp,
            offset,
            limit,
            types
        } = options;

        let query = `
            SELECT m.* 
            FROM ${this._tableName} m
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (domain) {
            query += ` AND m.room_id = $${paramIndex}`;
            params.push(domain);
            paramIndex++;
        }

        if (timestamp) {
            query += ` AND m.created_at > to_timestamp($${paramIndex})`;
            params.push(timestamp / 1000.0); // Convert to seconds for PostgreSQL
            paramIndex++;
        }

        if (types && types.length > 0) {
            query += ` AND m.content->>'type' = ANY($${paramIndex}::text[])`;
            params.push(types);
            paramIndex++;
        }

        if (lastId) {
            query += ` AND m.id > $${paramIndex}`;
            params.push(lastId);
            paramIndex++;
        }

        if (unique) {
            query += ` AND m.content->>'type' = ANY($${paramIndex}::text[])`;
            params.push(UNIQUE_MEMORY_TYPES);
            paramIndex++;
        }

        query += ` ORDER BY m.created_at DESC`;

        if (limit) {
            query += ` LIMIT $${paramIndex}`;
            params.push(limit);
            paramIndex++;
        }

        if (offset) {
            query += ` OFFSET $${paramIndex}`;
            params.push(offset);
        }

        const result = await this.adapter.query(query, params);
        return result.rows.map((row) => this.mapRowToMemory(row));
    }

    async getMemories(options: MemoryQueryOptions): Promise<Memory[]> {
        const { domain, ...rest } = options;
        return this.adapter.getMemories({
            ...rest,
            roomId: domain as UUID,
            tableName: this.tableName
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // The core adapter handles embeddings automatically
        return memory;
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        const memories = await this.adapter.searchMemoriesByEmbedding([], {
            tableName: this.tableName,
            match_threshold: 0.95
        });
        return memories.map(m => ({
            embedding: m.embedding || [],
            levenshtein_score: 1.0
        }));
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]> {
        const allMemories: Memory[] = [];
        for (const roomId of params.roomIds) {
            const memories = await this.adapter.getMemories({
                roomId,
                count: params.limit,
                tableName: this.tableName
            });
            allMemories.push(...memories);
        }
        return allMemories;
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: { 
            match_threshold?: number; 
            count?: number; 
            roomId: UUID; 
            unique?: boolean;
            lastId?: UUID;
            offset?: number;
        }
    ): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, {
            tableName: this.tableName,
            match_threshold: opts.match_threshold,
            count: opts.count,
            roomId: opts.roomId,
            unique: opts.unique
        });
    }

    async removeMemory(id: UUID): Promise<void> {
        return this.enqueueWrite(async () => {
            try {
                if (this.currentTransaction) {
                    await this.adapter.query(
                        `DELETE FROM ${this.tableName} WHERE id = $1`,
                        [id]
                    );
                } else {
                    await this.adapter.removeMemory(id, this.tableName);
                }
            } catch (error) {
                elizaLogger.error(`Error removing memory:`, error);
                if (this.currentTransaction) {
                    await this.rollbackTransaction();
                }
                throw error;
            }
        });
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        return this.enqueueWrite(async () => {
            await this.adapter.removeAllMemories(roomId, this.tableName);
        });
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.adapter.countMemories(roomId, unique, this.tableName);
    }

    async shutdown(): Promise<void> {
        // Wait for any pending writes to complete
        await this.writeQueue;
        await this.adapter.close();
    }

    protected async searchMemoriesByEmbeddingInternal(
        embedding: number[],
        opts: { 
            match_threshold?: number; 
            count?: number; 
            roomId: UUID; 
            unique?: boolean;
            query?: string;
        }
    ): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, {
            tableName: this.tableName,
            match_threshold: opts.match_threshold,
            count: opts.count,
            roomId: opts.roomId,
            unique: opts.unique
        });
    }

    protected async searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]> {
        const memories = await this.adapter.getMemories({
            roomId,
            count: limit,
            tableName: this.tableName
        });
        return memories.filter(predicate);
    }

    protected async storeVersionHistory(version: VersionHistory): Promise<void> {
        const query = `
            INSERT INTO ${this.tableName}_versions (
                id, version, content, created_at
            ) VALUES ($1, $2, $3, $4)
        `;
        
        await this.adapter.query(query, [
            version.id,
            version.version,
            JSON.stringify(version.content),
            version.createdAt
        ]);
    }

    public async getMemoryVersions(id: UUID): Promise<Memory[]> {
        const query = `
            SELECT id, version, content, created_at
            FROM ${this.tableName}_versions
            WHERE id = $1
            ORDER BY version DESC
        `;
        
        const result = await this.adapter.query(query, [id]);
        return result.rows.map(row => ({
            id: row.id,
            content: JSON.parse(row.content),
            roomId: JSON.parse(row.content).roomId,
            userId: JSON.parse(row.content).userId,
            agentId: JSON.parse(row.content).agentId
        }));
    }

    public async getMemoryVersion(id: UUID, version: number): Promise<Memory | null> {
        const query = `
            SELECT id, version, content, created_at
            FROM ${this.tableName}_versions
            WHERE id = $1 AND version = $2
        `;
        
        const result = await this.adapter.query(query, [id, version]);
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            id: row.id,
            content: JSON.parse(row.content),
            roomId: JSON.parse(row.content).roomId,
            userId: JSON.parse(row.content).userId,
            agentId: JSON.parse(row.content).agentId
        };
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        const query = `
            UPDATE ${this.tableName}
            SET content = $2, updated_at = $3
            WHERE id = $1
        `;
        
        await this.adapter.query(query, [
            memory.id,
            JSON.stringify(memory.content),
            Date.now()
        ]);
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.adapter.query(
            `DELETE FROM ${this.tableName} WHERE id = $1`,
            [id]
        );
    }

    /**
     * Retrieve a single memory with row-level locking using FOR UPDATE.
     * This ensures exclusive access to the row until the transaction is committed.
     */
    public async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        if (!this.isInTransaction) {
            throw new Error("getMemoryWithLock must be called within a transaction");
        }

        try {
            const result = await this.adapter.query(`
                SELECT m.*, e.embedding 
                FROM ${this.tableName} m
                LEFT JOIN embeddings e ON m.id = e.memory_id
                WHERE m.id = $1
                FOR UPDATE
            `, [id]);

            if (result.rows.length === 0) {
                return null;
            }

            return this.mapRowToMemory(result.rows[0]);
        } catch (error) {
            elizaLogger.error(`Error in getMemoryWithLock for id ${id}:`, error);
            throw error;
        }
    }

    /**
     * Retrieve multiple memories with row-level locking using FOR UPDATE.
     * Supports filtering and ordering by creation time.
     */
    public async getMemoriesWithLock(opts: {
        roomId: UUID;
        count: number;
        filter?: Record<string, any>;
    }): Promise<Memory[]> {
        if (!this.isInTransaction) {
            throw new Error("getMemoriesWithLock must be called within a transaction");
        }

        try {
            let query = `
                SELECT m.*, e.embedding 
                FROM ${this.tableName} m
                LEFT JOIN embeddings e ON m.id = e.memory_id
                WHERE m.room_id = $1
            `;
            const params: any[] = [opts.roomId];
            let paramIndex = 2;

            // Add filter conditions if provided
            if (opts.filter) {
                for (const [key, value] of Object.entries(opts.filter)) {
                    if (key === 'type' && typeof value === 'string') {
                        query += ` AND m.content->>'type' = $${paramIndex}`;
                        params.push(value);
                        paramIndex++;
                    } else if (key === 'status' && typeof value === 'string') {
                        query += ` AND m.content->>'status' = $${paramIndex}`;
                        params.push(value);
                        paramIndex++;
                    } else if (key === 'agentId' && typeof value === 'string') {
                        query += ` AND m.content->>'agentId' = $${paramIndex}`;
                        params.push(value);
                        paramIndex++;
                    }
                }
            }

            query += `
                ORDER BY m.created_at DESC
                LIMIT $${paramIndex}
                FOR UPDATE
            `;
            params.push(opts.count);

            const result = await this.adapter.query(query, params);
            return result.rows.map(row => this.mapRowToMemory(row));

        } catch (error) {
            elizaLogger.error(`Error in getMemoriesWithLock for room ${opts.roomId}:`, error);
            throw error;
        }
    }

    /**
     * Legacy method required by BaseMemoryManager - delegates to checkAndEnforceUnique
     */
    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        try {
            await this.checkAndEnforceUnique(memory);
            return false; // No existing memory found
        } catch (error) {
            if (error.message?.includes('already exists')) {
                return true; // Existing memory found
            }
            throw error; // Re-throw unexpected errors
        }
    }
} 