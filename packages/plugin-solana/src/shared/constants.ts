import { UUID, elizaLogger, stringToUuid } from "@elizaos/core";

// Define memory domains that map to Eliza's managers
export const MEMORY_DOMAINS = {
    // Short-term memory (maps to messageManager)
    ACTIVE: {
        PROPOSALS: "active_proposals",
        STRATEGIES: "active_strategies",
        TRANSACTIONS: "active_transactions",
        VOTES: "active_votes"
    },
    // Long-term memory (maps to loreManager)
    ARCHIVE: {
        PROPOSALS: "archived_proposals",
        STRATEGIES: "archived_strategies",
        TRANSACTIONS: "archived_transactions",
        VOTES: "archived_votes"
    },
    // Description memory (maps to descriptionManager)
    DESCRIPTIONS: {
        AGENTS: "agent_descriptions",
        PROPOSALS: "proposal_descriptions",
        STRATEGIES: "strategy_descriptions"
    }
} as const;

// Legacy room IDs - to be deprecated
export const ROOM_IDS = {
    DAO: "00000000-0000-0000-0000-000000000001" as UUID,
    PROPOSAL: "00000000-0000-0000-0000-000000000002" as UUID,
    STRATEGY: "00000000-0000-0000-0000-000000000003" as UUID,
    TREASURY: "00000000-0000-0000-0000-000000000004" as UUID,
    USER: "00000000-0000-0000-0000-000000000005" as UUID
} as const;

// Helper to determine appropriate memory domain for a memory type
export function getMemoryDomain(type: string): string {
    // Active/recent memories
    if (type.startsWith("active_") || 
        type.includes("_request") || 
        type.includes("_pending")) {
        return MEMORY_DOMAINS.ACTIVE[type.split('_')[1].toUpperCase()] || MEMORY_DOMAINS.ACTIVE.TRANSACTIONS;
    }
    
    // Archived/completed memories
    if (type.startsWith("archived_") || 
        type.includes("_completed") || 
        type.includes("_executed")) {
        return MEMORY_DOMAINS.ARCHIVE[type.split('_')[1].toUpperCase()] || MEMORY_DOMAINS.ARCHIVE.TRANSACTIONS;
    }
    
    // Descriptive memories
    if (type.includes("_description") || 
        type.includes("_metadata") || 
        type.includes("_config")) {
        return MEMORY_DOMAINS.DESCRIPTIONS[type.split('_')[0].toUpperCase()] || MEMORY_DOMAINS.DESCRIPTIONS.AGENTS;
    }
    
    // Default to active transactions for unknown types
    return MEMORY_DOMAINS.ACTIVE.TRANSACTIONS;
}

// Helper to determine if a memory should be archived
export function shouldArchiveMemory(type: string, status?: string): boolean {
    return status === "executed" || 
           status === "failed" || 
           status === "cancelled" || 
           type.startsWith("archived_") || 
           type.includes("_completed") || 
           type.includes("_executed");
}

// Helper to determine if a memory is descriptive
export function isDescriptiveMemory(type: string): boolean {
    return type.includes("_description") || 
           type.includes("_metadata") || 
           type.includes("_config");
}

// Export memory type constants
export const MEMORY_TYPES = {
    PROPOSAL: {
        ACTIVE: "active_proposal",
        ARCHIVED: "archived_proposal",
        DESCRIPTION: "proposal_description"
    },
    STRATEGY: {
        ACTIVE: "active_strategy",
        ARCHIVED: "archived_strategy",
        DESCRIPTION: "strategy_description"
    },
    TRANSACTION: {
        ACTIVE: "active_transaction",
        ARCHIVED: "archived_transaction",
        DESCRIPTION: "transaction_description"
    },
    VOTE: {
        ACTIVE: "active_vote",
        ARCHIVED: "archived_vote",
        DESCRIPTION: "vote_description"
    }
} as const;

// Stable agent IDs
export const AGENT_IDS = {
    PROPOSAL: "00000000-0000-0000-0001-000000000000" as UUID,
    STRATEGY: "00000000-0000-0000-0002-000000000000" as UUID,
    TREASURY: "00000000-0000-0000-0003-000000000000" as UUID,
    USER: "00000000-0000-0000-0004-000000000000" as UUID
} as const;

// Memory types that are always stored in agent's personal room
export const AGENT_SPECIFIC_MEMORY_TYPES = [
    'agent_message',
    'agent_action',
    'agent_log',
    'memory_error',
    'agent_state',
    'agent_debug'
] as const;

export type AgentSpecificMemoryType = typeof AGENT_SPECIFIC_MEMORY_TYPES[number];

// Memory type to room mapping
export const MEMORY_ROOM_MAPPING: Record<string, UUID | 'AGENT_ROOM'> = {
    // Global shared state (always in DAO room)
    proposal: ROOM_IDS.DAO,
    strategy: ROOM_IDS.DAO,
    vote: ROOM_IDS.DAO,
    treasury_transaction: ROOM_IDS.DAO,
    wallet_registration: ROOM_IDS.DAO,
    user_profile: ROOM_IDS.DAO,
    reputation_update: ROOM_IDS.DAO,
    activity_log: ROOM_IDS.DAO,

    // Execution records (global visibility)
    proposal_execution: ROOM_IDS.DAO,
    strategy_execution: ROOM_IDS.DAO,
    swap_completed: ROOM_IDS.DAO,
    proposal_execution_result: ROOM_IDS.DAO,

    // Domain-specific working state
    proposal_draft: ROOM_IDS.PROPOSAL,
    proposal_discussion: ROOM_IDS.PROPOSAL,
    proposal_vote_history: ROOM_IDS.PROPOSAL,
    proposal_status_changed: ROOM_IDS.PROPOSAL,
    proposal_passed: ROOM_IDS.PROPOSAL,
    proposal_auto_closed: ROOM_IDS.PROPOSAL,

    strategy_monitoring: ROOM_IDS.STRATEGY,
    strategy_status_changed: ROOM_IDS.STRATEGY,
    price_update: ROOM_IDS.STRATEGY,
    position_update: ROOM_IDS.STRATEGY,
    strategy_execution_request: ROOM_IDS.STRATEGY,
    strategy_execution_result: ROOM_IDS.STRATEGY,
    strategy_cancellation: ROOM_IDS.STRATEGY,

    balance_update: ROOM_IDS.TREASURY,
    swap_request: ROOM_IDS.TREASURY,
    deposit_received: ROOM_IDS.TREASURY,
    transfer_requested: ROOM_IDS.TREASURY,
    treasury_update: ROOM_IDS.TREASURY,

    // Agent-specific memories (always use agent's personal room)
    agent_message: 'AGENT_ROOM',
    agent_action: 'AGENT_ROOM',
    agent_log: 'AGENT_ROOM',
    memory_error: 'AGENT_ROOM',
    agent_state: 'AGENT_ROOM',
    agent_debug: 'AGENT_ROOM'
} as const;

/**
 * Helper function to get the correct room for a memory type
 * @param type The memory type
 * @param agentRoomId The agent's personal room ID (required for agent-specific memories)
 * @returns The appropriate room ID for the memory type
 * @throws Error if agentRoomId is not provided for agent-specific memories
 */
export function getMemoryRoom(type: string, agentRoomId?: UUID): UUID {
    // Check if this is an agent-specific memory type
    if (AGENT_SPECIFIC_MEMORY_TYPES.includes(type as AgentSpecificMemoryType)) {
        if (!agentRoomId) {
            throw new Error(`Agent room ID must be provided for agent-specific memory type: ${type}`);
        }
        return agentRoomId;
    }
    
    // Look up in memory room mapping
    const room = MEMORY_ROOM_MAPPING[type];
    
    // For known memory types, use their mapped room
    if (room && typeof room === 'string' && room !== 'AGENT_ROOM') {
        return room as UUID;
    }

    // Handle special AGENT_ROOM marker
    if (room === 'AGENT_ROOM') {
        if (!agentRoomId) {
            throw new Error(`Agent room ID must be provided for memory type: ${type}`);
        }
        return agentRoomId;
    }

    // Default to DAO room for unknown types with warning
    elizaLogger.warn(`No room mapping found for memory type: ${type}, defaulting to DAO room`);
    return ROOM_IDS.DAO;
}

// Types that should be globally visible
export const GLOBAL_MEMORY_TYPES = [
    "proposal",
    "strategy",
    "vote",
    "treasury_transaction",
    "wallet_registration",
    "proposal_execution",
    "strategy_execution",
    "swap_completed",
    "proposal_execution_result"
] as const; 