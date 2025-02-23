import {
    IAgentRuntime,
    elizaLogger,
    UUID,
    Memory,
    IMemoryManager,
    stringToUuid
} from "@elizaos/core";
import { BaseContent } from "../types/base.ts";
import { MemoryQueryOptions, PaginationOptions } from "../types/memory.ts";

export interface PaginatedResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor?: string;
}

/**
 * Convert a domain string to a valid roomId UUID
 */
function domainToRoomId(domain: string): UUID {
    return stringToUuid(`domain-${domain}-${Date.now()}`);
}

/**
 * Retrieves memories with pagination support using cursor-based pagination
 */
export async function getPaginatedMemories<T extends BaseContent>(
    manager: IMemoryManager,
    domain: string,
    options: {
        type: string;
        filter?: (item: T) => boolean;
        sort?: (a: T, b: T) => number;
        pagination: PaginationOptions;
    }
): Promise<PaginatedResult<T>> {
    const memories = await manager.getMemories({
        roomId: domainToRoomId(domain),
        count: options.pagination.pageSize || 50,
        start: options.pagination.startTime,
        end: options.pagination.endTime
    });

    let items = memories
        .filter(m => m.content.type === options.type)
        .map(m => m.content as T);

    if (options.filter) {
        items = items.filter(options.filter);
    }

    if (options.sort) {
        items = items.sort(options.sort);
    }

    return {
        items,
        hasMore: items.length === (options.pagination.pageSize || 50),
        nextCursor: items.length > 0 ? items[items.length - 1].id : undefined
    };
}

/**
 * Retrieves all memories matching criteria, handling pagination automatically
 */
export async function getAllMemories<T extends BaseContent>(
    manager: IMemoryManager,
    domain: string,
    options: {
        type: string;
        filter?: (item: T) => boolean;
        sort?: (a: T, b: T) => number;
    }
): Promise<T[]> {
    const batchSize = 100;
    let cursor: string | undefined;
    const allItems: T[] = [];

    do {
        const result = await getPaginatedMemories<T>(manager, domain, {
            type: options.type,
            filter: options.filter,
            sort: options.sort,
            pagination: {
                pageSize: batchSize,
                cursor
            }
        });

        allItems.push(...result.items);
        cursor = result.nextCursor;

        if (!result.hasMore) {
            break;
        }
    } while (cursor);

    return allItems;
}

/**
 * Processes memories in chunks to avoid memory pressure
 */
export async function processMemoriesInChunks<T extends BaseContent>(
    manager: IMemoryManager,
    domain: string,
    processor: (items: T[]) => Promise<void>,
    options: {
        type: string;
        filter?: (item: T) => boolean;
        chunkSize?: number;
        maxChunks?: number;
    }
): Promise<void> {
    const chunkSize = options.chunkSize || 100;
    let cursor: string | undefined;
    let chunksProcessed = 0;

    do {
        const result = await getPaginatedMemories<T>(manager, domain, {
            type: options.type,
            filter: options.filter,
            pagination: {
                pageSize: chunkSize,
                cursor
            }
        });

        await processor(result.items);
        chunksProcessed++;
        cursor = result.nextCursor;

        if (!result.hasMore || (options.maxChunks && chunksProcessed >= options.maxChunks)) {
            break;
        }
    } while (cursor);
} 