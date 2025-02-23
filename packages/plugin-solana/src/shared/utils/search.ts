import {
    IAgentRuntime,
    elizaLogger,
    UUID,
    Memory
} from "@elizaos/core";
import { BaseContent } from "../types/base.ts";
import { ROOM_IDS, AGENT_IDS } from "../constants.ts";

const DEFAULT_MEMORY_LIMIT = 500;

/**
 * Find content across rooms, prioritizing global room
 */
export async function findUniversalContent<T extends BaseContent>(
    runtime: IAgentRuntime,
    contentId: UUID,
    type: string,
    options: {
        searchGlobalOnly?: boolean;
        includeAgentRooms?: boolean;
    } = {}
): Promise<T | null> {
    try {
        // Try to get memory directly by ID first
        const directMemory = await runtime.messageManager.getMemoryById(contentId);
        if (directMemory && directMemory.content.type === type) {
            return directMemory.content as T;
        }

        // If direct lookup fails, search in global room
        const globalMemories = await runtime.messageManager.getMemories({
            roomId: ROOM_IDS.DAO,
            count: DEFAULT_MEMORY_LIMIT
        });

        const globalMatch = globalMemories.find(memory =>
            memory.content.id === contentId &&
            memory.content.type === type
        );

        if (globalMatch) {
            return globalMatch.content as T;
        }

        // If searchGlobalOnly is true, stop here
        if (options.searchGlobalOnly) {
            return null;
        }

        // Search in agent rooms if needed
        if (options.includeAgentRooms) {
            const agentRooms = [
                ROOM_IDS.PROPOSAL,
                ROOM_IDS.STRATEGY,
                ROOM_IDS.TREASURY
            ];

            for (const roomId of agentRooms) {
                const memories = await runtime.messageManager.getMemories({
                    roomId,
                    count: DEFAULT_MEMORY_LIMIT
                });

                const match = memories.find(memory =>
                    memory.content.id === contentId &&
                    memory.content.type === type
                );

                if (match) {
                    return match.content as T;
                }
            }
        }

        return null;
    } catch (error) {
        elizaLogger.error(`Error in findUniversalContent for ID ${contentId}:`, error);
        return null;
    }
}

/**
 * Helper function to efficiently search by ID across all rooms
 */
export async function findContentById<T extends BaseContent>(
    runtime: IAgentRuntime,
    contentId: UUID,
    type: string,
    roomId?: UUID
): Promise<T | null> {
    try {
        // Try direct memory lookup first
        const directMemory = await runtime.messageManager.getMemoryById(contentId);
        if (directMemory && 
            directMemory.content.type === type && 
            (!roomId || directMemory.roomId === roomId)) {
            return directMemory.content as T;
        }

        // If roomId is provided and direct lookup failed, search in that room
        if (roomId) {
            const memories = await runtime.messageManager.getMemories({
                roomId,
                count: DEFAULT_MEMORY_LIMIT
            });

            const match = memories.find(memory =>
                memory.content.id === contentId &&
                memory.content.type === type
            );

            return match ? match.content as T : null;
        }

        // If no roomId provided, use findUniversalContent
        return findUniversalContent<T>(runtime, contentId, type, {
            includeAgentRooms: true
        });
    } catch (error) {
        elizaLogger.error(`Error finding content by ID ${contentId}:`, error);
        return null;
    }
}

/**
 * Query content across rooms with filtering and sorting
 */
export async function queryUniversalContent<T extends BaseContent>(
    runtime: IAgentRuntime,
    type: string,
    options: {
        searchGlobalOnly?: boolean;
        includeAgentRooms?: boolean;
        filter?: (content: T) => boolean;
        sort?: (a: T, b: T) => number;
        limit?: number;
    } = {}
): Promise<T[]> {
    let results: T[] = [];

    // Query global room
    const globalMemories = await runtime.messageManager.getMemories({
        roomId: ROOM_IDS.DAO,
        count: DEFAULT_MEMORY_LIMIT
    });

    results = globalMemories
        .filter(memory => memory.content.type === type)
        .map(memory => memory.content as T);

    // If not global-only and agent rooms included, query agent rooms
    if (!options.searchGlobalOnly && options.includeAgentRooms) {
        const agentRooms = [
            ROOM_IDS.PROPOSAL,
            ROOM_IDS.STRATEGY,
            ROOM_IDS.TREASURY
        ];

        for (const roomId of agentRooms) {
            const memories = await runtime.messageManager.getMemories({
                roomId,
                count: DEFAULT_MEMORY_LIMIT
            });

            const agentResults = memories
                .filter(memory => memory.content.type === type)
                .map(memory => memory.content as T);

            results = [...results, ...agentResults];
        }
    }

    // Apply custom filter if provided
    if (options.filter) {
        results = results.filter(options.filter);
    }

    // Apply custom sort if provided
    if (options.sort) {
        results = results.sort(options.sort);
    }

    // Apply limit if provided
    if (options.limit && options.limit < results.length) {
        results = results.slice(0, options.limit);
    }

    return results;
} 