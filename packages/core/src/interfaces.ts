import { UUID, Memory, IAgentRuntime } from "./types";

export interface IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    addEmbeddingToMemory(memory: Memory): Promise<Memory>;
    getMemories(opts: { roomId: UUID; count?: number; unique?: boolean; start?: number; end?: number; }): Promise<Memory[]>;
    getMemoriesWithPagination(options: { 
        roomId: UUID; 
        limit?: number; 
        cursor?: UUID; 
        startTime?: number;
        endTime?: number;
    }): Promise<{
        items: Memory[];
        hasMore: boolean;
        nextCursor?: UUID;
    }>;
    getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    getMemoryById(id: UUID): Promise<Memory | null>;
    getMemory(id: UUID): Promise<Memory | null>;
    getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number; }): Promise<Memory[]>;
    searchMemoriesByEmbedding(embedding: number[], opts: { match_threshold?: number; count?: number; roomId: UUID; unique?: boolean; }): Promise<Memory[]>;
    createMemory(memory: Memory, unique?: boolean): Promise<void>;
    updateMemory(memory: Memory): Promise<void>;
    removeMemory(memoryId: UUID): Promise<void>;
    removeAllMemories(roomId: UUID): Promise<void>;
    countMemories(roomId: UUID, unique?: boolean): Promise<number>;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    resyncDomainMemory(): Promise<void>;
    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
} 