import { UUID } from "@elizaos/core";
import { BaseContent, ContentStatus, MemoryMetadata } from "./base.ts";
import { UserProfile } from "./user.ts";

export interface Vote {
    userId: UUID;
    votingPower: number;
    timestamp: number;
    version?: number;  // Track version for concurrent modification detection
}

export interface VoteStats {
    total: number;
    yes: number;
    no: number;
    totalVotingPower: number;
    totalYesPower: number;
    totalNoPower: number;
    yesPowerPercentage: number;
    yesPercentage: number;
    quorumReached: boolean;
    minimumYesVotesReached: boolean;
    minimumPercentageReached: boolean;
}

// Specialized user profile for voting-specific functionality
export interface VoteUserProfile extends UserProfile {
    // Add any vote-specific fields here that aren't in the base UserProfile
    // For now, all fields have been moved to the base UserProfile
}

export interface VoteContent extends BaseContent {
    type: "vote_cast";
    agentId: UUID;
    metadata: {
        proposalId: string;
        vote: "yes" | "no";
        votingPower: number;
        reason?: string;
        timestamp: number;
    };
}

export interface ProposalContent extends BaseContent {
    type: "proposal";
    title: string;
    description: string;
    proposer: UUID;
    yes: Vote[];
    no: Vote[];
    voteStats: VoteStats;
    /**
     * The deadline for this proposal's voting period.
     * This is set at creation time and cannot be modified after creation
     * to ensure consistent deadline enforcement.
     */
    deadline: number;
    status: "draft" | "open" | "pending_execution" | "executing" | "executed" | "rejected" | "cancelled" | "failed";
    createdAt: number;
    updatedAt: number;
    metadata?: MemoryMetadata & {
        voteVersion?: number;  // Track overall vote state version
        tags?: string[];
        priority?: "low" | "medium" | "high";
        requiredRole?: string;
        minReputation?: number;
        executionDeadline?: number;
    };
    votingConfig?: {
        quorumThreshold: number;
        minimumYesVotes: number;
        minimumVotePercentage: number;
        votingPeriod: number;
        allowDelegation?: boolean;
        restrictedToRoles?: string[];
    };
} 