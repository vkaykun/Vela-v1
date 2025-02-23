import { Memory } from "@elizaos/core";
import { AgentType } from "./base.ts";

export interface MemorySubscriptionHandler {
    (memory: Memory): Promise<void>;
}

export interface MemorySubscriptionConfig {
    type: string;
    description: string;
    requiredBy: AgentType[];
    handler: MemorySubscriptionHandler;
    priority?: "high" | "medium" | "low";
    dependencies?: string[];  // Other memory types this handler depends on
    agentType?: AgentType;
}

/**
 * Registry of all memory subscriptions in the system.
 * Each entry defines which agents need to subscribe to which memory types.
 * 
 * Note: Raw base types like "proposal" and "strategy" are not subscription-driven.
 * Instead, we use event types (e.g. proposal_created, proposal_status_changed)
 * to handle state changes and lifecycle events for these entities.
 */
export const MEMORY_SUBSCRIPTIONS: Record<string, MemorySubscriptionConfig> = {
    // Nova-specific subscriptions
    "user_interaction": {
        type: "user_interaction",
        description: "User interactions and commands",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        priority: "high",
        agentType: "USER"
    },
    "user_preference_update": {
        type: "user_preference_update",
        description: "Updates to user preferences and settings",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        priority: "medium",
        agentType: "USER"
    },
    "user_feedback": {
        type: "user_feedback",
        description: "User feedback and ratings",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        agentType: "USER"
    },
    "learning_update": {
        type: "learning_update",
        description: "Updates to Nova's learning and adaptation",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        agentType: "USER"
    },
    "conversation_context": {
        type: "conversation_context",
        description: "Contextual information for conversations",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        priority: "high",
        agentType: "USER"
    },
    "task_tracking": {
        type: "task_tracking",
        description: "User task and goal tracking",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by Nova/UserProfileAgent
        },
        agentType: "USER"
    },

    // Proposal-related subscriptions
    "proposal_created": {
        type: "proposal_created",
        description: "New proposal creation events",
        requiredBy: ["PROPOSAL"],
        handler: async (memory) => {
            // Handled by ProposalAgent
        }
    },
    "vote_cast": {
        type: "vote_cast",
        description: "Vote submissions on proposals with vote status in metadata",
        requiredBy: ["PROPOSAL", "USER"],
        handler: async (memory) => {
            // - ProposalAgent: Records vote and updates proposal stats
            // - UserProfileAgent: Updates user voting history
        },
        dependencies: ["proposal"],
        priority: "high"
    },
    "proposal_status_changed": {
        type: "proposal_status_changed",
        description: "Proposal status changes (including passed, rejected, etc.)",
        requiredBy: ["PROPOSAL", "STRATEGY", "TREASURY", "USER"],
        handler: async (memory) => {
            // Handled by all agents based on status:
            // - TreasuryAgent: Handles when status = "pending_execution" (indicates proposal passed)
            // - StrategyAgent: Handles when status = "executed"
            // - ProposalAgent: Handles all status changes
            // - UserProfileAgent: Updates user stats based on status
            //
            // Status flow:
            // draft -> open -> pending_execution (passed) -> executing -> executed
            //                  rejected (failed)
            //                  cancelled
        },
        priority: "high",
        dependencies: ["proposal"]
    },
    "proposal_execution_result": {
        type: "proposal_execution_result",
        description: "Results of proposal execution (success/failure, tx hash, etc.)",
        requiredBy: ["PROPOSAL", "STRATEGY", "TREASURY", "USER"],
        handler: async (memory) => {
            // Handled by:
            // - ProposalAgent: Updates proposal state based on execution result
            // - StrategyAgent: Triggers post-execution strategy logic
            // - TreasuryAgent: Updates treasury state after execution
            // - UserProfileAgent: Updates user stats based on execution result
        },
        priority: "high",
        dependencies: ["proposal", "proposal_status_changed"]
    },

    // Strategy-related subscriptions
    "strategy_execution_request": {
        type: "strategy_execution_request",
        description: "Request to execute a strategy",
        requiredBy: ["STRATEGY", "TREASURY"],
        handler: async (memory) => {
            // - StrategyAgent: Validates and prepares strategy for execution
            // - TreasuryAgent: Handles the actual execution via swap
        },
        priority: "high",
        dependencies: ["strategy"]
    },
    "strategy_status_changed": {
        type: "strategy_status_changed",
        description: "Strategy status updates (triggered, executing, etc)",
        requiredBy: ["STRATEGY", "TREASURY", "USER"],
        handler: async (memory) => {
            // - StrategyAgent: Updates strategy state and monitoring
            // - TreasuryAgent: Tracks strategy execution progress
            // - UserProfileAgent: Updates user strategy stats
        },
        priority: "high",
        dependencies: ["strategy", "strategy_execution_request"]
    },
    "strategy_execution_result": {
        type: "strategy_execution_result",
        description: "Final result of strategy execution",
        requiredBy: ["STRATEGY", "TREASURY", "USER"],
        handler: async (memory) => {
            // - StrategyAgent: Updates strategy state based on result
            // - TreasuryAgent: Updates treasury state after execution
            // - UserProfileAgent: Updates user strategy stats
        },
        priority: "high",
        dependencies: ["strategy", "strategy_status_changed"]
    },

    // Treasury-related subscriptions
    "swap_request": {
        type: "swap_request",
        description: "Token swap requests",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent
        },
        agentType: "TREASURY"
    },
    "swap_execution_result": {
        type: "swap_execution_result",
        description: "Results of swap execution (success/failure)",
        requiredBy: ["TREASURY", "STRATEGY"],
        handler: async (memory) => {
            // - TreasuryAgent: Updates treasury state after swap
            // - StrategyAgent: Updates strategy if swap was strategy-triggered
        },
        priority: "high",
        dependencies: ["swap_request"],
        agentType: "TREASURY"
    },
    "deposit_received": {
        type: "deposit_received",
        description: "New deposits to treasury",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent
        },
        agentType: "TREASURY"
    },
    "transfer_requested": {
        type: "transfer_requested",
        description: "Token transfer requests",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent
        },
        agentType: "TREASURY"
    },
    "transaction_status_changed": {
        type: "transaction_status_changed",
        description: "Transaction status updates",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent
        },
        agentType: "TREASURY"
    },

    // Position/Market-related subscriptions
    "position_update": {
        type: "position_update",
        description: "Strategy position updates",
        requiredBy: ["STRATEGY"],
        handler: async (memory) => {
            // Handled by StrategyExecutor
        },
        agentType: "STRATEGY"
    },
    "price_update": {
        type: "price_update",
        description: "Token price updates",
        requiredBy: ["STRATEGY"],
        handler: async (memory) => {
            // Handled by StrategyExecutor
        },
        agentType: "STRATEGY"
    },

    // User-related subscriptions
    "wallet_registration": {
        type: "wallet_registration",
        description: "User wallet registration events",
        requiredBy: ["USER", "TREASURY"],
        handler: async (memory) => {
            // Handled by UserProfileAgent/Nova and TreasuryAgent
        },
        priority: "high"
    },
    "user_profile_update": {
        type: "user_profile_update",
        description: "Updates to user profile information",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by UserProfileAgent/Nova
        },
        priority: "medium",
        agentType: "USER"
    }
} as const; 