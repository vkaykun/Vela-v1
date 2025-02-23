import { IMemoryManager, Memory, UUID, IAgentRuntime, ServiceType, Service, elizaLogger, stringToUuid } from "@elizaos/core";
import { MemoryQueryOptions } from "../types/memory.ts";
import * as Database from "better-sqlite3";
import { Transaction, BaseContent } from "../types/base.ts";
import { EventEmitter } from "events";
import { BaseMemoryManager, VersionHistory } from "./BaseMemoryManager.ts";
import { isUniqueMemoryType, UNIQUE_MEMORY_TYPES, isVersionedMemoryType } from "../types/base.ts";
import { MemoryEvent } from "../types/memory-events.ts";
import { MessageBroker } from "../MessageBroker.ts";

interface DBRow {
    id: string;
    content: string;
    room_id: string;
    user_id: string;
    agent_id: string;
    created_at: number;
    updated_at: number;
    embedding?: number[];
}

interface WriteQueueItem {
    operation: 'create' | 'update' | 'delete';
    data: any;
    priority: 'high' | 'normal' | 'low';
    immediate: boolean;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
}

interface UniqueMemoryFields {
    text: string;
    type: string;
    agentId: string;
    metadata?: Record<string, any>;
}

interface SQLiteRow {
    id: UUID;
    content: string;
    room_id: UUID;
    user_id: UUID;
    agent_id: UUID;
    created_at: number;
    updated_at: number;
    embedding?: number[];
}

class SQLiteTransaction implements Transaction {
    constructor(private db: Database.Database) {
        this.db.prepare('BEGIN IMMEDIATE').run();
    }

    async commit(): Promise<void> {
        try {
            this.db.prepare('COMMIT').run();
        } catch (error) {
            await this.rollback();
            throw error;
        }
    }

    async rollback(): Promise<void> {
        try {
            this.db.prepare('ROLLBACK').run();
        } catch (error) {
            throw error;
        }
    }
}

export class SQLiteMemoryManager extends BaseMemoryManager {
    private db: Database.Database;
    private writeQueue: WriteQueueItem[] = [];
    private isProcessingQueue: boolean = false;
    private writeInterval: NodeJS.Timeout | null = null;
    private readonly eventEmitter: EventEmitter;
    private busyTimeout: number = 5000;
    private readonly RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 100;
    private readonly WRITE_BATCH_SIZE = 50;
    private readonly WRITE_INTERVAL = 100;
    private currentTransaction: SQLiteTransaction | null = null;
    private queueProcessingPromise: Promise<void> = Promise.resolve();
    private currentTransactionId: string | null = null;

    constructor(connectionString: string, runtime: IAgentRuntime, tableName: string) {
        super(runtime, { 
            tableName,
            useEmbeddings: process.env.USE_EMBEDDINGS === 'true'
        });

        this.db = new Database.default(connectionString, {
            verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
            timeout: this.busyTimeout
        });

        this.eventEmitter = new EventEmitter();
        this.eventEmitter.setMaxListeners(100);

        // Configure SQLite for better cross-process consistency
        this.db.pragma('journal_mode = WAL');
        this.db.pragma(`busy_timeout = ${this.busyTimeout}`);
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = -2000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('temp_store = MEMORY');
        this.db.pragma('mmap_size = 268435456');
        
        // Additional settings for cross-process safety
        this.db.pragma('locking_mode = NORMAL');  // Ensure proper file locking
        this.db.pragma('shared_cache = OFF');     // Disable shared cache for process isolation
        this.db.pragma('wal_autocheckpoint = 1000'); // Checkpoint after 1000 pages
        
        // Start write queue processor
        this.startWriteQueueProcessor();
        
        // Start periodic WAL checkpoint
        this.startPeriodicCheckpoint();

        // Set up cross-process memory event handling
        this.setupMemoryEventHandling();
    }

    private setupMemoryEventHandling(): void {
        this.messageBroker.subscribe("memory_created", async (event: MemoryEvent) => {
            // Skip if this is our own event
            if (event.agentId === this.runtime.agentId) {
                return;
            }

            try {
                // Create memory object from event
                const memory: Memory = {
                    id: event.content.id,
                    content: event.content,
                    roomId: event.roomId,
                    userId: event.agentId,
                    agentId: this.runtime.agentId,
                    createdAt: event.timestamp
                };

                // Check if memory already exists locally
                const existing = await this.getMemoryById(memory.id);
                if (existing) {
                    elizaLogger.debug(`Memory ${memory.id} already exists locally, skipping insert`);
                    return;
                }

                // Perform local insert based on memory type
                if (isVersionedMemoryType(event.content.type)) {
                    // For versioned types, store in both tables
                    const version = event.content.metadata?.version || 1;
                    const versionReason = event.content.metadata?.versionReason || 'Initial version';
                    
                    // First store in versions table
                    const versionStmt = this.db.prepare(
                        `INSERT OR IGNORE INTO ${this.tableName}_versions 
                        (id, version, content, room_id, user_id, agent_id, created_at, updated_at, version_reason)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    );

                    await this.withRetry(() => 
                        versionStmt.run(
                            memory.content.id,
                            version,
                            JSON.stringify(memory.content),
                            memory.roomId,
                            memory.userId,
                            memory.agentId,
                            memory.content.createdAt,
                            memory.content.updatedAt,
                            versionReason
                        )
                    );

                    // Then update or insert latest version in main table
                    const mainStmt = this.db.prepare(
                        `INSERT OR IGNORE INTO ${this.tableName}
                        (id, content, room_id, user_id, agent_id, created_at, updated_at, embedding)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                    );

                    await this.withRetry(() => 
                        mainStmt.run(
                            memory.content.id,
                            JSON.stringify(memory.content),
                            memory.roomId,
                            memory.userId,
                            memory.agentId,
                            memory.content.createdAt,
                            memory.content.updatedAt,
                            null // No embedding for replicated memories
                        )
                    );
                } else {
                    // For non-versioned types, use appropriate insert strategy
                    const insertType = isUniqueMemoryType(event.content.type) ? 'OR IGNORE' : 'OR REPLACE';
                    const stmt = this.db.prepare(
                        `INSERT ${insertType} INTO ${this.tableName}
                        (id, content, room_id, user_id, agent_id, created_at, updated_at, embedding)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                    );

                    await this.withRetry(() => 
                        stmt.run(
                            memory.content.id,
                            JSON.stringify(memory.content),
                            memory.roomId,
                            memory.userId,
                            memory.agentId,
                            memory.content.createdAt,
                            memory.content.updatedAt,
                            null // No embedding for replicated memories
                        )
                    );
                }

                elizaLogger.debug(`Successfully replicated memory ${memory.id} from process ${event.agentId}`);
            } catch (error) {
                elizaLogger.error(`Error replicating memory from process ${event.agentId}:`, error);
            }
        });
    }

    private startWriteQueueProcessor(): void {
        this.writeInterval = setInterval(() => {
            this.processWriteQueue();
        }, this.WRITE_INTERVAL);

        // Add periodic queue flush for high priority items
        setInterval(() => {
            const hasHighPriority = this.writeQueue.some(item => item.priority === 'high');
            if (hasHighPriority) {
                this.processWriteQueue();
            }
        }, this.WRITE_INTERVAL / 2);
    }

    private async processWriteQueue(): Promise<void> {
        if (this.isProcessingQueue || this.writeQueue.length === 0) return;

        this.isProcessingQueue = true;
        
        try {
            // Process immediate writes first
            const immediateItems = this.writeQueue.filter(item => item.immediate);
            if (immediateItems.length > 0) {
                await this.processItems(immediateItems);
                this.writeQueue = this.writeQueue.filter(item => !item.immediate);
            }

            // Process high priority items next
            const highPriorityItems = this.writeQueue.filter(item => item.priority === 'high')
                .slice(0, this.WRITE_BATCH_SIZE);
            if (highPriorityItems.length > 0) {
                await this.processItems(highPriorityItems);
                this.writeQueue = this.writeQueue.filter(item => !highPriorityItems.includes(item));
            }

            // Process remaining items
            const normalItems = this.writeQueue.slice(0, this.WRITE_BATCH_SIZE);
            if (normalItems.length > 0) {
                await this.processItems(normalItems);
                this.writeQueue = this.writeQueue.slice(normalItems.length);
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    private async processItems(items: WriteQueueItem[]): Promise<void> {
        // Start a new transaction only if we're not already in one
        const needsTransaction = !this.isInTransaction;
        if (needsTransaction) {
            await this.beginTransactionInternal();
        }

        try {
            for (const item of items) {
                try {
                    let result;
                    switch (item.operation) {
                        case 'create':
                            result = await this.executeCreate(item.data);
                            item.resolve(result);
                            break;
                        case 'update':
                            result = await this.executeUpdate(item.data);
                            item.resolve(result);
                            break;
                        case 'delete':
                            result = await this.executeDelete(item.data);
                            item.resolve(result);
                            break;
                    }
                } catch (error) {
                    item.reject(error);
                }
            }

            // Only commit if we started our own transaction
            if (needsTransaction) {
                await this.commitTransactionInternal();
            }
        } catch (error) {
            elizaLogger.error('Error processing write queue:', error);
            // Reject all items in batch
            items.forEach(item => item.reject(error));
            // Only rollback if we started our own transaction
            if (needsTransaction) {
                await this.rollbackTransactionInternal();
            }
        }
    }

    private async executeCreate(data: Memory): Promise<void> {
        // First create a proper memory object using the helper
        const memory = await this.validateAndPrepareMemory(data);
        const content = memory.content as BaseContent;
        const isUniqueType = isUniqueMemoryType(content.type);

        // Add embedding if needed
        const memoryWithEmbedding = await this.addEmbeddingToMemory(memory);

        // Handle versioning if needed
        if (isVersionedMemoryType(content.type)) {
            // Store in versions table first
            const versionStmt = this.db.prepare(
                `INSERT INTO ${this.tableName}_versions
                (id, version, content, room_id, user_id, agent_id, created_at, updated_at, version_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );

            await this.withRetry(() => 
                versionStmt.run(
                    memory.content.id,
                    content.metadata?.version || 1,
                    JSON.stringify(memory.content),
                    memory.roomId,
                    memory.userId,
                    memory.agentId,
                    memory.content.createdAt || Date.now(),
                    memory.content.updatedAt || Date.now(),
                    content.metadata?.versionReason || 'Initial version'
                )
            );

            // Then store latest version in main table
            const mainStmt = this.db.prepare(
                `INSERT OR REPLACE INTO ${this.tableName}
                (id, content, room_id, user_id, agent_id, created_at, updated_at, embedding)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );

            await this.withRetry(() => 
                mainStmt.run(
                    memory.content.id,
                    JSON.stringify(memory.content),
                    memory.roomId,
                    memory.userId,
                    memory.agentId,
                    memory.content.createdAt,
                    memory.content.updatedAt,
                    memoryWithEmbedding.embedding
                )
            );

        } else {
            // For non-versioned types, use appropriate insert strategy
            // If it's a unique type and unique flag is true, use INSERT OR IGNORE
            // If it's a unique type and unique flag is false, use INSERT OR REPLACE
            // If it's not a unique type, always use INSERT OR REPLACE
            const insertType = isUniqueType && memory.unique ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
            
            const stmt = this.db.prepare(
                `${insertType} INTO ${this.tableName}
                (id, content, room_id, user_id, agent_id, created_at, updated_at, embedding)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );

            await this.withRetry(() => 
                stmt.run(
                    memory.content.id,
                    JSON.stringify(memory.content),
                    memory.roomId,
                    memory.userId,
                    memory.agentId,
                    memory.content.createdAt,
                    memory.content.updatedAt,
                    memoryWithEmbedding.embedding
                )
            );
        }
    }

    private async executeUpdate(data: { id: string; updates: Partial<Memory> }): Promise<void> {
        const stmt = this.db.prepare(
            `UPDATE ${this.tableName} 
             SET content = json_patch(content, ?),
                 updated_at = ?
             WHERE id = ?`
        );

        await this.withRetry(() =>
            stmt.run(
                JSON.stringify(data.updates),
                Date.now(),
                data.id
            )
        );
    }

    private async executeDelete(id: string): Promise<void> {
        const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        await this.withRetry(() => stmt.run(id));
    }

    async initialize(): Promise<void> {
        // Create main table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                room_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                embedding BLOB,
                chunk_text TEXT,
                chunk_start INTEGER,
                chunk_end INTEGER,
                chunk_source TEXT
            );

            CREATE TABLE IF NOT EXISTS ${this.tableName}_versions (
                id TEXT NOT NULL,
                version INTEGER NOT NULL,
                content TEXT NOT NULL,
                room_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                version_reason TEXT,
                PRIMARY KEY (id, version)
            );

            CREATE INDEX IF NOT EXISTS ${this.tableName}_room_id_idx ON ${this.tableName}(room_id);
            CREATE INDEX IF NOT EXISTS ${this.tableName}_embedding_idx ON ${this.tableName}(embedding) WHERE embedding IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ${this.tableName}_chunk_text_idx ON ${this.tableName}(chunk_text) WHERE chunk_text IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ${this.tableName}_versions_id_idx ON ${this.tableName}_versions(id);
            CREATE INDEX IF NOT EXISTS ${this.tableName}_versions_created_idx ON ${this.tableName}_versions(created_at);
        `);

        await this.initializeLockTable();
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // Skip embedding generation if not enabled
        if (!this.useEmbeddings || !memory.content.text) {
            return memory;
        }

        const service = this.runtime.getService(ServiceType.TEXT_GENERATION) as Service & { 
            getEmbeddingResponse(text: string): Promise<number[]> 
        };
        const embedding = await service?.getEmbeddingResponse(memory.content.text);
        return embedding ? { ...memory, embedding } : memory;
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        const stmt = this.db.prepare(
            `SELECT embedding, levenshtein(text, ?) as levenshtein_score 
             FROM ${this.tableName} 
             WHERE text = ?`
        );
        const rows = stmt.all(content, content);
        return rows as { embedding: number[]; levenshtein_score: number; }[];
    }

    async startTransaction(): Promise<Transaction> {
        return new SQLiteTransaction(this.db);
    }

    private async withRetry<T>(operation: () => Promise<T> | T): Promise<T> {
        let lastError: Error | undefined;
        
        for (let attempt = 1; attempt <= this.RETRY_ATTEMPTS; attempt++) {
            try {
                const result = operation();
                return result instanceof Promise ? await result : result;
            } catch (error) {
                lastError = error as Error;
                if (error.message.includes('SQLITE_BUSY')) {
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * attempt));
                    continue;
                }
                throw error;
            }
        }
        
        throw lastError;
    }

    private extractUniqueFields(memory: Memory): UniqueMemoryFields {
        const content = memory.content as BaseContent & {
            text?: string;
            type: string;
            agentId: string;
            metadata?: Record<string, any>;
        };

        return {
            text: content.text || '',
            type: content.type,
            agentId: content.agentId,
            metadata: content.metadata
        };
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
            return false;
        } catch (error) {
            elizaLogger.error(`Error checking for duplicate memory:`, error);
            return false;
        }
    }

    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        const content = memory.content as BaseContent;
        
        if (!isUniqueMemoryType(content.type)) {
            return false;
        }

        const uniqueConstraints = UNIQUE_MEMORY_TYPES[content.type].uniqueBy;
        
        const conditions = uniqueConstraints.map((constraint, index) => {
            const [field, subfield] = constraint.split('.');
            if (subfield) {
                return `json_extract(content, '$.${field}.${subfield}') = ?`;
            }
            return `json_extract(content, '$.${field}') = ?`;
        });

        const query = `
            SELECT COUNT(*) as count 
            FROM ${this.tableName} 
            WHERE json_extract(content, '$.type') = ? 
            AND ${conditions.join(' AND ')}
        `;

        const params = [content.type];
        uniqueConstraints.forEach(constraint => {
            const [field, subfield] = constraint.split('.');
            const value = subfield ? 
                (content[field] as any)?.[subfield] : 
                content[field];
            params.push(value);
        });

        try {
            const result = this.db.prepare(query).get(...params) as { count: number };
            return result.count > 0;
        } catch (error) {
            elizaLogger.error(`Error checking uniqueness for memory type ${content.type}:`, error);
            throw error;
        }
    }

    async createMemory(memory: Memory, unique = false): Promise<void> {
        try {
            // Existing uniqueness check in code
            if (unique) {
                const exists = await this.checkUniqueness(memory);
                if (exists) {
                    throw new Error(`Memory of type ${memory.content.type} with id ${memory.content.id} already exists`);
                }
            }

            const query = `
                INSERT INTO ${this.tableName} (id, content, room_id, user_id, agent_id, created_at, embedding)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;

            await this.withRetry(() =>
                this.db.prepare(query).run(
                    memory.id,
                    JSON.stringify(memory.content),
                    memory.roomId,
                    memory.userId,
                    memory.agentId,
                    memory.createdAt,
                    memory.embedding
                )
            );
        } catch (error) {
            // Handle unique constraint violations
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                elizaLogger.warn(`Unique constraint violation for memory type ${memory.content.type}:`, {
                    error: error.message,
                    memory: {
                        id: memory.id,
                        type: memory.content.type,
                        content: memory.content
                    }
                });
                throw new Error(`Duplicate memory detected: ${error.message}`);
            }
            throw error;
        }
    }

    async getMemories(options: MemoryQueryOptions): Promise<Memory[]> {
        const stmt = this.db.prepare(`
            SELECT * FROM ${this.tableName} 
            WHERE room_id = ?
            ORDER BY created_at DESC
            ${options.count ? 'LIMIT ?' : ''}
        `);

        const params = options.count ? [options.domain, options.count] : [options.domain];
        const rows = await this.withRetry<DBRow[]>(() => {
            const result = stmt.all(...params);
            return result as DBRow[];
        });
        return rows.map(row => this.mapRowToMemory(row as DBRow));
    }

    private mapRowToMemory(row: DBRow): Memory {
        const parsedContent = JSON.parse(row.content);
        return {
            id: row.id as UUID,
            roomId: row.room_id as UUID,
            userId: row.user_id as UUID,
            agentId: row.agent_id as UUID,
            content: parsedContent,
            createdAt: row.created_at,
            embedding: row.embedding
        };
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        const row = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`).get(id) as DBRow | undefined;
        return row ? this.mapRowToMemory(row) : null;
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
        }
    ): Promise<Memory[]> {
        // Return empty array if embeddings are disabled
        if (!this.useEmbeddings) {
            elizaLogger.warn('Attempted to search by embedding while embeddings are disabled');
            return [];
        }

        // Register cosine similarity function if not exists
        this.db.function('cosine_similarity', (a: Buffer, b: Buffer) => {
            const vecA = new Float64Array(a.buffer);
            const vecB = new Float64Array(b.buffer);
            return this.calculateCosineSimilarity(Array.from(vecA), Array.from(vecB));
        });

        // Convert embedding to buffer
        const embeddingBuffer = Buffer.from(new Float64Array(embedding).buffer);
        
        const stmt = this.db.prepare(
            `SELECT *, cosine_similarity(embedding, ?) as similarity 
             FROM ${this.tableName} 
             WHERE room_id = ? 
             AND embedding IS NOT NULL
             HAVING similarity > ?
             ORDER BY similarity DESC
             LIMIT ?`
        );

        const rows = stmt.all(
            embeddingBuffer,
            opts.roomId,
            opts.match_threshold || 0.8,
            opts.count || 10
        ) as DBRow[];

        return rows.map(row => this.mapRowToMemory(row));
    }

    private calculateCosineSimilarity(vec1: number[], vec2: number[]): number {
        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }

        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]> {
        const placeholders = params.roomIds.map(() => '?').join(',');
        const query = `SELECT * FROM ${this.tableName} WHERE room_id IN (${placeholders})`;
        const stmt = this.db.prepare(query);
        
        // Execute query for each room ID separately to avoid array binding issues
        const allRows: DBRow[] = [];
        for (const roomId of params.roomIds) {
            const rows = stmt.all(roomId) as DBRow[];
            allRows.push(...rows);
        }

        // Apply limit after collecting all rows
        const limitedRows = params.limit ? allRows.slice(0, params.limit) : allRows;
        return limitedRows.map(row => this.mapRowToMemory(row));
    }

    async removeMemory(id: UUID): Promise<void> {
        this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(id);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        this.db.prepare(`DELETE FROM ${this.tableName} WHERE room_id = ?`).run(roomId);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        const query = unique
            ? `SELECT COUNT(DISTINCT content) as count FROM ${this.tableName} WHERE room_id = ?`
            : `SELECT COUNT(*) as count FROM ${this.tableName} WHERE room_id = ?`;
        const result = this.db.prepare(query).get(roomId) as { count: number };
        return result.count;
    }

    async shutdown(): Promise<void> {
        // Clear write interval
        if (this.writeInterval) {
            clearInterval(this.writeInterval);
        }

        // Process remaining items in queue
        await this.processWriteQueue();

        // Ensure WAL checkpoint is executed before closing
        this.db.pragma('wal_checkpoint(FULL)');
        await this.db.close();
    }

    protected async createMemoryInternal(memory: Memory, unique?: boolean): Promise<void> {
        const content = memory.content as BaseContent;
        const isHighPriority = this.isHighPriorityMemory(content);
        
        return new Promise((resolve, reject) => {
            this.writeQueue.push({
                operation: 'create',
                data: memory,
                priority: isHighPriority ? 'high' : 'normal',
                immediate: this.needsImmediateWrite(content),
                resolve,
                reject
            });

            // Process queue immediately for critical operations
            if (isHighPriority || this.needsImmediateWrite(content)) {
                this.processWriteQueue();
            }
        });
    }

    private isHighPriorityMemory(content: BaseContent): boolean {
        const highPriorityTypes = [
            'proposal',
            'strategy',
            'treasury_transaction',
            'vote',
            'strategy_execution'
        ];
        return highPriorityTypes.includes(content.type);
    }

    private needsImmediateWrite(content: BaseContent): boolean {
        const immediateTypes = [
            'proposal',
            'strategy',
            'treasury_transaction'
        ];
        return immediateTypes.includes(content.type) || 
               (content.metadata?.priority === 'high');
    }

    protected async getMemoriesInternal(options: MemoryQueryOptions & {
        lastId?: UUID;
        timestamp?: number;
        offset?: number;
        limit?: number;
    }): Promise<Memory[]> {
        const stmt = this.db.prepare(`
            SELECT * FROM ${this.tableName} 
            WHERE room_id = ?
            ${options.timestamp ? 'AND created_at > ?' : ''}
            ${options.lastId ? 'AND id > ?' : ''}
            ORDER BY created_at DESC
            ${options.limit ? 'LIMIT ?' : ''}
            ${options.offset ? 'OFFSET ?' : ''}
        `);

        const params: any[] = [options.domain];
        if (options.timestamp) params.push(options.timestamp);
        if (options.lastId) params.push(options.lastId);
        if (options.limit) params.push(options.limit);
        if (options.offset) params.push(options.offset);

        const rows = await this.withRetry<SQLiteRow[]>(() => {
            const result = stmt.all(...params);
            return result as unknown as SQLiteRow[];
        });
        return rows.map(row => ({
            id: row.id,
            roomId: row.room_id,
            userId: row.user_id,
            agentId: row.agent_id,
            content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
            embedding: row.embedding
        }));
    }

    protected async beginTransactionInternal(): Promise<void> {
        if (this.currentTransaction) {
            throw new Error('Transaction already in progress');
        }
        this.currentTransaction = new SQLiteTransaction(this.db);
        this.currentTransactionId = `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    protected async commitTransactionInternal(): Promise<void> {
        if (!this.currentTransaction) {
            throw new Error('No transaction in progress');
        }
        try {
            // Clean up locks for this transaction
            const cleanupStmt = this.db.prepare(`
                DELETE FROM memory_locks
                WHERE transaction_id = ?
            `);
            cleanupStmt.run(this.currentTransactionId);

            await this.currentTransaction.commit();
        } finally {
            this.currentTransaction = null;
            this.currentTransactionId = null;
        }
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        if (!this.currentTransaction) {
            throw new Error('No transaction in progress');
        }
        try {
            // Clean up locks for this transaction
            if (this.currentTransactionId) {
                const cleanupStmt = this.db.prepare(`
                    DELETE FROM memory_locks
                    WHERE transaction_id = ?
                `);
                cleanupStmt.run(this.currentTransactionId);
            }

            await this.currentTransaction.rollback();
        } finally {
            this.currentTransaction = null;
            this.currentTransactionId = null;
        }
    }

    /**
     * Simulate row-level locking in SQLite using transactions.
     * Note: SQLite doesn't support true row-level locks, so we use transactions
     * to provide isolation.
     */
    public async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        if (!this.isInTransaction) {
            throw new Error("getMemoryWithLock must be called within a transaction");
        }

        try {
            const stmt = this.db.prepare(`
                SELECT m.*, e.embedding 
                FROM ${this.tableName} m
                LEFT JOIN embeddings e ON m.id = e.memory_id
                WHERE m.id = ?
            `);
            
            const row = stmt.get(id) as DBRow | undefined;
            if (!row) {
                return null;
            }

            // Parse JSON content and embeddings
            const memory = this.mapRowToMemory(row);
            
            // Add a lock record to track this memory is being modified
            const lockStmt = this.db.prepare(`
                INSERT OR REPLACE INTO memory_locks (
                    memory_id,
                    locked_at,
                    locked_by,
                    transaction_id
                ) VALUES (?, ?, ?, ?)
            `);
            
            lockStmt.run(
                id,
                Date.now(),
                this.runtime.agentId,
                this.currentTransactionId
            );

            return memory;

        } catch (error) {
            elizaLogger.error(`Error in getMemoryWithLock for id ${id}:`, error);
            throw error;
        }
    }

    /**
     * Simulate row-level locking for multiple memories in SQLite using transactions.
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
                WHERE m.room_id = ?
            `;
            const params: any[] = [opts.roomId];

            // Add filter conditions if provided
            if (opts.filter) {
                for (const [key, value] of Object.entries(opts.filter)) {
                    if (key === 'type' && typeof value === 'string') {
                        query += ` AND json_extract(m.content, '$.type') = ?`;
                        params.push(value);
                    } else if (key === 'status' && typeof value === 'string') {
                        query += ` AND json_extract(m.content, '$.status') = ?`;
                        params.push(value);
                    } else if (key === 'agentId' && typeof value === 'string') {
                        query += ` AND json_extract(m.content, '$.agentId') = ?`;
                        params.push(value);
                    }
                }
            }

            query += `
                ORDER BY m.created_at DESC
                LIMIT ?
            `;
            params.push(opts.count);

            const stmt = this.db.prepare(query);
            const rows = stmt.all(...params) as DBRow[];

            // Add lock records for all retrieved memories
            const lockStmt = this.db.prepare(`
                INSERT OR REPLACE INTO memory_locks (
                    memory_id,
                    locked_at,
                    locked_by,
                    transaction_id
                ) VALUES (?, ?, ?, ?)
            `);

            const now = Date.now();
            for (const row of rows) {
                lockStmt.run(
                    row.id,
                    now,
                    this.runtime.agentId,
                    this.currentTransactionId
                );
            }

            return rows.map(row => this.mapRowToMemory(row));

        } catch (error) {
            elizaLogger.error(`Error in getMemoriesWithLock for room ${opts.roomId}:`, error);
            throw error;
        }
    }

    // Add helper method to initialize lock tracking table
    protected async initializeLockTable(): Promise<void> {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_locks (
                memory_id TEXT PRIMARY KEY,
                locked_at INTEGER NOT NULL,
                locked_by TEXT NOT NULL,
                transaction_id TEXT NOT NULL
            )
        `);
    }

    private startPeriodicCheckpoint(): void {
        // Checkpoint every 5 minutes
        setInterval(() => {
            try {
                this.db.pragma('wal_checkpoint(PASSIVE)');
            } catch (error) {
                elizaLogger.error('Error during WAL checkpoint:', error);
            }
        }, 300000);
    }

    async getMemoryVersions(id: UUID): Promise<Memory[]> {
        const query = `
            SELECT id, version, content, created_at
            FROM ${this.tableName}_versions
            WHERE id = ?
            ORDER BY version DESC
        `;
        
        const stmt = this.db.prepare(query);
        const rows = stmt.all(id) as Array<{
            id: string;
            version: number;
            content: string;
            created_at: number;
        }>;
        return rows.map(row => ({
            id: row.id as UUID,
            content: JSON.parse(row.content),
            roomId: JSON.parse(row.content).roomId,
            userId: JSON.parse(row.content).userId,
            agentId: JSON.parse(row.content).agentId,
            createdAt: row.created_at
        }));
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
        return this.searchMemoriesByEmbedding(embedding, opts);
    }

    protected async searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]> {
        const memories = await this.getMemories({ domain: roomId, count: limit });
        return memories.filter(predicate);
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.getMemoryById(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        const stmt = this.db.prepare(`
            UPDATE ${this.tableName}
            SET content = ?, updated_at = ?
            WHERE id = ?
        `);
        await stmt.run(JSON.stringify(memory.content), Date.now(), memory.id);
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.removeMemory(id);
    }

    protected async storeVersionHistory(version: VersionHistory): Promise<void> {
        const stmt = this.db.prepare(`
            INSERT INTO ${this.tableName}_versions (id, version, content, created_at)
            VALUES (?, ?, ?, ?)
        `);
        await stmt.run(version.id, version.version, JSON.stringify(version.content), version.createdAt);
    }

    public async getMemoryVersion(id: UUID, version: number): Promise<Memory | null> {
        const stmt = this.db.prepare(`
            SELECT * FROM ${this.tableName}_versions
            WHERE id = ? AND version = ?
        `);
        const row = stmt.get(id, version) as DBRow | undefined;
        return row ? this.mapRowToMemory(row) : null;
    }
}