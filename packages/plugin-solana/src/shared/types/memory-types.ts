import { Memory as CoreMemory } from "@elizaos/core";

export interface Memory extends CoreMemory {
    domain?: string;
}

export interface MemorySubscription {
    callback: (memory: Memory) => Promise<void>;
} 