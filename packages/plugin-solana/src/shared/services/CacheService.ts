import {
    IAgentRuntime,
    elizaLogger,
    stringToUuid,
    UUID,
    Memory
} from "@elizaos/core";
import { BaseContent } from "../types/base.ts";
import { getMemoryRoom, ROOM_IDS, MEMORY_ROOM_MAPPING } from "../constants.ts";

export interface CacheSubscriber<T = any> {
    pattern: string;
    callback: (data: T) => void;
}

export class CacheService {
    private subscribers: Map<string, Set<(data: any) => void>>;
    private memorySubscriptions: Map<string, Set<UUID>>; // pattern -> Set of room IDs
    private lastProcessedTimes: Map<UUID, number>; // roomId -> lastProcessedTime
    private pollingInterval: NodeJS.Timeout | null = null;

    constructor(private runtime: IAgentRuntime) {
        this.subscribers = new Map();
        this.memorySubscriptions = new Map();
        this.lastProcessedTimes = new Map();
        this.setupMemoryPolling();
    }

    private getRoomsForPattern(pattern: string): Set<UUID> {
        const rooms = new Set<UUID>();
        
        // Add global DAO room by default
        rooms.add(ROOM_IDS.DAO);

        // Add specific room based on pattern
        if (pattern.startsWith('proposal_')) {
            rooms.add(ROOM_IDS.PROPOSAL);
        } else if (pattern.startsWith('strategy_')) {
            rooms.add(ROOM_IDS.STRATEGY);
        } else if (pattern.startsWith('treasury_') || pattern.startsWith('swap_')) {
            rooms.add(ROOM_IDS.TREASURY);
        }

        // Add agent's personal room for agent-specific memories
        if (pattern === 'agent_message' || pattern === 'agent_action' || pattern === 'memory_error') {
            rooms.add(this.runtime.agentId);
        }

        // If pattern matches a specific memory type, use its mapped room
        const mappedRoom = getMemoryRoom(pattern);
        if (mappedRoom) {
            rooms.add(mappedRoom);
        }

        return rooms;
    }

    private setupMemoryPolling(): void {
        // Poll for new memories every second
        this.pollingInterval = setInterval(async () => {
            try {
                // Get all unique rooms we need to poll based on subscriptions
                const roomsToPoll = new Set<UUID>();
                for (const [pattern, _] of this.memorySubscriptions) {
                    const rooms = this.getRoomsForPattern(pattern);
                    rooms.forEach(room => roomsToPoll.add(room));
                }

                // Poll each room
                for (const roomId of roomsToPoll) {
                    const lastProcessedTime = this.lastProcessedTimes.get(roomId) || Date.now();
                    
                    const memories = await this.runtime.messageManager.getMemories({
                        roomId,
                        count: 50,
                        start: lastProcessedTime
                    });

                    let maxTimestamp = lastProcessedTime;
                    for (const memory of memories) {
                        const content = memory.content as BaseContent;
                        if (!content || !content.type) continue;

                        // Update max timestamp seen
                        if (content.createdAt > maxTimestamp) {
                            maxTimestamp = content.createdAt;
                        }

                        // Notify subscribers of this specific type
                        this.notifySubscribers(content.type, content);

                        // Notify pattern-based subscribers
                        for (const [pattern, _] of this.memorySubscriptions) {
                            if (content.type.startsWith(pattern)) {
                                this.notifySubscribers(pattern, content);
                            }
                        }
                    }

                    // Update last processed time for this room
                    this.lastProcessedTimes.set(roomId, maxTimestamp);
                }
            } catch (error) {
                elizaLogger.error("Error polling memories:", error);
            }
        }, 1000);
    }

    public async shutdown(): Promise<void> {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    private notifySubscribers(type: string, data: any): void {
        const subscribers = this.subscribers.get(type);
        if (subscribers) {
            subscribers.forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    elizaLogger.error(`Error in cache subscriber callback for ${type}:`, error);
                }
            });
        }
    }

    async get<T extends BaseContent>(id: UUID): Promise<T | null> {
        const memories = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.DAO, // Use global room for lookups
            count: 1,
            unique: true
        });

        const memory = memories.find(m => m.content.id === id);
        return memory ? memory.content as T : null;
    }

    async getMany<T extends BaseContent>(
        type: string,
        options: {
            limit?: number;
            filter?: (item: T) => boolean;
            sort?: (a: T, b: T) => number;
        } = {}
    ): Promise<T[]> {
        const roomId = getMemoryRoom(type);
        const memories = await this.runtime.messageManager.getMemories({
            roomId,
            count: options.limit || 100
        });

        let results = memories
            .filter(m => m.content.type === type)
            .map(m => m.content as T);

        if (options.filter) {
            results = results.filter(options.filter);
        }

        if (options.sort) {
            results = results.sort(options.sort);
        }

        return results;
    }

    async set<T extends BaseContent>(value: T): Promise<void> {
        // Determine if this memory type should be unique
        const uniqueTypes = [
            "proposal", "strategy", "vote", "treasury_transaction", 
            "agent_state", "wallet_registration", "strategy_execution"
        ];
        const shouldBeUnique = uniqueTypes.includes(value.type);

        // Get the correct room ID
        const roomId = getMemoryRoom(value.type);

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(`mem-${Date.now()}`),
            content: value,
            roomId,
            userId: value.agentId,
            agentId: value.agentId
        }, shouldBeUnique);
    }

    subscribe<T>(pattern: string, callback: (data: T) => void): void {
        // Add subscriber
        let subscribers = this.subscribers.get(pattern);
        if (!subscribers) {
            subscribers = new Set();
            this.subscribers.set(pattern, subscribers);
        }
        subscribers.add(callback);

        // Track rooms for this pattern
        const rooms = this.getRoomsForPattern(pattern);
        this.memorySubscriptions.set(pattern, rooms);

        // Initialize lastProcessedTimes for new rooms
        rooms.forEach(roomId => {
            if (!this.lastProcessedTimes.has(roomId)) {
                this.lastProcessedTimes.set(roomId, Date.now());
            }
        });
    }

    unsubscribe<T>(pattern: string, callback: (data: T) => void): void {
        const subscribers = this.subscribers.get(pattern);
        if (subscribers) {
            subscribers.delete(callback);
            if (subscribers.size === 0) {
                this.subscribers.delete(pattern);
                this.memorySubscriptions.delete(pattern);
            }
        }
    }

    async query<T extends BaseContent>(options: {
        type: string;
        filter?: (item: T) => boolean;
        sort?: (a: T, b: T) => number;
        limit?: number;
    }): Promise<T[]> {
        return this.getMany<T>(options.type, {
            filter: options.filter,
            sort: options.sort,
            limit: options.limit
        });
    }
} 