// packages/plugin-solana/src/shared/memory/ExtendedMemoryManager.ts

import { Memory, UUID, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { BaseContent, IMemoryManager, IExtendedMemoryManager } from "../types/base.ts";
import { MemoryEvent } from "../types/memory-events.ts";
import { MemorySyncManager } from "./MemorySyncManager";

export class ExtendedMemoryManager implements IExtendedMemoryManager {
    constructor(
        private coreManager: IMemoryManager,
        private memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>>,
        private memorySyncManager: MemorySyncManager
    ) {}

    // Implement standardized subscription methods
    public subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
        
        // Also subscribe to the core manager
        this.coreManager.subscribeToMemory(type, callback);
    }

    public unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
        
        // Also unsubscribe from the core manager
        this.coreManager.unsubscribeFromMemory(type, callback);
    }

    // Backward compatibility methods
    /** @deprecated Use subscribeToMemory instead */
    public on(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribeToMemory(type, callback);
    }

    /** @deprecated Use unsubscribeFromMemory instead */
    public off(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribeFromMemory(type, callback);
    }

    /** @deprecated Use subscribeToMemory instead */
    public subscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribeToMemory(type, callback);
    }

    /** @deprecated Use unsubscribeFromMemory instead */
    public unsubscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribeFromMemory(type, callback);
    }

    /** @deprecated Use broadcastMemoryChange instead */
    public async emit(type: string, memory: Memory): Promise<void> {
        const event: MemoryEvent = {
            type,
            content: memory.content as BaseContent,
            roomId: memory.roomId,
            agentId: memory.agentId,
            timestamp: Date.now(),
            memory
        };
        
        // Notify subscribers
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

    // Memory operations
    async createMemory(memory: Memory): Promise<void> {
        await this.coreManager.createMemory(memory);
        
        // Notify local subscribers
        await this.emit("memory_created", memory);
        
        if (memory.content && typeof memory.content.type === 'string') {
            await this.emit(memory.content.type, memory);
        }

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "create",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    async updateMemory(memory: Memory): Promise<void> {
        await this.coreManager.updateMemory(memory);
        
        // Notify local subscribers
        await this.emit("memory_updated", memory);
        
        if (memory.content && typeof memory.content.type === 'string') {
            await this.emit(memory.content.type, memory);
        }

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "update",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        const memory = await this.getMemoryById(memoryId);
        if (!memory) return;

        await this.coreManager.removeMemory(memoryId);
        
        // Notify local subscribers
        await this.emit("memory_deleted", memory);

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "delete",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    // Delegate core methods
    get runtime() { return this.coreManager.runtime; }
    get tableName() { return this.coreManager.tableName; }
    
    async initialize() { return this.coreManager.initialize(); }
    async shutdown() { return this.coreManager.shutdown(); }
    async addEmbeddingToMemory(memory: Memory) { return this.coreManager.addEmbeddingToMemory(memory); }
    async getMemories(opts: any) { return this.coreManager.getMemories(opts); }
    async getMemoriesWithPagination(opts: any) { return this.coreManager.getMemoriesWithPagination(opts); }
    async getCachedEmbeddings(content: string) { return this.coreManager.getCachedEmbeddings(content); }
    async getMemoryById(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemory(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemoriesByRoomIds(params: any) { return this.coreManager.getMemoriesByRoomIds(params); }
    async searchMemoriesByEmbedding(embedding: number[], opts: any) { return this.coreManager.searchMemoriesByEmbedding(embedding, opts); }
    async removeAllMemories(roomId: UUID) { return this.coreManager.removeAllMemories(roomId); }
    async countMemories(roomId: UUID, unique?: boolean) { return this.coreManager.countMemories(roomId, unique); }
    async beginTransaction() { return this.coreManager.beginTransaction(); }
    async commitTransaction() { return this.coreManager.commitTransaction(); }
    async rollbackTransaction() { return this.coreManager.rollbackTransaction(); }
    async resyncDomainMemory() { return this.coreManager.resyncDomainMemory(); }

    // Add missing methods
    isInTransaction(): boolean { return (this.coreManager as any).isInTransaction?.() ?? false; }
    getTransactionLevel(): number { return (this.coreManager as any).getTransactionLevel?.() ?? 0; }
    async getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]> {
        return this.coreManager.getMemories(options);
    }
    async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        return this.coreManager.getMemoryById(id);
    }
    async removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void> {
        // Basic implementation - can be enhanced later
        const memories = await this.coreManager.getMemories({ 
            roomId: this.runtime.agentId,
            count: 1000
        });
        for (const memory of memories) {
            if (memory.content.type === filter.type) {
                await this.coreManager.removeMemory(memory.id);
            }
        }
    }
} 