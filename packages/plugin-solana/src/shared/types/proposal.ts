import { UUID, stringToUuid } from "@elizaos/core";
import { BaseContent, ContentStatus } from "./base.ts";
import { Vote, VoteStats } from "./vote.ts";

export type ProposalType = "swap" | "strategy" | "governance" | "parameter_change" | "other";

export interface BaseProposalDetails {
    description: string;
    rationale?: string;
    impact?: string;
}

export interface SwapDetails extends BaseProposalDetails {
    inputToken: string;
    outputToken: string;
    amount: number;
    minOutputAmount?: number;
    maxSlippage?: number;
}

export interface StrategyDetails extends BaseProposalDetails {
    token: string;
    baseToken: string;
    amount: string;
    conditions: {
        type: "PRICE" | "TIME" | "VOLUME";
        value: string;
        operator: ">" | "<" | "==" | ">=" | "<=";
    }[];
}

export interface GovernanceDetails extends BaseProposalDetails {
    parameterName: string;
    currentValue: string;
    proposedValue: string;
    effectiveDate?: number;
}

export interface ParameterChangeDetails extends BaseProposalDetails {
    target: "quorum" | "minimumVotes" | "votingPeriod" | "slippageTolerance" | "maxStrategiesPerToken";
    currentValue: string | number;
    proposedValue: string | number;
    reason: string;
}

export interface OtherDetails extends BaseProposalDetails {
    customType: string;
    parameters: Record<string, unknown>;
}

export interface ProposalInterpretation {
    type: ProposalType;
    title: string;
    description: string;
    details: SwapDetails | StrategyDetails | GovernanceDetails | ParameterChangeDetails | OtherDetails;
}

export type ProposalStatus = "draft" | "open" | "pending_execution" | "executing" | "executed" | "rejected" | "cancelled" | "failed";

/**
 * Generates a consistent proposal UUID from a short ID
 * @param shortId The short ID to convert
 * @returns A UUID that will be consistent for the same short ID
 */
export function shortIdToUuid(shortId: string): UUID {
    return stringToUuid(`proposal-${shortId}`);
}

/**
 * Generates a new short ID for a proposal
 * @returns A unique short ID (6 characters)
 */
export function generateShortId(): string {
    return Math.random().toString(36).substring(2, 8);
}

/**
 * Proposal content interface with strict ID handling
 */
export interface ProposalContent extends BaseContent {
    type: "proposal";
    /**
     * The full UUID of the proposal, generated from the short ID
     * Should always be created using shortIdToUuid(shortId)
     */
    id: UUID;
    /**
     * The human-readable short ID (6 characters)
     * Used in user interactions and display
     */
    shortId: string;
    title: string;
    description: string;
    proposer: UUID;
    status: ContentStatus;
    yes: Vote[];
    no: Vote[];
    deadline: number;
    result?: string;
    closedAt?: number;
    linkedStrategyId?: string;
    strategyStatus?: string;
    voteStats: VoteStats;
    interpretation?: ProposalInterpretation;
    createdAt: number;
    updatedAt: number;
    metadata?: {
        tags?: string[];
        priority?: "low" | "medium" | "high";
        requiredRole?: string;
        minReputation?: number;
        executionDeadline?: number;
    };
}

export interface VoteContent extends BaseContent {
    type: "vote_cast";
    proposalId: string;
    userId: UUID;
    vote: "yes" | "no";
    weight: number;
    reason?: string;
    timestamp: number;
}

export interface ProposalExecutionResult {
    success: boolean;
    txHash?: string;
    error?: string;
    timestamp: number;
    executedBy: UUID;
} 