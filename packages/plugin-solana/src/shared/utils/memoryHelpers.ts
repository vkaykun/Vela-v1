import { IAgentRuntime, Memory, UUID, stringToUuid } from "@elizaos/core";
import { BaseContent, ContentStatus } from "../types/base.ts";
import { ROOM_IDS } from "../constants.ts";

interface StatusChangeParams {
    entityId: UUID;
    entityType: "proposal" | "strategy" | "treasury";
    newStatus: ContentStatus;
    previousStatus?: ContentStatus;
    text: string;
    metadata?: Record<string, unknown>;
}

/**
 * Creates a status change memory record with consistent structure
 */
export async function createStatusChangeMemory(
    runtime: IAgentRuntime,
    params: StatusChangeParams
): Promise<void> {
    const { entityId, entityType, newStatus, previousStatus, text, metadata } = params;
    const memoryId = stringToUuid(`status-${entityId}-${Date.now()}`);

    await runtime.messageManager.createMemory({
        id: memoryId,
        content: {
            type: `${entityType}_status_changed`,
            [`${entityType}Id`]: entityId,
            status: newStatus,
            previousStatus,
            text,
            metadata,
            createdAt: Date.now(),
            updatedAt: Date.now()
        },
        roomId: ROOM_IDS[entityType.toUpperCase()],
        userId: runtime.agentId,
        agentId: runtime.agentId
    });
}

/**
 * Creates an entity memory record with consistent structure
 */
export async function createEntityMemory<T extends BaseContent>(
    runtime: IAgentRuntime,
    params: {
        entityId: UUID;
        entityType: "proposal" | "strategy" | "treasury";
        content: T;
        roomId: UUID;
    }
): Promise<void> {
    const { entityId, entityType, content, roomId } = params;
    const memoryId = stringToUuid(`${entityType}-${entityId}`);

    await runtime.messageManager.createMemory({
        id: memoryId,
        content: {
            ...content,
            updatedAt: Date.now()
        },
        roomId,
        userId: runtime.agentId,
        agentId: runtime.agentId
    });
}

/**
 * Creates a tracking memory record with consistent structure
 */
export async function createTrackingMemory(
    runtime: IAgentRuntime,
    params: {
        entityId: UUID;
        entityType: "proposal" | "strategy" | "treasury";
        status: ContentStatus;
        text: string;
        metadata?: Record<string, unknown>;
    }
): Promise<void> {
    const { entityId, entityType, status, text, metadata } = params;
    const memoryId = stringToUuid(`track-${entityId}`);

    await runtime.messageManager.createMemory({
        id: memoryId,
        content: {
            type: `${entityType}_tracking`,
            [`${entityType}Id`]: entityId,
            status,
            text,
            metadata,
            createdAt: Date.now(),
            updatedAt: Date.now()
        },
        roomId: ROOM_IDS[entityType.toUpperCase()],
        userId: runtime.agentId,
        agentId: runtime.agentId
    });
} 