import { IAgentRuntime, UUID, elizaLogger } from "@elizaos/core";
import { ProposalContent } from "../types/proposal.ts";
import { findUniversalContent, queryUniversalContent, findContentById } from "./search.ts";
import { ROOM_IDS } from "../constants.ts";
import { shortIdToUuid } from "../types/proposal.ts";

/**
 * Finds a proposal by either its full UUID or short ID.
 * First attempts direct memory lookup, then falls back to room searches.
 * @param runtime The agent runtime
 * @param proposalIdentifier Either a short ID (e.g. "abc123") or a full UUID
 * @returns The proposal content or null if not found
 */
export async function findProposal(
    runtime: IAgentRuntime,
    proposalIdentifier: string
): Promise<ProposalContent | null> {
    try {
        // Convert identifier to UUID - handle both short IDs and full UUIDs
        const proposalId = proposalIdentifier.includes('-') 
            ? proposalIdentifier as UUID 
            : shortIdToUuid(proposalIdentifier);

        // Try direct memory lookup first
        const directMemory = await runtime.messageManager.getMemoryById(proposalId);
        if (directMemory && directMemory.content.type === "proposal") {
            return directMemory.content as ProposalContent;
        }

        // If direct lookup fails, try DAO room
        const proposal = await findContentById<ProposalContent>(
            runtime,
            proposalId,
            "proposal",
            ROOM_IDS.DAO
        );

        if (proposal) {
            return proposal;
        }

        // Last resort: check proposal-specific room
        return findContentById<ProposalContent>(
            runtime,
            proposalId,
            "proposal",
            ROOM_IDS.PROPOSAL
        );
    } catch (error) {
        elizaLogger.error(`Error finding proposal ${proposalIdentifier}:`, error);
        return null;
    }
}

/**
 * Query proposals with filtering and sorting options
 */
export async function queryProposals(
    runtime: IAgentRuntime,
    options: {
        filter?: (proposal: ProposalContent) => boolean;
        sort?: (a: ProposalContent, b: ProposalContent) => number;
        limit?: number;
    } = {}
): Promise<ProposalContent[]> {
    try {
        return queryUniversalContent<ProposalContent>(
            runtime,
            "proposal",
            {
                searchGlobalOnly: true,  // Proposals should always be in global room
                ...options
            }
        );
    } catch (error) {
        elizaLogger.error("Error querying proposals:", error);
        return [];
    }
} 