// packages/plugin-solana/src/shared/memory/BaseMemoryManager.ts

import {
    AgentType,
    AgentState,
    AgentCapability,
    AgentMessage,
    BaseContent,
    CharacterName,
    DAOEventType,
    DAOEvent,
    Transaction,
    REQUIRED_MEMORY_TYPES,
    UNIQUE_MEMORY_TYPES,
    isUniqueMemoryType,
    isVersionedMemoryType,
    MemoryMetadata
} from "../types/base.ts";
import { UUID, IAgentRuntime, elizaLogger, stringToUuid, ServiceType, Service, IMemoryManager } from "@elizaos/core";
import { Memory, MemorySubscription } from "../types/memory-types.ts";
import { MemoryQueryOptions } from "../types/memory.ts";
import { MessageBroker } from "../MessageBroker.ts";
import { MemoryEvent } from "../types/memory-events.ts";
import { EmbeddingService } from "../services/EmbeddingService.ts";
import * as Database from "better-sqlite3";
import { EventEmitter } from "events";
import { getMemoryRoom } from "../constants.ts";
import { MemorySyncManager } from "./MemorySyncManager.ts";

export interface PaginatedResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor?: UUID;
    lastTimestamp?: number;
}

export interface PaginationOptions {
    // Primary pagination method (only one should be used)
    cursor?: UUID;        // For cursor-based pagination (preferred)
    timestamp?: number;   // For time-based filtering (for real-time updates)
    
    // Required parameters
    limit: number;        // Required number of items per page
    
    // Optional filters
    startTime?: number;   // Filter items after this timestamp
    endTime?: number;     // Filter items before this timestamp
    
    // Deprecated - will be removed
    offset?: number;      // Legacy offset-based pagination
}

export interface MemoryManagerOptions {
    useEmbeddings?: boolean;
    tableName: string;
}

// Add version control interfaces
interface VersionedMemory extends Memory {
    version: number;
    latestVersion?: number;
}

export interface VersionHistory {
    id: UUID;
    version: number;
    content: BaseContent;
    createdAt: number;
    reason?: string;
}

/**
 * Abstract base class for memory management implementations.
 * Provides common functionality and defines the contract for concrete implementations.
 */
export abstract class BaseMemoryManager implements IMemoryManager {
    public runtime: IAgentRuntime;
    protected _tableName: string;
    protected readonly DEFAULT_PAGE_SIZE = 50;
    protected readonly MAX_PAGE_SIZE = 100;
    protected useEmbeddings: boolean;
    protected _isInTransaction: boolean = false;
    protected transactionLevel: number = 0;
    protected savepointCounter: number = 0;
    protected messageBroker: MessageBroker;
    protected memorySyncManager: MemorySyncManager;
    protected memorySubscriptions: Map<string, Set<MemorySubscription["callback"]>>;
    protected embeddingService: EmbeddingService;
    protected lastSyncTimestamp: number = 0;

    constructor(runtime: IAgentRuntime, options: MemoryManagerOptions) {
        this.runtime = runtime;
        this._tableName = options.tableName;
        this.useEmbeddings = options.useEmbeddings ?? false;
        this.messageBroker = MessageBroker.getInstance();
        this.memorySyncManager = MemorySyncManager.getInstance();
        this.memorySubscriptions = new Map();
        this.embeddingService = EmbeddingService.getInstance(runtime, {
            enabled: options.useEmbeddings
        });
        this.setupCrossProcessEvents();
        this.setupMemorySyncHandlers();
        this.lastSyncTimestamp = Date.now();
    }

    private setupCrossProcessEvents(): void {
        this.messageBroker.subscribe("memory_created", async (event: MemoryEvent) => {
            if (event.agentId !== this.runtime.agentId) {
                await this.notifySubscribers(event);
            }
        });

        this.messageBroker.subscribe("memory_updated", async (event: MemoryEvent) => {
            if (event.agentId !== this.runtime.agentId) {
                await this.notifySubscribers(event);
            }
        });
    }

    private setupMemorySyncHandlers(): void {
        // Listen for memory sync events
        this.memorySyncManager.onMemorySynced(async (memory: Memory) => {
            // Notify subscribers
            const subscribers = this.memorySubscriptions.get((memory.content as BaseContent).type);
            if (subscribers) {
                for (const callback of subscribers) {
                    try {
                        await callback(memory);
                    } catch (error) {
                        elizaLogger.error("Error in memory sync subscriber:", error);
                    }
                }
            }
        });

        this.memorySyncManager.onMemoryDeleted(async (memoryId: UUID) => {
            // Handle memory deletion
            elizaLogger.debug(`Memory ${memoryId} was deleted in another process`);
        });
    }

    private async notifySubscribers(event: MemoryEvent): Promise<void> {
        const subscribers = this.memorySubscriptions.get(event.content.type);
        if (!subscribers) return;

        const memory: Memory = {
            id: event.content.id,
            content: event.content,
            roomId: event.roomId,
            agentId: event.agentId,
            userId: event.agentId
        };

        for (const callback of subscribers) {
            try {
                await callback(memory);
            } catch (error) {
                elizaLogger.error("Error in memory subscriber callback:", error);
            }
        }
    }

    protected async broadcastMemoryChange(event: MemoryEvent): Promise<void> {
        await this.messageBroker.broadcast(event);
    }

    get tableName(): string {
        return this._tableName;
    }

    get isInTransaction(): boolean {
        return this._isInTransaction;
    }

    /**
     * Centralized uniqueness check for memory creation
     */
    protected async validateAndPrepareMemory(memory: Memory, unique?: boolean): Promise<Memory> {
        const content = memory.content as BaseContent;

        // If memory type should be unique, validate uniqueness constraints
        if (isUniqueMemoryType(content.type)) {
            // If ID is provided, respect it - otherwise generate one
            if (!content.id) {
                content.id = stringToUuid(`${content.type}-${Date.now().toString()}`);
            }

            // Check uniqueness constraints
            const exists = await this.checkUniqueness(memory);
            if (exists) {
                throw new Error(`Memory of type ${content.type} with constraints already exists`);
            }
        } else if (!content.id) {
            // For non-unique types, always generate new ID
            content.id = stringToUuid(`${content.type}-${Date.now().toString()}`);
        }

        // Handle versioning if needed
        if (isVersionedMemoryType(content.type) && content.id) {
            const previousVersions = await this.getMemories({
                roomId: memory.roomId,
                count: 1
            });
            
            const previousVersion = previousVersions.find(m => 
                (m.content as BaseContent).type === content.type && 
                (m.content as BaseContent).id === content.id
            );

            if (previousVersion) {
                const prevContent = previousVersion.content as BaseContent;
                const prevMetadata = prevContent.metadata as MemoryMetadata || {};
                const currentMetadata = content.metadata as MemoryMetadata || {};

                content.metadata = {
                    ...currentMetadata,
                    version: (prevMetadata.version || 0) + 1,
                    previousVersion: prevMetadata.version,
                    versionTimestamp: Date.now(),
                    versionReason: currentMetadata.versionReason || 'Update'
                };
            }
        }

        return {
            ...memory,
            content
        };
    }

    /**
     * Abstract method for uniqueness checking - must be implemented by concrete classes
     */
    protected abstract checkUniqueness(memory: Memory): Promise<boolean>;

    /**
     * Checks and enforces uniqueness constraints for a memory
     * This is the single source of truth for memory uniqueness
     */
    protected async checkAndEnforceUnique(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        const typeConfig = UNIQUE_MEMORY_TYPES[content.type];
        
        // If no uniqueness config exists for this type, allow creation
        if (!typeConfig) return;

        // Build query conditions based on uniqueness fields
        const conditions = typeConfig.uniqueBy.map(field => {
            const [parent, child] = field.split('.');
            if (child) {
                // Handle nested fields (e.g., metadata.proposalId)
                return {
                    [`content.${parent}.${child}`]: content[parent]?.[child]
                };
            }
            return {
                [`content.${field}`]: content[field]
            };
        });

        // Combine conditions for query
        const query = {
            type: content.type,
            roomId: memory.roomId,
            $and: conditions
        };

        // Check for existing memories matching uniqueness criteria
        const existing = await this.getMemoriesWithFilter({
            roomId: memory.roomId,
            filter: query,
            count: 1
        });

        if (existing.length > 0) {
            const existingId = existing[0].id;
            throw new Error(
                `Memory of type '${content.type}' with matching unique fields already exists ` +
                `(id: ${existingId}). Uniqueness enforced on: ${typeConfig.uniqueBy.join(', ')}`
            );
        }
    }

    /**
     * Pre-create hook for memory validation and processing
     */
    protected async preCreateHook(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        
        // Validate required fields
        if (!content.type || !content.text) {
            throw new Error('Memory content must have type and text fields');
        }

        // Enforce uniqueness constraints
        await this.checkAndEnforceUnique(memory);

        // Add timestamps if not present
        const now = Date.now();
        if (!content.createdAt) content.createdAt = now;
        if (!content.updatedAt) content.updatedAt = now;
    }

    /**
     * Creates a memory with proper validation and uniqueness checks
     */
    async createMemory(memory: Memory, unique?: boolean): Promise<void> {
        await this.createMemoryInternal(memory, unique);
        
        // Let derived classes handle event emission through processMemory
        await this.processMemory(memory);
    }

    /**
     * Internal method to be implemented by concrete classes for actual memory creation
     */
    protected abstract createMemoryInternal(memory: Memory, unique?: boolean): Promise<void>;

    /**
     * Helper method to create a memory with proper IDs
     */
    protected createMemoryWithIds(
        content: any,
        options: {
            /** Override the default room ID (defaults to agent's room) */
            roomId?: UUID;
            /** Override the default user ID (defaults to agent ID) */
            userId?: UUID;
            /** Whether this memory belongs to a specific room vs the agent's room */
            isRoomSpecific?: boolean;
            /** Whether this memory should be unique */
            unique?: boolean;
        } = {}
    ): Memory {
        // Get the correct room based on memory type
        const effectiveRoomId = getMemoryRoom(content.type, this.runtime.agentId);

        return {
            id: content.id,
            roomId: effectiveRoomId,
            // User ID can be overridden, but defaults to agent ID
            userId: options.userId || this.runtime.agentId,
            // Agent ID is always the creator's ID
            agentId: this.runtime.agentId,
            content
        };
    }

    /**
     * Helper method to determine if a memory belongs to the agent's room
     */
    protected isAgentRoomMemory(memory: Memory): boolean {
        return memory.roomId === this.runtime.agentId;
    }

    /**
     * Retrieves memories with cursor-based pagination
     */
    async getMemoriesWithPagination(options: {
        roomId: UUID;
        limit?: number;
        cursor?: UUID;
        startTime?: number;
        endTime?: number;
    }): Promise<{
        items: Memory[];
        hasMore: boolean;
        nextCursor?: UUID;
    }> {
        const {
            roomId,
            limit = this.DEFAULT_PAGE_SIZE,
            startTime,
            endTime
        } = options;

        // Enforce pagination limits
        const pageSize = Math.min(limit, this.MAX_PAGE_SIZE);

        // Get one extra item to determine if there are more pages
        const memories = await this.runtime.databaseAdapter.getMemories({
            roomId,
            count: pageSize + 1,
            unique: true,
            start: startTime,
            end: endTime,
            tableName: this._tableName,
            agentId: this.runtime.agentId
        });

        // Check if we got an extra item (indicates there are more pages)
        const hasMore = memories.length > pageSize;
        const items = hasMore ? memories.slice(0, pageSize) : memories;

        // Get the cursor for the next page
        const nextCursor = hasMore ? items[items.length - 1].id : undefined;

        return {
            items,
            hasMore,
            nextCursor
        };
    }

    /**
     * Original getMemories method for backward compatibility
     */
    async getMemories(opts: { roomId: UUID; count?: number; unique?: boolean; start?: number; end?: number; }): Promise<Memory[]> {
        const { items } = await this.getMemoriesWithPagination({
            roomId: opts.roomId,
            limit: opts.count || this.DEFAULT_PAGE_SIZE,
            startTime: opts.start,
            endTime: opts.end
        });
        return items;
    }

    /**
     * Internal method to be implemented by concrete classes for memory retrieval
     */
    protected abstract getMemoriesInternal(options: MemoryQueryOptions & {
        lastId?: UUID;
        timestamp?: number;
        offset?: number;
        limit?: number;
    }): Promise<Memory[]>;

    async beginTransaction(): Promise<void> {
        // If this is the very first transaction, mark isInTransaction = true
        // Otherwise, we'll rely on the transactionLevel to track nested savepoints
        this.transactionLevel++;
        if (this.transactionLevel === 1) {
            this._isInTransaction = true;
        }
        // Always call beginTransactionInternal so that derived classes (like PostgresMemoryManager)
        // can handle either a top-level BEGIN or a new SAVEPOINT.
        await this.beginTransactionInternal();
    }

    async commitTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            elizaLogger.warn("No active transaction to commit");
            return;
        }

        // Let the derived class do a COMMIT or RELEASE SAVEPOINT:
        await this.commitTransactionInternal();

        // If we've decremented back to zero, we're fully committed.
        this.transactionLevel--;
        if (this.transactionLevel <= 0) {
            this._isInTransaction = false;
            this.transactionLevel = 0;
        }
    }

    async rollbackTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            elizaLogger.warn("No active transaction to rollback");
            return;
        }

        // Let the derived class do a ROLLBACK or ROLLBACK TO SAVEPOINT:
        await this.rollbackTransactionInternal();

        // Decrement and check if we fully left a transaction
        this.transactionLevel--;
        if (this.transactionLevel <= 0) {
            this._isInTransaction = false;
            this.transactionLevel = 0;
        }
    }

    protected abstract beginTransactionInternal(): Promise<void>;
    protected abstract commitTransactionInternal(): Promise<void>;
    protected abstract rollbackTransactionInternal(): Promise<void>;

    abstract initialize(): Promise<void>;
    abstract getMemoryById(id: UUID): Promise<Memory | null>;
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        if (!memory.content.text) {
            return memory;
        }

        const embedding = await this.embeddingService.getEmbedding(memory.content.text);
        return embedding ? { ...memory, embedding } : memory;
    }
    abstract getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    abstract getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]>;
    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
            query?: string;  // Original query text for fallback
        }
    ): Promise<Memory[]> {
        if (!this.embeddingService.isEnabled()) {
            elizaLogger.info("Embeddings disabled, falling back to text search");
            return this.searchMemoriesByText(opts.roomId, (memory) => {
                // Simple text similarity fallback
                const similarity = this.calculateTextSimilarity(
                    memory.content.text || "",
                    opts.query || ""
                );
                return similarity >= (opts.match_threshold || 0.5);
            }, opts.count);
        }

        return this.searchMemoriesByEmbeddingInternal(embedding, opts);
    }
    abstract removeMemory(id: UUID): Promise<void>;
    abstract removeAllMemories(roomId: UUID): Promise<void>;
    abstract countMemories(roomId: UUID, unique?: boolean): Promise<number>;
    abstract shutdown(): Promise<void>;

    public subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
    }

    public unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
    }

    protected abstract searchMemoriesByEmbeddingInternal(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
            query?: string;
        }
    ): Promise<Memory[]>;

    protected abstract searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]>;

    private calculateTextSimilarity(text1: string, text2: string): number {
        // Simple Jaccard similarity as fallback
        const words1 = new Set(text1.toLowerCase().split(/\s+/));
        const words2 = new Set(text2.toLowerCase().split(/\s+/));
        
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        
        return intersection.size / union.size;
    }

    /**
     * Syncs domain memory by fetching all relevant records since last sync
     */
    public async resyncDomainMemory(): Promise<void> {
        const memories = await this.getMemoriesInternal({
            domain: this.runtime.agentId,
            timestamp: this.lastSyncTimestamp,
            types: Object.values(REQUIRED_MEMORY_TYPES).flat()
        });

        for (const memory of memories) {
            await this.processMemory(memory);
        }

        this.lastSyncTimestamp = Date.now();
    }

    /**
     * Process a single memory for sync
     */
    protected async processMemory(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        
        // Single point of event emission
        await this.broadcastMemoryChange({
            type: "memory_created",
            content,
            roomId: memory.roomId,
            agentId: this.runtime.agentId,
            timestamp: Date.now()
        });

        // Also emit content-type specific event for subscribers
        if (content.type) {
            await this.notifySubscribers({
                type: content.type,
                content,
                roomId: memory.roomId,
                agentId: this.runtime.agentId,
                timestamp: Date.now()
            });
        }
    }

    async getMemory(id: UUID): Promise<Memory | null> {
        // First check recent memories from sync manager
        const recentMemory = this.memorySyncManager.getRecentMemory(id);
        if (recentMemory) {
            return recentMemory;
        }

        // If not found in recent memories, check database
        return this.getMemoryInternal(id);
    }

    protected abstract getMemoryInternal(id: UUID): Promise<Memory | null>;
    protected abstract updateMemoryInternal(memory: Memory): Promise<void>;
    protected abstract removeMemoryInternal(id: UUID): Promise<void>;

    /**
     * Retrieve a single memory row with a row-level lock (FOR UPDATE).
     * Must be overridden by concrete implementations if lock-based concurrency is required.
     * @param id The UUID of the memory to retrieve and lock
     * @returns The memory object with a lock, or null if not found
     * @throws Error if not implemented by concrete class
     */
    public async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        throw new Error("getMemoryWithLock not implemented in BaseMemoryManager");
    }

    /**
     * Retrieve multiple memories with row-level locks (FOR UPDATE).
     * Must be overridden by concrete implementations if lock-based concurrency is required.
     * @param options Query options including roomId, count, and optional filter
     * @returns Array of memory objects with locks
     * @throws Error if not implemented by concrete class
     */
    public async getMemoriesWithLock(options: {
        roomId: UUID;
        count: number;
        filter?: Record<string, any>;
    }): Promise<Memory[]> {
        throw new Error("getMemoriesWithLock not implemented in BaseMemoryManager");
    }

    /**
     * Gets the latest version of a memory with row-level locking
     */
    protected async getLatestVersionWithLock(id: UUID): Promise<VersionedMemory | null> {
        if (!this.isInTransaction) {
            throw new Error("getLatestVersionWithLock must be called within a transaction");
        }

        const memory = await this.getMemoryWithLock(id);
        if (!memory) return null;

        const content = memory.content as BaseContent;
        return {
            ...memory,
            version: (content.metadata?.version as number) || 1,
            latestVersion: (content.metadata?.latestVersion as number) || 1
        };
    }

    /**
     * Creates a new version of a memory while maintaining proper version control
     */
    protected async createNewVersion(
        currentMemory: VersionedMemory,
        updates: Partial<BaseContent>,
        reason?: string
    ): Promise<void> {
        if (!this.isInTransaction) {
            throw new Error("createNewVersion must be called within a transaction");
        }

        const content = currentMemory.content as BaseContent;
        const newVersion = (currentMemory.latestVersion || 1) + 1;

        // First store the current version in history
        await this.storeVersionHistory({
            id: currentMemory.id,
            version: currentMemory.version,
            content: content,
            createdAt: content.createdAt,
            reason: reason || 'Update'
        });

        // Then update the main record with new version
        const updatedContent: BaseContent = {
            ...content,
            ...updates,
            metadata: {
                ...content.metadata,
                version: newVersion,
                latestVersion: newVersion,
                versionTimestamp: Date.now(),
                versionReason: reason
            },
            updatedAt: Date.now()
        };

        await this.updateMemoryInternal({
            ...currentMemory,
            content: updatedContent
        });
    }

    /**
     * Stores a version in the history table
     */
    protected abstract storeVersionHistory(version: VersionHistory): Promise<void>;

    /**
     * Gets all versions of a memory
     */
    public abstract getMemoryVersions(id: UUID): Promise<Memory[]>;

    /**
     * Gets a specific version of a memory
     */
    public abstract getMemoryVersion(id: UUID, version: number): Promise<Memory | null>;

    public async updateMemory(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        if (!content || !content.type || typeof content.type !== 'string') {
            throw new Error("Invalid memory content");
        }

        await this.beginTransaction();
        try {
            // First validate and prepare the memory
            const preparedMemory = await this.validateAndPrepareMemory(memory);
            const preparedContent = preparedMemory.content as BaseContent;
            
            // Perform the update
            await this.updateMemoryInternal(preparedMemory);
            
            // Broadcast the update event
            await this.broadcastMemoryChange({
                type: "memory_updated",
                content: preparedContent,
                roomId: preparedMemory.roomId,
                agentId: this.runtime.agentId,
                timestamp: Date.now(),
                memory: preparedMemory
            });

            // Also emit content-type specific event for subscribers
            await this.notifySubscribers({
                type: preparedContent.type,
                content: preparedContent,
                roomId: preparedMemory.roomId,
                agentId: this.runtime.agentId,
                timestamp: Date.now(),
                memory: preparedMemory
            });

            await this.commitTransaction();
        } catch (error) {
            await this.rollbackTransaction();
            throw error;
        }
    }

    /**
     * Helper method to get memories with complex filtering
     */
    protected async getMemoriesWithFilter(options: {
        roomId: UUID;
        filter?: Record<string, unknown>;
        count?: number;
    }): Promise<Memory[]> {
        const { roomId, filter, count = 100 } = options;
        
        // Start with base query
        let query = `
            SELECT * FROM ${this.tableName}
            WHERE room_id = $1
        `;
        const params: any[] = [roomId];
        let paramIndex = 2;

        // Add filter conditions if present
        if (filter) {
            if (filter.type) {
                query += ` AND content->>'type' = $${paramIndex}`;
                params.push(filter.type);
                paramIndex++;
            }

            // Handle nested content fields
            Object.entries(filter).forEach(([key, value]) => {
                if (key === 'type') return; // Already handled
                
                if (key.includes('.')) {
                    const [parent, child] = key.split('.');
                    query += ` AND content->'${parent}'->>'${child}' = $${paramIndex}`;
                    params.push(value);
                    paramIndex++;
                } else {
                    query += ` AND content->>'${key}' = $${paramIndex}`;
                    params.push(value);
                    paramIndex++;
                }
            });

            // Handle special operators like $and
            if (filter.$and && Array.isArray(filter.$and)) {
                filter.$and.forEach((condition: Record<string, unknown>) => {
                    Object.entries(condition).forEach(([key, value]) => {
                        if (key.includes('.')) {
                            const [parent, child] = key.split('.');
                            query += ` AND content->'${parent}'->>'${child}' = $${paramIndex}`;
                        } else {
                            query += ` AND content->>'${key}' = $${paramIndex}`;
                        }
                        params.push(value);
                        paramIndex++;
                    });
                });
            }
        }

        // Add limit
        query += ` LIMIT $${paramIndex}`;
        params.push(count);

        const result = await this.runtime.databaseAdapter.query(query, params);
        return result.rows.map(row => ({
            id: row.id,
            content: row.content,
            roomId: row.room_id,
            userId: row.user_id,
            agentId: row.agent_id,
            embedding: row.embedding
        }));
    }
} 