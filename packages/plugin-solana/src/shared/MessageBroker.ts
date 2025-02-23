import { Memory, elizaLogger } from "@elizaos/core";
import { MemoryEvent } from "./types/memory-events.ts";
import { EventEmitter } from "events";

/**
 * MessageBroker is responsible for local event broadcasting.
 * Cross-process memory sync is handled by MemorySyncManager.
 */
export class MessageBroker extends EventEmitter {
    private static instance: MessageBroker;
    private subscribers: Map<string, Set<(event: MemoryEvent) => Promise<void>>>;

    private constructor() {
        super();
        this.subscribers = new Map();
    }

    public static getInstance(): MessageBroker {
        if (!MessageBroker.instance) {
            MessageBroker.instance = new MessageBroker();
        }
        return MessageBroker.instance;
    }

    public subscribe(type: string, callback: (event: MemoryEvent) => Promise<void>): void {
        if (!this.subscribers.has(type)) {
            this.subscribers.set(type, new Set());
        }
        this.subscribers.get(type)?.add(callback);
    }

    public unsubscribe(type: string, callback: (event: MemoryEvent) => Promise<void>): void {
        this.subscribers.get(type)?.delete(callback);
    }

    private async notifySubscribers(type: string, event: MemoryEvent): Promise<void> {
        const callbacks = this.subscribers.get(type);
        if (!callbacks) return;

        const errors: Error[] = [];
        await Promise.all(Array.from(callbacks).map(async (callback) => {
            try {
                await callback(event);
            } catch (error) {
                errors.push(error as Error);
                elizaLogger.error(`Error in memory event subscriber:`, error);
            }
        }));

        if (errors.length > 0) {
            elizaLogger.error(`${errors.length} errors occurred while notifying subscribers`);
        }
    }

    /**
     * Broadcasts an event to local subscribers only.
     * For cross-process sync, use MemorySyncManager.
     */
    public async broadcast(event: MemoryEvent): Promise<void> {
        try {
            // Notify local subscribers
            await this.notifySubscribers(event.type, {
                ...event,
                memory: {
                    id: event.content.id,
                    content: event.content,
                    roomId: event.roomId,
                    userId: event.agentId,
                    agentId: event.agentId,
                    createdAt: event.timestamp || Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error broadcasting event:", error);
            throw error;
        }
    }

    public async emitAsync(type: string, event: MemoryEvent): Promise<boolean> {
        await this.broadcast(event);
        return true;
    }
} 