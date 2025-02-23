import { Memory, UUID } from "@elizaos/core";
import { BaseContent } from "./base.ts";

export interface MemoryEvent {
    type: string;
    content: BaseContent;
    roomId: UUID;
    agentId: UUID;
    timestamp: number;
    memory?: Memory;  // Add optional full Memory object
}

export interface MemorySubscription {
    type: string;
    callback: (memory: Memory) => Promise<void>;
}

export interface MemoryBroadcastOptions {
    skipProcess?: UUID;  // Skip broadcasting to specific process
    targetRooms?: UUID[];  // Only broadcast to specific rooms
} 