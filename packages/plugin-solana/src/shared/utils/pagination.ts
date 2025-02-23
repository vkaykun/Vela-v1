import { Memory, UUID, elizaLogger, IMemoryManager } from "@elizaos/core";

export interface PaginationOptions {
    roomId: UUID;
    batchSize?: number;
    maxBatches?: number;
    filter?: (memory: Memory) => boolean;
}

/**
 * Fetches all memories with proper pagination
 * @param memoryManager The memory manager to use for fetching
 * @param options Pagination options
 * @returns Array of memories
 */
export async function fetchAllMemories(
    memoryManager: IMemoryManager,
    options: PaginationOptions
): Promise<Memory[]> {
    const {
        roomId,
        batchSize = 100,
        maxBatches = 10, // Prevent infinite loops
        filter
    } = options;

    const allMemories: Memory[] = [];
    let offset = 0;
    let batchCount = 0;
    let hasMore = true;

    try {
        while (hasMore && batchCount < maxBatches) {
            const chunk = await memoryManager.getMemories({
                roomId,
                count: batchSize,
                start: offset
            });

            if (chunk.length < batchSize) {
                hasMore = false;
            }

            if (filter) {
                allMemories.push(...chunk.filter(filter));
            } else {
                allMemories.push(...chunk);
            }

            offset += batchSize;
            batchCount++;

            elizaLogger.debug(`Fetched memory batch ${batchCount}`, {
                batchSize,
                chunkSize: chunk.length,
                totalFetched: allMemories.length,
                hasMore
            });
        }

        if (hasMore && batchCount >= maxBatches) {
            elizaLogger.warn(`Reached maximum batch limit (${maxBatches}) while fetching memories`, {
                roomId,
                totalFetched: allMemories.length
            });
        }

        return allMemories;
    } catch (error) {
        elizaLogger.error("Error fetching paginated memories:", error);
        throw error;
    }
}

/**
 * Processes memories in batches with a callback
 * @param memoryManager The memory manager to use for fetching
 * @param options Pagination options
 * @param processor Callback function to process each batch
 */
export async function processMemoriesInBatches(
    memoryManager: IMemoryManager,
    options: PaginationOptions,
    processor: (memories: Memory[]) => Promise<void>
): Promise<void> {
    const {
        roomId,
        batchSize = 100,
        maxBatches = 10,
        filter
    } = options;

    let offset = 0;
    let batchCount = 0;
    let hasMore = true;

    try {
        while (hasMore && batchCount < maxBatches) {
            const chunk = await memoryManager.getMemories({
                roomId,
                count: batchSize,
                start: offset
            });

            if (chunk.length < batchSize) {
                hasMore = false;
            }

            const batchToProcess = filter ? chunk.filter(filter) : chunk;
            if (batchToProcess.length > 0) {
                await processor(batchToProcess);
            }

            offset += batchSize;
            batchCount++;

            elizaLogger.debug(`Processed memory batch ${batchCount}`, {
                batchSize,
                chunkSize: chunk.length,
                processedInBatch: batchToProcess.length,
                hasMore
            });
        }

        if (hasMore && batchCount >= maxBatches) {
            elizaLogger.warn(`Reached maximum batch limit (${maxBatches}) while processing memories`, {
                roomId,
                batchesProcessed: batchCount
            });
        }
    } catch (error) {
        elizaLogger.error("Error processing memory batches:", error);
        throw error;
    }
} 