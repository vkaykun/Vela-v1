// packages/plugin-solana/src/shared/memory/index.ts

import { IAgentRuntime, Memory, UUID, IMemoryManager, elizaLogger } from "@elizaos/core";
import { BaseMemoryManager, VersionHistory } from "./BaseMemoryManager.ts";
import { MemoryQueryOptions } from "../types/memory.ts";

export * from "./SQLiteMemoryManager.ts";
export * from "./MemoryManagerFactory.ts";

// Re-export types from base
export { Transaction, BaseContent } from "../types/base.ts";

export class MemoryManager extends BaseMemoryManager {
    private adapter: any;
    protected _isInTransaction: boolean = false;
    protected transactionLevel: number = 0;
    protected memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>> = new Map();

    constructor(options: { runtime: IAgentRuntime; tableName: string; adapter: any }) {
        super(options.runtime, { tableName: options.tableName });
        this.adapter = options.adapter;
    }

    async initialize(): Promise<void> {
        // Skip adapter initialization since it's already initialized
        return Promise.resolve();
    }

    protected async createMemoryInternal(memory: Memory, unique?: boolean): Promise<void> {
        await this.adapter.createMemory(memory, unique);
    }

    protected async getMemoriesInternal(options: MemoryQueryOptions): Promise<Memory[]> {
        return this.adapter.getMemories(options);
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        return this.adapter.addEmbeddingToMemory(memory);
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        return this.adapter.getCachedEmbeddings(content);
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]> {
        return this.adapter.getMemoriesByRoomIds(params);
    }

    async searchMemoriesByEmbedding(embedding: number[], opts: { match_threshold?: number; count?: number; roomId: UUID; unique?: boolean }): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, opts);
    }

    async removeMemory(id: UUID): Promise<void> {
        await this.adapter.removeMemory(id);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.adapter.removeAllMemories(roomId);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.adapter.countMemories(roomId, unique);
    }

    async shutdown(): Promise<void> {
        await this.adapter.shutdown();
    }

    async beginTransaction(): Promise<void> {
        await this.adapter.beginTransaction();
    }

    async commitTransaction(): Promise<void> {
        await this.adapter.commitTransaction();
    }

    async rollbackTransaction(): Promise<void> {
        await this.adapter.rollbackTransaction();
    }

    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        // Implement uniqueness check logic here
        return false; // Placeholder return
    }

    protected async beginTransactionInternal(): Promise<void> {
        if (this.adapter.beginTransaction) {
            await this.adapter.beginTransaction();
            this._isInTransaction = true;
            this.transactionLevel++;
        }
    }

    protected async commitTransactionInternal(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No transaction in progress');
        }

        if (this.adapter.commitTransaction) {
            await this.adapter.commitTransaction();
            this.transactionLevel--;
            if (this.transactionLevel === 0) {
                this._isInTransaction = false;
            }
        }
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No transaction in progress');
        }

        if (this.adapter.rollbackTransaction) {
            await this.adapter.rollbackTransaction();
            this._isInTransaction = false;
            this.transactionLevel = 0;
        }
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
        // Implement embedding search logic here
        return []; // Placeholder return
    }

    protected async searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]> {
        // Implement text search logic here
        return []; // Placeholder return
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryInternal(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        await this.adapter.updateMemoryInternal(memory);
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.adapter.removeMemoryInternal(id);
    }

    protected async storeVersionHistory(version: VersionHistory): Promise<void> {
        await this.adapter.storeVersionHistory(version);
    }

    public async getMemoryVersions(id: UUID): Promise<Memory[]> {
        return this.adapter.getMemoryVersions(id);
    }

    public async getMemoryVersion(id: UUID, version: number): Promise<Memory | null> {
        return this.adapter.getMemoryVersion(id, version);
    }

    // Add on method
    on(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
    }

    // Add off method
    off(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
    }

    // Add emit method
    async emit(type: string, memory: Memory): Promise<void> {
        const subscribers = this.memorySubscriptions.get(type);
        if (subscribers) {
            for (const callback of subscribers) {
                try {
                    await callback(memory);
                } catch (error) {
                    elizaLogger.error(`Error in memory subscriber callback:`, error);
                }
            }
        }
    }

    // Add subscribe method
    subscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.on(type, callback);
    }

    // Add unsubscribe method
    unsubscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.off(type, callback);
    }
} 