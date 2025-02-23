import { elizaLogger, Memory, UUID } from "@elizaos/core";
import { MessageBroker } from "../MessageBroker.ts";
import { EventEmitter } from "events";

interface MemorySyncMessage {
    type: "memory_sync";
    operation: "create" | "update" | "delete";
    memory: Memory;
    timestamp: number;
    processId: number;
}

interface SyncedMemory extends Memory {
    syncTimestamp: number;
}

/**
 * Manages memory synchronization between processes
 * This ensures that ephemeral memory and conversation context
 * stay consistent across all processes
 */
export class MemorySyncManager extends EventEmitter {
    private static instance: MemorySyncManager;
    private messageBroker: MessageBroker;
    private lastSyncTimestamp: number = 0;
    private recentMemories: Map<string, SyncedMemory> = new Map();
    private memorySyncCallbacks: Set<(memory: Memory) => Promise<void>>;
    private memoryDeleteCallbacks: Set<(memoryId: string) => Promise<void>>;
    private readonly RECENT_MEMORY_TTL = 60000; // 1 minute

    private constructor() {
        super();
        this.messageBroker = MessageBroker.getInstance();
        this.memorySyncCallbacks = new Set();
        this.memoryDeleteCallbacks = new Set();
        this.setupProcessMessageHandler();
        this.startCleanupInterval();
    }

    public static getInstance(): MemorySyncManager {
        if (!MemorySyncManager.instance) {
            MemorySyncManager.instance = new MemorySyncManager();
        }
        return MemorySyncManager.instance;
    }

    private setupProcessMessageHandler(): void {
        if (process.send) {
            process.on("message", async (message: any) => {
                if (message.type === "memory_sync") {
                    await this.handleMemorySync(message);
                }
            });
        }
    }

    private async handleMemorySync(message: any): Promise<void> {
        try {
            const { operation, memory, timestamp, processId } = message;

            // Skip if this is our own message
            if (processId === process.pid) {
                return;
            }

            if (operation === "delete") {
                // Handle memory deletion
                this.recentMemories.delete(memory.id);
                await this.notifyMemoryDeleted(memory.id);
            } else {
                // Store in recent memories for both create and update
                this.recentMemories.set(memory.id, {
                    ...memory,
                    syncTimestamp: timestamp
                });

                // Notify subscribers with appropriate event
                if (operation === "update") {
                    await this.notifyMemoryUpdated(memory);
                } else {
                    await this.notifyMemorySynced(memory);
                }
            }
        } catch (error) {
            elizaLogger.error("Error handling memory sync message:", error);
        }
    }

    private startCleanupInterval(): void {
        setInterval(() => {
            const now = Date.now();
            for (const [id, memory] of this.recentMemories.entries()) {
                if (now - (memory as any).syncTimestamp > this.RECENT_MEMORY_TTL) {
                    this.recentMemories.delete(id);
                }
            }
        }, this.RECENT_MEMORY_TTL);
    }

    public getRecentMemory(id: string): Memory | undefined {
        return this.recentMemories.get(id);
    }

    public getAllRecentMemories(): Memory[] {
        return Array.from(this.recentMemories.values());
    }

    public onMemorySynced(callback: (memory: Memory) => Promise<void>): void {
        this.memorySyncCallbacks.add(callback);
    }

    public onMemoryDeleted(callback: (memoryId: string) => Promise<void>): void {
        this.memoryDeleteCallbacks.add(callback);
    }

    private async notifyMemorySynced(memory: Memory): Promise<void> {
        const errors: Error[] = [];
        
        // First emit the event
        this.emit("memory_synced", memory);

        // Then notify all subscribers
        for (const callback of this.memorySyncCallbacks) {
            try {
                await callback(memory);
            } catch (error) {
                errors.push(error as Error);
                elizaLogger.error("Error in memory sync callback:", error);
            }
        }

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying memory sync subscribers`);
        }
    }

    private async notifyMemoryDeleted(memoryId: string): Promise<void> {
        const errors: Error[] = [];
        
        // First emit the event
        this.emit("memory_deleted", memoryId);

        // Then notify all subscribers
        for (const callback of this.memoryDeleteCallbacks) {
            try {
                await callback(memoryId);
            } catch (error) {
                errors.push(error as Error);
                elizaLogger.error("Error in memory deletion callback:", error);
            }
        }

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying memory deletion subscribers`);
        }
    }

    private async notifyMemoryUpdated(memory: Memory): Promise<void> {
        const errors: Error[] = [];
        
        // First emit the event
        this.emit("memory_updated", memory);

        // Then notify all subscribers
        for (const callback of this.memorySyncCallbacks) {
            try {
                await callback(memory);
            } catch (error) {
                errors.push(error as Error);
                elizaLogger.error("Error in memory update callback:", error);
            }
        }

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying memory update subscribers`);
        }
    }

    public removeMemorySyncCallback(callback: (memory: Memory) => Promise<void>): void {
        this.memorySyncCallbacks.delete(callback);
    }

    public removeMemoryDeleteCallback(callback: (memoryId: string) => Promise<void>): void {
        this.memoryDeleteCallbacks.delete(callback);
    }

    public async syncMemory(message: MemorySyncMessage): Promise<void> {
        if (!process.send) return;

        try {
            // Send to other processes
            process.send(message);

            // Handle locally based on operation
            const { operation, memory } = message;
            
            if (operation === "delete") {
                this.recentMemories.delete(memory.id);
                await this.notifyMemoryDeleted(memory.id);
            } else {
                // Store in recent memories for both create and update
                this.recentMemories.set(memory.id, {
                    ...memory,
                    syncTimestamp: message.timestamp
                });

                // Notify subscribers with appropriate event
                if (operation === "update") {
                    await this.notifyMemoryUpdated(memory);
                } else {
                    await this.notifyMemorySynced(memory);
                }
            }
        } catch (error) {
            elizaLogger.error("Error syncing memory:", error);
            throw error;
        }
    }
} 