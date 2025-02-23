// packages/plugin-solana/src/agents/proposal/ProposalAgent.ts

import {
    elizaLogger,
    stringToUuid,
    UUID,
    Memory,
    State,
    Service,
    ServiceType as CoreServiceType,
    generateObject,
    ModelClass,
    composeContext,
    generateText,
    IMemoryManager,
    Content
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent.ts";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import {
    AgentMessage,
    ContentStatus,
    isValidContentStatus,
    ContentStatusIndex,
    getContentStatus,
    isValidStatusTransition,
    MemoryMetadata,
    BaseContent,
    IAgentRuntime,
    withTransaction,
    TransactionManager,
    DAOEvent,
    DistributedLock
} from "../../shared/types/base.ts";
import {
    VoteContent,
    Vote,
    VoteStats,
    ProposalContent
} from "../../shared/types/vote.ts";
import {
    ProposalInterpretation,
    ProposalStatus,
    SwapDetails,
    StrategyDetails,
    GovernanceDetails,
    ParameterChangeDetails,
    OtherDetails,
    ProposalType,
    generateShortId,
    shortIdToUuid
} from "../../shared/types/proposal.ts";
import { findProposal } from "../../shared/utils/proposal.ts";
import { getMemoryRoom, ROOM_IDS } from "../../shared/constants.ts";
import { v4 as uuidv4 } from 'uuid';
import { tokeninfo } from "../../actions/tokeninfo.js";

// Custom interfaces to replace discord.js types
interface User {
    id: string;
    bot: boolean;
}

interface MessageReaction {
    emoji: {
        name: string | null;
    };
    message: {
        id: string;
        reactions: {
            cache: {
                find: (predicate: (r: MessageReaction) => boolean) => MessageReaction | undefined;
            };
        };
    };
    users: {
        remove: (user: User) => Promise<void>;
    };
}

// Interfaces
interface VoteRequirements {
    quorum: number;
    minimumYesVotes: number;
    minimumVotePercentage: number;
    expiryDays: number;
    maxProposalsPerUser: number;
}

interface VotePower {
    votingPower: number;
    timestamp: number;
    reason?: string;
}

interface ExtendedVote extends Vote {
    userId: UUID;
    vote: 'yes' | 'no';
    votingPower: number;
    timestamp: number;
}

interface ProposalExecutionResult extends BaseContent {
    type: "proposal_execution_result";
    proposalId: UUID;
    success: boolean;
    error?: string;
    executedBy: UUID;
    timestamp: number;
}

interface ProposalMetadata extends MemoryMetadata {
    tags?: string[];
    priority?: "low" | "medium" | "high";
    requiredRole?: string;
    minReputation?: number;
    executionDeadline?: number;
    closedBy?: UUID;
    closeTimestamp?: number;
    lastUpdated?: number;
    success?: boolean;
    error?: string;
    executedBy?: UUID;
    timestamp?: number;
    voteVersion?: number;
    [key: string]: any;
}

// Update ProposalContent interface to use the new metadata type
interface ExtendedProposalContent extends ProposalContent {
    metadata?: ProposalMetadata;
    messageId?: string;
    closedAt?: number;
}

// Add DAOEventType enum if not exists
type DAOEventType = "parameter_change" | "proposal_created" | "proposal_executed" | "vote_cast";

// Templates moved from action files
const proposalInterpretTemplate = `You are a DAO proposal interpreter. Analyze the following proposal command and provide a natural interpretation.

Original Command: {{message.content.text}}

Format the response as a JSON object with:
- A clear, concise title
- A detailed description in natural language
- The proposal type (swap/strategy/governance/other)
- Any relevant numerical details (amounts, prices, etc.)

Example for a swap:
{
    "title": "Swap 3 SOL for USDC",
    "description": "Proposal to exchange 3 SOL tokens for USDC from the DAO treasury. This swap will be executed through Jupiter aggregator for the best possible price.",
    "type": "swap",
    "details": {
        "inputToken": "SOL",
        "outputToken": "USDC",
        "amount": 3
    }
}`;

const voteDetectionTemplate = `You are a DAO assistant. Analyze if the user's message is casting a vote on a proposal:

"{{message.content.text}}"

Consider if the user is:
1. Explicitly voting (e.g., "I vote yes on...", "voting no to...")
2. Expressing support/opposition (e.g., "I support...", "I'm against...")
3. Using reactions/emojis (e.g., "👍 to proposal...", "thumbs down on...")

Extract:
1. The proposal ID (usually a 6-character code like 'abc123')
2. Whether it's a yes/no vote
3. The confidence in this interpretation

Return a JSON object:
{
    "isVote": boolean,
    "proposalId": string | null,
    "isYesVote": boolean | null,
    "confidence": number,
    "reason": string
}`;

const closeVoteDetectionTemplate = `You are a DAO assistant. Analyze if the user's message is requesting to close/finalize a proposal:

"{{message.content.text}}"

Consider if the user is:
1. Explicitly requesting to close (e.g., "close proposal...", "finalize proposal...")
2. Suggesting ending the vote (e.g., "end voting on...", "conclude proposal...")
3. Asking to tally/count votes (e.g., "count votes for...", "tally proposal...")

Extract:
1. The proposal ID (usually a 6-character code like 'abc123')
2. The confidence in this interpretation

Return a JSON object:
{
    "isCloseRequest": boolean,
    "proposalId": string | null,
    "confidence": number,
    "reason": string
}`;

// Helper functions moved from action files
function formatTimeLeft(deadline: number): string {
    const now = Date.now();
    const timeLeft = deadline - now;
    
    if (timeLeft < 0) {
        return "Expired";
    }
    
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    
    return `${hours}h ${minutes}m remaining`;
}

function getQuorumStatus(proposal: ProposalContent, requirements: VoteRequirements): string {
    const totalVotes = proposal.yes.length + proposal.no.length;
    
    if (totalVotes >= requirements.quorum) {
        return "✅ Quorum reached";
    }
    return `⏳ Need ${requirements.quorum - totalVotes} more vote${requirements.quorum - totalVotes === 1 ? '' : 's'} for quorum`;
}

function getVoteProgress(yesCount: number, noCount: number): string {
    const total = yesCount + noCount;
    if (total === 0) return "No votes yet";
    
    const yesPercent = Math.round((yesCount / total) * 100);
    const noPercent = 100 - yesPercent;
    
    return `[${yesCount}/${total}] ${'▓'.repeat(yesPercent/10)}${'░'.repeat(noPercent/10)} ${yesPercent}%`;
}

// Add missing interfaces
interface ExtendedAgentMessage extends AgentMessage {
    userId: UUID;
    agentId: UUID;
    roomId: UUID;
}

interface ExtendedProposalInterpretation extends ProposalInterpretation {
    description: string;
}

interface ProposalStatusContent extends Omit<BaseContent, 'status'> {
    type: "proposal_status_changed";
    proposalId: UUID;
    status: ContentStatus;
    previousStatus: ContentStatus | null;
    text: string;
}

interface ProposalMonitoringContent extends Omit<BaseContent, 'status'> {
    type: "proposal_monitoring";
    proposalId: UUID;
    status: "monitoring" | "completed" | "failed";
    retryCount: number;
    maxRetries: number;
    nextRetryTime: number;
    text: string;
}

interface RetryState {
    nextRetryTime: number;
    text: string;
}

interface MonitoringState {
    timestamp: number;
    id: UUID;
}

interface VotePowerUsage {
    proposalId: UUID;
    powerUsed: number;
    timestamp: number;
}

export class ProposalAgent extends BaseAgent {
    private config: VoteRequirements;
    private LOCK_DURATION_MS = 30000; // 30 seconds for locking
    private lastProcessedMonitoring: MonitoringState | null = null;

    // Add schema definitions
    private readonly proposalSchema = {
        type: 'object',
        required: ['title', 'description', 'type', 'details'],
        properties: {
            title: {
                type: 'string',
                pattern: '^[\\w\\s\\-_.,!?()]{3,100}$'  // Reasonable title format
            },
            description: {
                type: 'string',
                pattern: '^[\\w\\s\\-_.,!?()\\n]{10,1000}$'  // Reasonable description format
            },
            type: {
                type: 'string',
                enum: ['swap', 'strategy', 'governance', 'parameter_change', 'other']
            },
            details: {
                type: 'object'
            }
        }
    };

    private readonly voteSchema = {
        type: 'object',
        required: ['isVote', 'proposalId', 'isYesVote', 'confidence'],
        properties: {
            isVote: {
                type: 'boolean'
            },
            proposalId: {
                type: 'string',
                pattern: '^[a-zA-Z0-9]{6}$'  // 6-char proposal ID format
            },
            isYesVote: {
                type: 'boolean'
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            },
            reason: {
                type: 'string'
            }
        }
    };

    private readonly closeVoteSchema = {
        type: 'object',
        required: ['isCloseRequest', 'proposalId', 'confidence'],
        properties: {
            isCloseRequest: {
                type: 'boolean'
            },
            proposalId: {
                type: 'string',
                pattern: '^[a-zA-Z0-9]{6}$'  // 6-char proposal ID format
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            },
            reason: {
                type: 'string'
            }
        }
    };

    private isValidProposalInterpretation(obj: unknown): obj is ProposalInterpretation {
        if (!obj || typeof obj !== 'object') return false;

        const interpretation = obj as any;
        
        // Check required base fields
        if (typeof interpretation.title !== 'string' || !interpretation.title.trim()) {
            return false;
        }
        if (typeof interpretation.description !== 'string' || !interpretation.description.trim()) {
            return false;
        }

        // Check proposal details
        if (!interpretation.details || typeof interpretation.details !== 'object') {
            return false;
        }

        // Validate based on proposal type
        switch (interpretation.details.type) {
            case 'swap':
                return this.validateSwapProposal(interpretation.details);
            case 'strategy':
                return this.validateStrategyProposal(interpretation.details);
            case 'governance':
                return this.validateGovernanceProposal(interpretation.details);
            case 'parameter_change':
                return this.validateParameterChangeProposal(interpretation.details);
            case 'other':
                return true; // Allow other types with basic validation
            default:
                return false;
        }
    }

    private validateSwapProposal(details: any): boolean {
        return (
            typeof details.inputToken === 'string' &&
            typeof details.outputToken === 'string' &&
            typeof details.amount === 'string' &&
            !isNaN(parseFloat(details.amount))
        );
    }

    private validateStrategyProposal(details: any): boolean {
        // Add strategy-specific validation
        return true; // Implement specific validation rules
    }

    private validateGovernanceProposal(details: any): boolean {
        // Add governance-specific validation
        return true; // Implement specific validation rules
    }

    private validateParameterChangeProposal(details: any): boolean {
        return (
            typeof details.parameterName === 'string' &&
            details.currentValue !== undefined &&
            details.proposedValue !== undefined
        );
    }

    constructor(runtime: ExtendedAgentRuntime) {
        super(runtime);
        
        // Initialize with environment-based defaults
        this.config = {
            quorum: parseInt(this.runtime.getSetting("quorumThreshold") || "3", 10),
            minimumYesVotes: parseInt(this.runtime.getSetting("minimumYesVotes") || "0", 10),
            minimumVotePercentage: parseInt(this.runtime.getSetting("minimumVotePercentage") || "50", 10),
            expiryDays: parseInt(this.runtime.getSetting("proposalExpiryDays") || "7", 10),
            maxProposalsPerUser: parseInt(this.runtime.getSetting("maxProposalsPerUser") || "3", 10)
        };

        // Override with agent config if present
        if (this.runtime.character?.agentConfig?.settings) {
            const configSettings = this.runtime.character.agentConfig.settings;
            if (typeof configSettings === 'object' && configSettings !== null) {
                this.config = {
                    ...this.config,
                    quorum: typeof configSettings.quorumThreshold === 'number' ? configSettings.quorumThreshold : this.config.quorum,
                    minimumYesVotes: typeof configSettings.minimumYesVotes === 'number' ? configSettings.minimumYesVotes : this.config.minimumYesVotes,
                    minimumVotePercentage: typeof configSettings.minimumVotePercentage === 'number' ? configSettings.minimumVotePercentage : this.config.minimumVotePercentage,
                    expiryDays: typeof configSettings.proposalExpiryDays === 'number' ? configSettings.proposalExpiryDays : this.config.expiryDays,
                    maxProposalsPerUser: typeof configSettings.maxProposalsPerUser === 'number' ? configSettings.maxProposalsPerUser : this.config.maxProposalsPerUser
                };
            }
        }
    }

    public override async initialize(): Promise<void> {
        try {
            await super.initialize();
            elizaLogger.info("ProposalAgent initialized");
        } catch (error) {
            elizaLogger.error("Error during ProposalAgent initialization:", error);
            throw error;
        }
    }

    public override async shutdown(): Promise<void> {
        try {
            await super.shutdown();
            elizaLogger.info("ProposalAgent shutdown complete");
        } catch (error) {
            elizaLogger.error("Error during ProposalAgent shutdown:", error);
            throw error;
        }
    }

    protected async validateAction(content: BaseContent): Promise<boolean> {
        if (!content || typeof content !== 'object') {
            return false;
        }

        switch (content.type) {
            case "proposal":
                return this.isValidProposalContent(content);
            case "vote_cast":
                return this.isValidVoteContent(content);
            default:
                return false;
        }
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        try {
            switch (content.type) {
                case "proposal":
                    if (this.isValidProposalContent(content)) {
                        await this.handleProposalEvent({
                            userId: this.runtime.agentId,
                            agentId: this.runtime.agentId,
                            content: content,
                            roomId: ROOM_IDS.DAO,
                            id: stringToUuid(`proposal-${content.id}`),
                            createdAt: Date.now()
                        });
                        return true;
                    } else {
                        elizaLogger.warn(`Invalid proposal content: ${JSON.stringify(content)}`);
                        return false;
                    }
                case "vote_cast":
                    if (this.isValidVoteContent(content)) {
                        await this.handleVoteEvent(content as VoteContent);
                        return true;
                    } else {
                        elizaLogger.warn(`Invalid vote content: ${JSON.stringify(content)}`);
                        return false;
                    }
                default:
                    elizaLogger.warn(`executeAction got unknown type ${content.type}`);
                    return false;
            }
        } catch (error) {
            elizaLogger.error("Error executing action:", error);
            return false;
        }
    }

    protected async handleMemory(memory: Memory): Promise<void> {
        const content = memory.content;
        
        // Handle message type separately since it needs the full memory object
        if (content.type === "message") {
            await this.handleMessage(memory as ExtendedAgentMessage);
            return;
        }

        // Handle all other memory types
        switch (content.type) {
            case "proposal":
                await this.handleProposalEvent(memory);
                // Check for expired proposals that need to be closed
                const proposalContent = content as ProposalContent;
                if (proposalContent.status === "open" && 
                    typeof proposalContent.deadline === "number" && 
                    proposalContent.deadline < Date.now()) {
                    await this.processCloseVote(
                        this.runtime.agentId,
                        String(proposalContent.shortId)
                    );
                }
                break;
                
            case "vote_cast":
                await this.handleVoteEvent(content as VoteContent);
                break;
                
            case "proposal_execution_result": {
                const executionResult = content as ProposalExecutionResult;
                const proposal = await findProposal(this.runtime, executionResult.proposalId);
                if (proposal) {
                    await this.handleProposalExecution(proposal, executionResult);
                }
                break;
            }
                
            case "proposal_status_changed":
                await this.handleStatusChange(content);
                break;
                
            case "proposal_monitoring":
                await this.handleMonitoringUpdate(content);
                break;

            case "distributed_lock":
                // Lock events are handled automatically by the lock system
                break;

            default:
                elizaLogger.warn(`Unhandled memory type in ProposalAgent: ${content.type}`);
        }
    }

    protected loadActions(): void {
        // Only register capabilities - memory handling is done in handleMemory
        this.registerCapability({
            name: "proposal_management",
            description: "Manage DAO proposals and voting",
            requiredPermissions: ["manage_proposals"],
            actions: ["propose", "vote", "close_vote"]
        });

        // Register shared actions
        this.runtime.registerAction(tokeninfo);
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // No cross-process events needed
    }

    protected async handleMessage(message: ExtendedAgentMessage): Promise<void> {
        try {
            const text = (message.content.text || "").trim();
            if (!text) return;

            // 1) user wants to create a new proposal
            if (/^!propose\b/i.test(text) || text.toLowerCase().includes("i propose")) {
                await this.handleProposeCommand(message);
                return;
            }

            // 2) user wants to check a proposal status
            if (/^!status\b/i.test(text) || /what(?:'s)? the status of/i.test(text)) {
                await this.handleCheckProposalStatus(message);
                return;
            }

            // 3) user wants to vote
            const voteResult = await this.detectVote(message);
            if (voteResult.isVote) {
                await this.handleVoteCommand(message, voteResult);
                return;
            }

            // 4) user wants to close voting
            const closeResult = await this.detectCloseVote(message);
            if (closeResult.isCloseRequest) {
                await this.handleCloseVoteCommand(message, closeResult);
                return;
            }

            // default or fallback
            elizaLogger.debug(`Unhandled message in ProposalAgent: ${text}`);
        } catch (error) {
            elizaLogger.error("Error in ProposalAgent.handleMessage:", error);
        }
    }

    private async handleProposeCommand(message: ExtendedAgentMessage): Promise<void> {
        const memoryManager = this.runtime.messageManager;
        
        try {
            await withTransaction(memoryManager as unknown as TransactionManager, async () => {
                // Convert user ID to UUID consistently
                const proposerId = stringToUuid(message.from);

                // Check user's existing proposals
                const proposals = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: 1000
                });

                // Filter user's existing proposals using consistent UUID comparison
                const userProposals = proposals.filter(mem => {
                    const content = mem.content as ProposalContent;
                    return content.type === "proposal" && 
                           (content.proposer === proposerId || 
                            (typeof content.proposer === 'string' && stringToUuid(content.proposer) === proposerId)) &&
                           ["open", "pending_execution"].includes(content.status as string);
                });

                if (userProposals.length >= this.config.maxProposalsPerUser) {
                    const activeProposalsList = userProposals.map(p => {
                        const content = p.content as ProposalContent;
                        return `- #${content.shortId}: ${content.title} (${content.status})`;
                    }).join('\n');

                    await this.sendMessage({
                        type: "agent_message",
                        content: {
                            type: "error",
                            id: stringToUuid(`error-${Date.now()}`),
                            text: `⚠️ You have reached the maximum limit of ${this.config.maxProposalsPerUser} active proposals.\n\n` +
                                  `Your current active proposals:\n${activeProposalsList}\n\n` +
                                  `To create a new proposal, please wait for your existing proposals to be executed or close them if they're no longer needed.\n` +
                                  `You can close a proposal by using: !close <proposal_id>`,
                            status: "failed",
                            agentId: this.runtime.agentId,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        },
                        from: this.runtime.agentType,
                        to: "ALL"
                    });
                    
                    return;
                }

                // Generate short ID and proposal ID
                const shortId = generateShortId();
                const proposalId = shortIdToUuid(shortId);

                // Interpret proposal using LLM
                const interpretation = await this.interpretProposal(message.content.text);
                if (!interpretation) {
                    throw new Error("Failed to interpret proposal");
                }

                // Create proposal content
                const proposal: ExtendedProposalContent = {
                    type: "proposal",
                    id: stringToUuid(`proposal-${shortId}`),
                    shortId,
                    title: interpretation.title,
                    description: interpretation.description,
                    text: message.content.text,
                    proposer: proposerId,
                    agentId: this.runtime.agentId,
                    status: "open",
                    yes: [],
                    no: [],
                    deadline: Date.now() + (this.config.expiryDays * 24 * 60 * 60 * 1000),
                    voteStats: {
                        total: 0,
                        yes: 0,
                        no: 0,
                        totalVotingPower: 0,
                        totalYesPower: 0,
                        totalNoPower: 0,
                        yesPowerPercentage: 0,
                        yesPercentage: 0,
                        quorumReached: false,
                        minimumYesVotesReached: false,
                        minimumPercentageReached: false
                    },
                    interpretation,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };

                // Create proposal memory
                const proposalMemory: Memory = {
                    id: stringToUuid(`proposal-${proposal.id}`),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        ...proposal,
                        updatedAt: Date.now()
                    },
                    roomId: ROOM_IDS.DAO,
                    createdAt: Date.now()
                };

                // Create initial status memory
                await memoryManager.createMemory({
                    id: stringToUuid(`status-${proposalId}`),
                    content: {
                        type: "proposal_status_changed",
                        proposalId,
                        status: proposal.status,
                        previousStatus: null,
                        text: `Proposal ${shortId} created and opened for voting`,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    roomId: ROOM_IDS.PROPOSAL,
                    userId: proposerId,
                    agentId: this.runtime.agentId
                });

                // Send response
                await this.sendMessage({
                    type: "agent_message",
                    content: {
                        type: "proposal_created",
                        id: stringToUuid(`response-${proposalId}`),
                        text: `📢 **New Proposal Created** #${shortId}\n\n` +
                              `**Title**: ${interpretation.title}\n\n` +
                              `**Description**: ${interpretation.description}\n\n` +
                              `**Type**: ${interpretation.type}\n` +
                              `**Status**: Open for voting\n` +
                              `**Required Votes**: ${this.config.quorum}\n\n` +
                              `Use !vote ${shortId} yes/no to vote on this proposal.`,
                        status: "executed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.runtime.agentType,
                    to: "ALL"
                });
            });
        } catch (error) {
            elizaLogger.error("Error in propose handler:", error);
            
            // Send a more specific error message
            const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
            this.sendMessage({
                type: "agent_message",
                content: {
                    type: "error",
                    id: stringToUuid(`error-${Date.now()}`),
                    text: `❌ Failed to create proposal: ${errorMessage}\n\n` +
                          `Please try again or contact support if the issue persists.`,
                    status: "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        }
    }

    private async handleCheckProposalStatus(message: ExtendedAgentMessage): Promise<void> {
        try {
            // Parse which proposal they're asking about
            const text = message.content.text.trim();
            const match = text.match(/^!status\s+(\w+)/i);
            let shortId = match ? match[1] : null;

            if (!shortId) {
                // Try to extract from natural language using LLM
                const context = composeContext({
                    state: {
                        message,
                        bio: "",
                        lore: "",
                        messageDirections: "",
                        postDirections: "",
                        roomId: stringToUuid("proposal"),
                        actors: "user,assistant",
                        recentMessages: "",
                        recentMessagesData: []
                    },
                    template: closeVoteDetectionTemplate
                });

                const result = await generateObject({
                    runtime: this.runtime,
                    context,
                    modelClass: ModelClass.SMALL
                }) as {proposalId?: string};

                if (result.proposalId) {
                    shortId = result.proposalId;
                }
            }

            if (!shortId) {
                await this.sendMessage({
                    type: "agent_message",
                    content: {
                        type: "error",
                        id: stringToUuid(`error-${Date.now()}`),
                        text: "Please specify a proposal ID (e.g. `!status abc123`).",
                        status: "failed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.runtime.agentType,
                    to: "ALL"
                });
                return;
            }

            // Find the proposal memory
            const proposals = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000
            });

            const proposalMem = proposals.find(mem =>
                mem.content.type === "proposal" &&
                mem.content.shortId === shortId
            );

            if (!proposalMem) {
                await this.sendMessage({
                    type: "agent_message",
                    content: {
                        type: "error",
                        id: stringToUuid(`error-${Date.now()}`),
                        text: `Proposal #${shortId} not found.`,
                        status: "failed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.runtime.agentType,
                    to: "ALL"
                });
                return;
            }

            const proposal = proposalMem.content as ExtendedProposalContent;

            // Build summary
            const yesCount = proposal.yes.length;
            const noCount = proposal.no.length;
            const now = Date.now();
            const timeLeft = (proposal.deadline as number) - now;
            const hoursLeft = Math.floor(timeLeft / 3600000);

            const statusMsg = `📊 **Proposal #${shortId}**\n\n` +
                            `**Title**: ${proposal.title}\n` +
                            `**Description**: ${proposal.description}\n\n` +
                            `**Status**: ${proposal.status.toUpperCase()}\n` +
                            `**Votes**:\n` +
                            `👍 Yes: ${yesCount}\n` +
                            `👎 No: ${noCount}\n\n` +
                            `**Time**: ${hoursLeft > 0 ? `${hoursLeft}h remaining` : "Expired"}`;

            await this.sendMessage({
                type: "agent_message",
                content: {
                    type: "proposal_status",
                    id: stringToUuid(`status-${shortId}`),
                    text: statusMsg,
                    status: "executed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });

        } catch (error) {
            elizaLogger.error("Error checking proposal status:", error);
            await this.sendMessage({
                type: "agent_message",
                content: {
                    type: "error",
                    id: stringToUuid(`error-${Date.now()}`),
                    text: "Sorry, I encountered an error checking the proposal status. Please try again.",
                    status: "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        }
    }

    // Vote Methods
    private async handleVoteCommand(memory: Memory, voteResult: any) {
        const memoryManager = this.runtime.messageManager;
        
        try {
            await withTransaction(memoryManager as unknown as TransactionManager, async () => {
                const result = await this.processVote(
                    memory.userId,
                    voteResult.proposalId,
                    voteResult.isYesVote
                );

                if (!result.success) {
                    throw new Error(result.error);
                }

                // Create vote memory
                await memoryManager.createMemory({
                    id: stringToUuid(`vote-${voteResult.proposalId}-${Date.now()}`),
                    content: {
                        type: "vote_cast",
                        proposalId: voteResult.proposalId,
                        voter: memory.userId,
                        vote: voteResult.isYesVote ? "yes" : "no",
                        timestamp: Date.now(),
                        text: `Vote recorded: ${voteResult.isYesVote ? "yes" : "no"} for proposal ${voteResult.proposalId}`
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });

                // Send response
                await this.sendMessage({
                    type: "agent_message",
                    content: {
                        type: "vote_recorded",
                        id: stringToUuid(`vote-${voteResult.proposalId}-${Date.now()}`),
                        text: `✅ Vote recorded for proposal #${voteResult.proposalId}!\n` +
                              `Current votes:\n` +
                              `👍 Yes: ${result.yesCount}\n` +
                              `👎 No: ${result.noCount}`,
                        status: "executed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.runtime.agentType,
                    to: "ALL"
                });
            });
        } catch (error) {
            elizaLogger.error("Error in vote handler:", error);
            this.sendMessage({
                type: "agent_message",
                content: {
                    type: "error",
                    id: stringToUuid(`error-${Date.now()}`),
                    text: `Failed to process vote: ${error instanceof Error ? error.message : String(error)}`,
                    status: "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        }
    }

    // Close Vote Methods
    private async handleCloseVoteCommand(memory: Memory, closeResult: any) {
        const memoryManager = this.runtime.messageManager;
        
        try {
            await withTransaction(memoryManager as unknown as TransactionManager, async () => {
                const result = await this.processCloseVote(
                    memory.userId,
                    String((closeResult.proposalId as string) || '')
                );

                if (!result.success) {
                    throw new Error(result.error);
                }

                // Send response
                await this.sendMessage({
                    type: "agent_message",
                    content: {
                        type: "proposal_closed",
                        id: stringToUuid(`status-${closeResult.proposalId}-${Date.now()}`),
                        text: `📊 Proposal #${closeResult.proposalId} voting has ended!\n\n` +
                              `Final results:\n` +
                              `👍 Yes: ${result.yesCount}\n` +
                              `👎 No: ${result.noCount}\n\n` +
                              `Result: ${result.result}`,
                        status: "executed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.runtime.agentType,
                    to: "ALL"
                });
            });
        } catch (error) {
            elizaLogger.error("Error in close vote handler:", error);
            this.sendMessage({
                type: "agent_message",
                content: {
                    type: "error",
                    id: stringToUuid(`error-${Date.now()}`),
                    text: `Failed to close vote: ${error instanceof Error ? error.message : String(error)}`,
                    status: "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        }
    }

    // Helper Methods
    private async interpretProposal(text: string): Promise<ProposalInterpretation> {
        try {
            const result = await this.retryLLMValidation<ProposalInterpretation>(
                async () => {
                    const context = composeContext({
                        state: {
                            message: { content: { text } },
                            bio: "",
                            lore: "",
                            messageDirections: "",
                            postDirections: "",
                            roomId: stringToUuid("proposal"),
                            actors: "user,assistant",
                            recentMessages: "",
                            recentMessagesData: []
                        },
                        template: proposalInterpretTemplate
                    });

                    return await generateObject({
                        runtime: this.runtime,
                        context,
                        modelClass: ModelClass.SMALL
                    });
                },
                this.proposalSchema,
                {
                    maxRetries: 3,
                    requireAllFields: true,
                    customValidator: (data) => this.isValidProposalInterpretation(data)
                }
            );

            if (!result.isValid || !result.data) {
                throw new Error(
                    `Invalid proposal format: ${result.error}\n` +
                    `Validation errors:\n${result.validationErrors?.map(e => 
                        `- ${e.field}: ${e.error}`
                    ).join('\n')}`
                );
            }

            return result.data;

        } catch (error) {
            // Check error message pattern instead of instanceof
            if (error instanceof Error && error.message.includes('LLM validation')) {
                throw new Error(
                    `Failed to interpret proposal after multiple attempts.\n` +
                    `Please try rephrasing your proposal with clearer details.\n\n` +
                    `Error: ${error.message}`
                );
            }
            throw error;
        }
    }

    private async detectVote(memory: Memory): Promise<any> {
        const context = composeContext({
            state: {
                message: memory,
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                roomId: stringToUuid("proposal"),
                actors: "user,assistant",
                recentMessages: "",
                recentMessagesData: []
            },
            template: voteDetectionTemplate
        });

        return await generateObject({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        }) as {proposalId?: string};
    }

    private async detectCloseVote(memory: Memory): Promise<any> {
        const context = composeContext({
            state: {
                message: memory,
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                roomId: stringToUuid("proposal"),
                actors: "user,assistant",
                recentMessages: "",
                recentMessagesData: []
            },
            template: closeVoteDetectionTemplate
        });

        return await generateObject({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        }) as {proposalId?: string};
    }

    private async getUserVotingPower(userId: UUID): Promise<number> {
        try {
            // Attempt to get user profile from the userProfile agent's memory
            const profiles = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000
            });
            
            // Filter for user_profile with matching userId
            const userProfileMem = profiles.find(mem =>
                mem.content.type === "user_profile" &&
                mem.content.userId === userId
            );
            
            if (!userProfileMem) {
                elizaLogger.warn(`No user profile found for ${userId}, defaulting to 1 voting power`);
                return 1;
            }

            const userProfile = userProfileMem.content;
            
            // If profile has explicit votingPower field, use that
            if (typeof userProfile.votingPower === "number") {
                return userProfile.votingPower;
            }

            // Calculate voting power based on reputation and deposits
            let votingPower = 1; // Base voting power

            // Add reputation-based power (square root scaling)
            if (typeof userProfile.reputation === "number") {
                votingPower += Math.sqrt(userProfile.reputation);
            }

            // Add deposit-based power
            if (Array.isArray(userProfile.totalDeposits)) {
                const totalUsdValue = userProfile.totalDeposits.reduce((sum, deposit) => {
                    return sum + (deposit.usdValue ? Number(deposit.usdValue) : 0);
                }, 0);
                // Add 1 voting power per $100 deposited
                votingPower += totalUsdValue / 100;
            }

            // Round to 2 decimal places for cleaner numbers
            return Math.round(votingPower * 100) / 100;

        } catch (err) {
            elizaLogger.warn("Error fetching user voting power, defaulting to 1:", err);
            return 1;
        }
    }

    private async getAvailablePowerInActiveVotes(
        userId: UUID,
        totalPower: number
    ): Promise<number> {
        try {
            // Get all active proposals
            const activeProposals = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000
            });

            // Calculate power used in active votes
            let powerUsed = 0;
            for (const proposalMem of activeProposals) {
                const proposal = proposalMem.content as ProposalContent;
                if (proposal.type !== "proposal" || proposal.status !== "open") continue;

                // Check yes votes
                const userYesVote = proposal.yes.find(v => v.userId === userId);
                if (userYesVote?.votingPower) {
                    powerUsed += userYesVote.votingPower;
                }

                // Check no votes
                const userNoVote = proposal.no.find(v => v.userId === userId);
                if (userNoVote?.votingPower) {
                    powerUsed += userNoVote.votingPower;
                }
            }

            // Calculate remaining power
            const availablePower = Math.max(0, totalPower - powerUsed);
            elizaLogger.debug(`User ${userId} voting power: total=${totalPower}, used=${powerUsed}, available=${availablePower}`);
            
            return availablePower;
        } catch (error) {
            elizaLogger.error(`Error calculating available voting power for user ${userId}:`, error);
            return 0;
        }
    }

    private async processVote(
        userId: string,
        proposalId: string,
        isYesVote: boolean
    ): Promise<{ success: boolean; error?: string; yesCount?: number; noCount?: number }> {
        return this.withTransaction('processVote', async () => {
            try {
                // Convert proposalId to UUID
                const proposalUuid = stringToUuid(proposalId);

                // 1) Lock the main proposal memory
                const proposalMem = await this.runtime.messageManager.getMemoryWithLock(proposalUuid);
                if (!proposalMem) {
                    return { success: false, error: "Proposal not found" };
                }

                const proposal = proposalMem.content as ExtendedProposalContent;
                const currentVersion = proposal.metadata?.voteVersion || 0;
                
                // Validate vote
                if (proposal.status !== "open") {
                    return { success: false, error: "This proposal is no longer open for voting" };
                }

                if (proposal.deadline < Date.now()) {
                    // If expired, trigger close vote process and return error
                    await this.processCloseVote(this.runtime.agentId, proposalId);
                    return { success: false, error: "This proposal has expired and is being closed" };
                }

                // Check for existing votes
                const existingYesVote = proposal.yes.find(v => v.userId === userId);
                const existingNoVote = proposal.no.find(v => v.userId === userId);
                if (existingYesVote || existingNoVote) {
                    return { success: false, error: `User ${userId} already voted` };
                }

                // Get user's voting power
                const userUuid = stringToUuid(userId);
                const latestVotingPower = await this.getUserVotingPower(userUuid);
                const availablePower = await this.getAvailablePowerInActiveVotes(userUuid, latestVotingPower);

                if (availablePower <= 0) {
                    return { success: false, error: "You have used all your voting power in active proposals" };
                }

                // Create new vote
                const vote: Vote = {
                    userId: userUuid,
                    votingPower: availablePower,
                    timestamp: Date.now()
                };

                // Update votes arrays
                const updatedYes = isYesVote ? [...proposal.yes, vote] : proposal.yes;
                const updatedNo = !isYesVote ? [...proposal.no, vote] : proposal.no;

                // Calculate new vote stats
                const totalYesPower = updatedYes.reduce((sum, v) => sum + v.votingPower, 0);
                const totalNoPower = updatedNo.reduce((sum, v) => sum + v.votingPower, 0);
                const totalVotingPower = totalYesPower + totalNoPower;

                const voteStats = {
                    total: updatedYes.length + updatedNo.length,
                    yes: updatedYes.length,
                    no: updatedNo.length,
                    totalVotingPower,
                    totalYesPower,
                    totalNoPower,
                    yesPowerPercentage: totalVotingPower > 0 ? (totalYesPower / totalVotingPower) * 100 : 0,
                    yesPercentage: (updatedYes.length / (updatedYes.length + updatedNo.length)) * 100,
                    quorumReached: totalVotingPower >= this.config.quorum,
                    minimumYesVotesReached: updatedYes.length >= this.config.minimumYesVotes,
                    minimumPercentageReached: (totalYesPower / totalVotingPower) * 100 >= this.config.minimumVotePercentage
                };

                // Create new version in _versions table
                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(`${proposalUuid}-v${currentVersion}`),
                    content: {
                        ...proposal,
                        metadata: {
                            ...proposal.metadata,
                            versionReason: `Vote recorded at version ${currentVersion}`
                        }
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });

                // Update main proposal with new version
                const updatedProposal = {
                    ...proposal,
                    yes: updatedYes,
                    no: updatedNo,
                    voteStats,
                    metadata: {
                        ...proposal.metadata,
                        voteVersion: currentVersion + 1,
                        lastVoteAt: Date.now()
                    },
                    updatedAt: Date.now()
                };

                // Save updated proposal
                await this.runtime.messageManager.createMemory({
                    id: proposalMem.id,
                    content: updatedProposal,
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    unique: true
                });

                // Create vote record
                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(`vote-${proposalUuid}-${userId}-${Date.now()}`),
                    content: {
                        type: "vote_cast",
                        proposalId: proposalUuid,
                        voter: userUuid,
                            vote: isYesVote ? "yes" : "no",
                            votingPower: availablePower,
                        timestamp: Date.now(),
                        text: `Vote cast: ${isYesVote ? "yes" : "no"} for proposal ${proposalUuid}`,
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: "executed",
                        metadata: {
                            voteVersion: currentVersion + 1
                        }
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });

                return {
                    success: true,
                    yesCount: updatedYes.length,
                    noCount: updatedNo.length
                };

            } catch (error) {
                elizaLogger.error(`Error processing vote:`, error);
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        });
    }

    private async processCloseVote(
        userId: string,
        proposalId: string
    ): Promise<{ success: boolean; error?: string; yesCount?: number; noCount?: number; result?: string }> {
        // 1) Try to acquire a lock on this proposal using base class's distributed lock
        const lockKey = `proposal-close-${proposalId}`;
        const lock = await this.acquireDistributedLock(lockKey);
        if (!lock) {
            return { success: false, error: "Another user is already closing this proposal. Please wait." };
        }

        try {
            const now = Date.now();
            
            // Find proposal using consistent ID handling
            const proposal = await findProposal(this.runtime, proposalId);
            if (!proposal) {
                return { success: false, error: "Proposal not found" };
            }

            if (proposal.status !== "open") {
                return { success: false, error: "This proposal is already closed" };
            }

            // Convert userId to UUID consistently
            const userUuid = stringToUuid(userId);

            // Check if user has permission to close the vote
            const canClose = await this.canCloseVote(userUuid, proposal);
            if (!canClose.allowed) {
                return { success: false, error: canClose.reason };
            }

            const yesCount = proposal.yes.length;
            const noCount = proposal.no.length;
            const totalVotes = yesCount + noCount;

            // Determine result using configured requirements
            let result: string;
            let newStatus: ContentStatus;

            if (totalVotes < this.config.minimumYesVotes) {
                result = "REJECTED_INSUFFICIENT_VOTES";
                newStatus = "rejected";
            } else if (yesCount <= noCount) {
                result = "REJECTED_MAJORITY_NO";
                newStatus = "rejected";
            } else {
                result = "PASSED";
                newStatus = "pending_execution";
            }

            // Update proposal status and timestamps
            proposal.status = newStatus;
            proposal.updatedAt = now;
            proposal.closedAt = now;
            proposal.result = result;

            // Update metadata with close information
            if (!proposal.metadata) {
                proposal.metadata = {};
            }
            proposal.metadata = {
                ...proposal.metadata,
                closedBy: userUuid,
                closeTimestamp: now,
                lastUpdated: now
            } as ProposalMetadata;

            // Save updated proposal using consistent timestamps
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`proposal-${proposal.shortId}`),
                content: {
                    ...proposal,
                    updatedAt: now
                },
                roomId: ROOM_IDS.DAO,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            // Create status change record with consistent timestamps
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`status-${proposal.shortId}-${now}`),
                content: {
                    type: "proposal_status_changed",
                    proposalId: proposal.id,
                    status: newStatus,
                    previousStatus: "open",
                    text: `Proposal ${proposal.shortId} ${result.toLowerCase()}`,
                    createdAt: now,
                    updatedAt: now,
                    agentId: this.runtime.agentId
                },
                roomId: ROOM_IDS.PROPOSAL,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            return {
                success: true,
                yesCount,
                noCount,
                result
            };

        } finally {
            // 2) Always release the distributed lock, success or fail
            if (lock) {
                await this.releaseDistributedLock(lock);
            }
        }
    }

    /**
     * Check if a user has permission to close a vote.
     * A user can close a vote if any of these conditions are met:
     * 1. They are an admin
     * 2. They are the original proposer
     * 3. They have the required role specified in proposal metadata
     * 4. They have sufficient reputation if minReputation is specified
     * 5. The proposal has expired (anyone can close it)
     */
    private async canCloseVote(userId: UUID, proposal: ExtendedProposalContent): Promise<{ allowed: boolean; reason?: string }> {
        // Always allow if proposal has expired
        const deadline = proposal.deadline;
        if (typeof deadline !== 'number') {
            elizaLogger.warn("Invalid deadline type in proposal");
            return { allowed: false, reason: "Invalid proposal deadline" };
        }
        if (deadline < Date.now()) {
            return { allowed: true };
        }

        // Get user profile for role and reputation checks
        const userProfile = await this.getUserProfile(userId);

        // Admin override - always allow admins to close votes
        if (userProfile?.role === "admin") {
            return { allowed: true };
        }

        // Always allow the original proposer
        if (proposal.proposer === userId) {
            return { allowed: true };
        }

        // Check required role if specified
        const metadata = proposal.metadata;
        if (metadata?.requiredRole) {
            if (!userProfile?.role) {
                return { 
                    allowed: false, 
                    reason: `Only users with ${metadata.requiredRole} role can close this proposal`
                };
            }
            
            // Check if user has the required role or higher
            const roles = ["user", "moderator", "admin"];
            const requiredRoleIndex = roles.indexOf(metadata.requiredRole);
            const userRoleIndex = roles.indexOf(userProfile.role);
            
            if (requiredRoleIndex === -1 || userRoleIndex === -1 || userRoleIndex < requiredRoleIndex) {
                return { 
                    allowed: false, 
                    reason: `Only users with ${metadata.requiredRole} role or higher can close this proposal`
                };
            }
            return { allowed: true };
        }

        // Check minimum reputation if specified
        if (metadata?.minReputation) {
            const userReputation = userProfile?.reputation || 0;
            if (userReputation < metadata.minReputation) {
                return { 
                    allowed: false, 
                    reason: `Minimum reputation of ${metadata.minReputation} required to close this proposal`
                };
            }
            return { allowed: true };
        }

        // If no special permissions are required, only allow if expired
        return { 
            allowed: false, 
            reason: "Only the proposer, admins, or users with required permissions can close this proposal before deadline"
        };
    }

    protected async getUserProfile(userId: UUID): Promise<{ role?: string; reputation?: number } | null> {
        try {
            const profiles = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000
            });
            
            const userProfileMem = profiles.find(mem =>
                mem.content.type === "user_profile" &&
                mem.content.userId === userId
            );
            
            if (!userProfileMem) {
                return null;
            }

            const content = userProfileMem.content as { role?: unknown; reputation?: unknown };
            if (typeof content.role !== 'string' && content.role !== undefined) {
                elizaLogger.warn("Invalid role type in user profile");
                return null;
            }
            if (typeof content.reputation !== 'number' && content.reputation !== undefined) {
                elizaLogger.warn("Invalid reputation type in user profile");
                return null;
            }

            return {
                role: content.role as string | undefined,
                reputation: content.reputation as number | undefined
            };
        } catch (err) {
            elizaLogger.warn("Error fetching user profile:", err);
            return null;
        }
    }

    // Event Handlers
    private async handleProposalEvent(memory: Memory): Promise<void> {
        // Handle proposal lifecycle events
        elizaLogger.debug("Handling proposal event:", memory);
    }

    private async handleVoteEvent(content: VoteContent): Promise<void> {
        // Handle vote events
        elizaLogger.debug("Handling vote event:", content);
    }

    private isValidProposalContent(content: any): boolean {
        // Basic type checks
        if (!content || typeof content !== 'object') return false;

        // Required base fields
        const hasBaseFields = 
            'type' in content &&
            content.type === 'proposal' &&
            'id' in content &&
            'title' in content &&
            'description' in content &&
            'proposer' in content &&
            'status' in content &&
            'deadline' in content &&
            typeof content.title === 'string' &&
            typeof content.description === 'string' &&
            typeof content.proposer === 'string' &&
            typeof content.deadline === 'number';

        if (!hasBaseFields) return false;

        // Vote arrays validation
        const hasValidVoteArrays =
            Array.isArray(content.yes) &&
            Array.isArray(content.no) &&
            content.yes.every((vote: any) => this.isValidVote(vote)) &&
            content.no.every((vote: any) => this.isValidVote(vote));

        if (!hasValidVoteArrays) return false;

        // Vote stats validation
        const hasValidVoteStats =
            'voteStats' in content &&
            typeof content.voteStats === 'object' &&
            content.voteStats !== null &&
            'total' in content.voteStats &&
            'yes' in content.voteStats &&
            'no' in content.voteStats &&
            'totalVotingPower' in content.voteStats &&
            'totalYesPower' in content.voteStats &&
            'totalNoPower' in content.voteStats &&
            'yesPowerPercentage' in content.voteStats &&
            'quorumReached' in content.voteStats &&
            'minimumYesVotesReached' in content.voteStats &&
            'minimumPercentageReached' in content.voteStats &&
            typeof content.voteStats.total === 'number' &&
            typeof content.voteStats.yes === 'number' &&
            typeof content.voteStats.no === 'number' &&
            typeof content.voteStats.totalVotingPower === 'number' &&
            typeof content.voteStats.totalYesPower === 'number' &&
            typeof content.voteStats.totalNoPower === 'number' &&
            typeof content.voteStats.yesPowerPercentage === 'number' &&
            typeof content.voteStats.quorumReached === 'boolean' &&
            typeof content.voteStats.minimumYesVotesReached === 'boolean' &&
            typeof content.voteStats.minimumPercentageReached === 'boolean';

        return hasValidVoteStats;
    }

    private isValidVote(vote: any): boolean {
        return (
            typeof vote === 'object' &&
            vote !== null &&
            'userId' in vote &&
            'votingPower' in vote &&
            'timestamp' in vote &&
            typeof vote.userId === 'string' &&
            typeof vote.votingPower === 'number' &&
            typeof vote.timestamp === 'number'
        );
    }

    private isValidVoteContent(content: any): boolean {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'vote_cast' &&
            'agentId' in content &&
            'metadata' in content &&
            typeof content.metadata === 'object' &&
            'proposalId' in content.metadata &&
            'vote' in content.metadata &&
            'votingPower' in content.metadata &&
            'timestamp' in content.metadata;
    }

    public async handleReaction(reaction: MessageReaction, user: User, added: boolean): Promise<void> {
        try {
            // Skip bot reactions
            if (user.bot) return;

            // Only handle 👍 and 👎 reactions
            const emojiName = reaction.emoji.name;
            if (!emojiName || (emojiName !== '👍' && emojiName !== '👎')) return;

            // Get proposal ID first to use in lock
            const proposals = await this.runtime.messageManager.getMemories({
                roomId: this.runtime.agentId,
                count: 1000,
            });

            const proposalMem = proposals.find(mem => {
                return mem.content.type === "proposal" &&
                       (mem.content as ProposalContent).messageId === reaction.message.id;
            });

            if (!proposalMem) return;

            const proposalId = (proposalMem.content as ProposalContent).shortId;
            const lockKey = `proposal-vote-${proposalId}-${user.id}`;

            // Acquire lock for this specific user's vote on this proposal
            const lock = await this.acquireDistributedLock(lockKey);
            if (!lock) {
                elizaLogger.warn(`Failed to acquire lock for vote processing: ${lockKey}`);
                // Remove the reaction since we couldn't process it
                await reaction.users.remove(user);
                return;
            }

            try {
                await withTransaction(this.runtime.messageManager as unknown as TransactionManager, async () => {
                    // Re-fetch proposal after acquiring lock to ensure latest state
                    const updatedProposals = await this.runtime.messageManager.getMemories({
                        roomId: this.runtime.agentId,
                        count: 1000,
                    });

                    const updatedProposalMem = updatedProposals.find(mem => {
                        return mem.content.type === "proposal" &&
                               (mem.content as ProposalContent).messageId === reaction.message.id;
                    });

                    if (!updatedProposalMem) {
                        throw new Error("Proposal no longer exists");
                    }

                    const proposal = updatedProposalMem.content as ExtendedProposalContent;

                    // Check if proposal is still open
                    if (proposal.status !== "open") {
                        throw new Error("Proposal is no longer open for voting");
                    }

                    // Process the vote atomically
                    const result = await this.processVote(
                        user.id,
                        String(proposalId),
                        emojiName === '👍'
                    );

                    if (!result.success) {
                        throw new Error(result.error || "Vote processing failed");
                    }

                    // If this was a new reaction and there was an opposite reaction, remove it
                    if (added) {
                        const oppositeEmoji = emojiName === '👍' ? '👎' : '👍';
                        const oppositeReaction = reaction.message.reactions.cache.find(r => 
                            r.emoji.name === oppositeEmoji
                        );
                        if (oppositeReaction) {
                            await oppositeReaction.users.remove(user).catch(err => {
                                elizaLogger.warn(`Failed to remove opposite reaction: ${err}`);
                            });
                        }
                    }
                });
            } catch (error) {
                // If anything fails, remove the reaction that triggered this
                await reaction.users.remove(user).catch(err => {
                    elizaLogger.error(`Failed to remove reaction after error: ${err}`);
                });
                elizaLogger.error("Error processing vote:", error);
            }
        } catch (error) {
            elizaLogger.error("Error in reaction handler:", error);
            // Try to remove the reaction in case of top-level errors
            try {
                await reaction.users.remove(user);
            } catch (removeError) {
                elizaLogger.error("Failed to remove reaction after error:", removeError);
            }
        }
    }

    private async calculateVotePower(userId: UUID): Promise<VotePower> {
        return {
            votingPower: 1,
            timestamp: Date.now()
        };
    }

    private async hasClosePermission(userId: UUID): Promise<boolean> {
        return true;
    }

    private async updateVoteStats(proposal: ExtendedProposalContent): Promise<void> {
        try {
            const stats: VoteStats = {
                total: proposal.yes.length + proposal.no.length,
                yes: proposal.yes.length,
                no: proposal.no.length,
                totalVotingPower: 0,
                totalYesPower: 0,
                totalNoPower: 0,
                yesPowerPercentage: 0,
                yesPercentage: 0,
                quorumReached: false,
                minimumYesVotesReached: false,
                minimumPercentageReached: false
            };

            // Calculate voting power totals
            stats.totalYesPower = proposal.yes.reduce((sum, vote) => sum + (vote.votingPower || 0), 0);
            stats.totalNoPower = proposal.no.reduce((sum, vote) => sum + (vote.votingPower || 0), 0);
            stats.totalVotingPower = stats.totalYesPower + stats.totalNoPower;

            // Calculate percentage
            stats.yesPowerPercentage = stats.totalVotingPower > 0 
                ? (stats.totalYesPower / stats.totalVotingPower) * 100 
                : 0;
            stats.yesPercentage = stats.total > 0 
                ? (stats.yes / stats.total) * 100 
                : 0;

            // Check against thresholds from config
            stats.quorumReached = stats.totalVotingPower >= this.config.quorum;
            stats.minimumYesVotesReached = stats.yes >= this.config.minimumYesVotes;
            stats.minimumPercentageReached = stats.yesPowerPercentage >= this.config.minimumVotePercentage;

            // Update proposal stats
            proposal.voteStats = stats;
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`vote-stats-${proposal.id}`),
                content: proposal,
                roomId: ROOM_IDS.DAO,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error("Error updating vote stats:", error);
            throw error;
        }
    }

    private async handleProposalExecution(proposal: ExtendedProposalContent, executionResult: ProposalExecutionResult): Promise<void> {
        const memoryManager = this.runtime.messageManager;
        const now = Date.now();
        
        try {
            await withTransaction(memoryManager as unknown as TransactionManager, async () => {
                // Re-fetch proposal to ensure latest state
                const updatedProposal = await findProposal(this.runtime, String(proposal.shortId));
                if (!updatedProposal) {
                    throw new Error(`Proposal ${proposal.shortId} not found during execution update`);
                }

                // Ensure deadline hasn't been modified
                if (updatedProposal.deadline !== proposal.deadline) {
                    elizaLogger.warn(`Attempt to modify proposal ${proposal.shortId} deadline detected. Reverting to original deadline.`);
                    updatedProposal.deadline = proposal.deadline;
                }

                // Validate state transition based on execution result
                let newStatus: ContentStatus;
                if (executionResult.success) {
                    // Handle parameter change proposals
                    if (updatedProposal.interpretation?.type === "parameter_change") {
                        const details = updatedProposal.interpretation.details as unknown as {
                            target: string;
                            currentValue: any;
                            proposedValue: any;
                            agentType: string;
                            description?: string;
                        };
                        try {
                            // Create parameter change record
                            await memoryManager.createMemory({
                                id: stringToUuid(`param-change-${updatedProposal.id}-${now}`),
                                content: {
                                    type: "parameter_change_record",
                                    proposalId: updatedProposal.id,
                                    target: details.target,
                                    previousValue: details.currentValue,
                                    newValue: details.proposedValue,
                                    agentType: details.agentType,
                                    timestamp: now,
                                    text: `Parameter ${details.target} changed from ${details.currentValue} to ${details.proposedValue} for ${details.agentType}`,
                                    status: "pending",
                                    agentId: this.runtime.agentId,
                                    createdAt: now,
                                    updatedAt: now
                                },
                                roomId: ROOM_IDS.DAO,
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId
                            });

                            // Broadcast parameter change event
                            const event: DAOEvent = {
                                type: "proposal_executed",
                                id: stringToUuid(`param-event-${updatedProposal.id}`),
                                eventId: stringToUuid(`param-event-${updatedProposal.id}`),
                                sourceAgent: this.runtime.agentType,
                                sourceId: this.runtime.agentId,
                                agentId: this.runtime.agentId,
                                target: details.target,
                                value: details.proposedValue,
                                agentType: details.agentType,
                                proposalId: updatedProposal.id,
                                timestamp: now,
                                details: {
                                    previousValue: details.currentValue,
                                    reason: updatedProposal.description,
                                    parameterChange: {
                                        target: details.target,
                                        value: details.proposedValue,
                                        agentType: details.agentType
                                    }
                                },
                                text: `Parameter ${details.target} updated for ${details.agentType}`,
                                status: "executed",
                                createdAt: now,
                                updatedAt: now
                            };
                            await this.broadcastEvent(event);

                            // Update agent settings memory
                            await memoryManager.createMemory({
                                id: stringToUuid(`agent-settings-${details.agentType}-${now}`),
                                content: {
                                    type: "agent_settings",
                                    agentType: details.agentType,
                                    settings: {
                                        [details.target]: details.proposedValue
                                    },
                                    text: `Updated ${details.target} setting for ${details.agentType}`,
                                    status: "executed",
                                    agentId: this.runtime.agentId,
                                    createdAt: now,
                                    updatedAt: now
                                },
                                roomId: ROOM_IDS.DAO,
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId
                            });

                            elizaLogger.info(`Parameter change executed: ${details.target} = ${details.proposedValue} for ${details.agentType}`);
                        } catch (error) {
                            elizaLogger.error(`Failed to execute parameter change:`, error);
                            throw new Error(`Parameter change failed: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }

                    // Rest of the existing execution logic...
                    switch (updatedProposal.status) {
                        case "pending_execution":
                            newStatus = "executing";
                            break;
                        case "executing":
                            newStatus = "executed";
                            break;
                        default:
                            throw new Error(`Invalid state transition from ${updatedProposal.status} for successful execution`);
                    }
                } else {
                    newStatus = "failed";
                    elizaLogger.warn(`Proposal ${proposal.shortId} execution failed: ${executionResult.error}`);
                }

                // Validate the state transition
                const transitionResult = isValidStatusTransition(updatedProposal.status, newStatus, updatedProposal);
                if (!transitionResult.valid) {
                    throw new Error(`Invalid state transition: ${transitionResult.reason}`);
                }

                // Update proposal status and timestamps
                updatedProposal.status = newStatus;
                updatedProposal.updatedAt = now;
                if (newStatus === "executed" || newStatus === "failed") {
                    updatedProposal.closedAt = now;
                }

                // Add execution result to proposal metadata
                if (!updatedProposal.metadata) {
                    updatedProposal.metadata = {};
                }
                
                // Store execution result in a way that preserves existing metadata
                const metadata = {
                    ...updatedProposal.metadata,
                    success: executionResult.success,
                    error: executionResult.error,
                    executedBy: executionResult.executedBy,
                    timestamp: executionResult.timestamp,
                    lastUpdated: now
                };
                updatedProposal.metadata = metadata;

                // Create status change memory with consistent timestamps
                await memoryManager.createMemory({
                    id: stringToUuid(`status-${proposal.id}-${now}`),
                    content: {
                        type: "proposal_status_changed",
                        proposalId: proposal.id,
                        status: newStatus,
                        previousStatus: proposal.status,
                        text: executionResult.success 
                            ? `Proposal ${proposal.shortId} ${newStatus}`
                            : `Proposal ${proposal.shortId} execution failed: ${executionResult.error}`,
                        createdAt: now,
                        updatedAt: now,
                        agentId: this.runtime.agentId
                    },
                    roomId: ROOM_IDS.PROPOSAL,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });

                // Update the proposal with consistent timestamps
                await memoryManager.createMemory({
                    id: stringToUuid(`proposal-${proposal.id}`),
                    content: {
                        ...updatedProposal,
                        updatedAt: now
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });

                // If execution failed, notify relevant parties
                if (!executionResult.success) {
                    await this.setupFailedProposalMonitoring(proposal.id);
                }
            });
        } catch (error) {
            elizaLogger.error("Error in proposal execution:", error);
            throw error;
        }
    }

    private async setupFailedProposalMonitoring(proposalId: UUID): Promise<void> {
        try {
            const now = Date.now();
            const monitoringId = stringToUuid(`monitor-${proposalId}`);

            // Create a monitoring memory to track the failed proposal
            const monitoringMemory = await this.runtime.messageManager.createMemory({
                id: monitoringId,
                content: {
                    type: "proposal_monitoring",
                    proposalId,
                    status: "monitoring",
                    retryCount: 0,
                    maxRetries: 3,
                    nextRetryTime: now + (5 * 60 * 1000),
                    text: `Monitoring failed proposal ${proposalId} for retry`,
                    createdAt: now,
                    updatedAt: now
                },
                roomId: ROOM_IDS.PROPOSAL,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            // Initialize last processed state with this memory
            this.lastProcessedMonitoring = {
                timestamp: now,
                id: monitoringId
            };

        } catch (error) {
            elizaLogger.error(`Error setting up failed proposal monitoring for ${proposalId}:`, error);
        }
    }

    protected async acquireDistributedLock(key: string, timeoutMs: number = 30000): Promise<DistributedLock | null> {
        return await this.withTransaction('acquireLock', async () => {
            const now = Date.now();
            const expiresAt = now + timeoutMs;
            const lockId = stringToUuid(`lock-${key}-${now}`);

            try {
                // First, get and remove any expired locks for this key
                const expiredLocks = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: 100
                });

                // Filter and remove expired locks within the same transaction
                for (const lock of expiredLocks) {
                    const content = lock.content as any;
                    if (content.type === "distributed_lock" && 
                        content.key === key && 
                        (content.expiresAt <= now || content.lockState !== 'active')) {
                        await this.runtime.messageManager.removeMemory(lock.id);
                    }
                }

                // Try to insert the lock directly as active
                await this.runtime.messageManager.createMemory({
                    id: lockId,
                    content: {
                        type: "distributed_lock",
                        key,
                        holder: this.runtime.agentId,
                        expiresAt,
                        lockId,
                        version: 1,
                        lastRenewalAt: now,
                        renewalCount: 0,
                        lockState: 'active',
                        acquiredAt: now,
                        text: `Lock ${key} acquired by ${this.runtime.agentId}`,
                        agentId: this.runtime.agentId,
                        createdAt: now,
                        updatedAt: now,
                        status: "executed"
                    },
                    roomId: ROOM_IDS.DAO,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    unique: true
                });

                // If we get here, we successfully acquired the lock
                return {
                    key,
                    holder: this.runtime.agentId,
                    expiresAt,
                    lockId,
                    version: 1
                };

            } catch (error) {
                if (error.message?.includes('unique constraint')) {
                    // Lock already exists and is active
                    return null;
                }
                throw error;
            }
        });
    }

    protected async releaseDistributedLock(lock: DistributedLock): Promise<void> {
        await this.withTransaction('releaseLock', async () => {
            try {
                // First verify we still hold the lock
                const currentLock = await this.runtime.messageManager.getMemoryWithLock(
                    stringToUuid(`lock-${lock.key}-${lock.lockId}`)
                );

                if (!currentLock) {
                    return; // Lock already released or expired
                }

                const content = currentLock.content as any;
                if (content.holder !== this.runtime.agentId || 
                    content.lockState !== 'active' || 
                    content.expiresAt <= Date.now()) {
                    return; // We don't own the lock anymore
                }

                // Remove the lock if we still own it
                await this.runtime.messageManager.removeMemory(currentLock.id);

            } catch (error) {
                elizaLogger.error(`Error releasing lock for ${lock.key}:`, error);
                throw error;
            }
        });
    }

    private async handleStatusChange(content: Content): Promise<void> {
        const statusContent = content as ProposalStatusContent;
        elizaLogger.info(`Proposal ${statusContent.proposalId} status changed from ${statusContent.previousStatus} to ${statusContent.status}`);
        
        // Notify relevant subscribers or update UI if needed
        await this.sendMessage({
            type: "agent_message",
            content: {
                type: "status_update",
                id: stringToUuid(`status-${statusContent.proposalId}-${Date.now()}`),
                text: `Proposal status updated to: ${statusContent.status}`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            from: this.runtime.agentType,
            to: "ALL"
        });
    }

    private async handleMonitoringUpdate(content: Content): Promise<void> {
        const monitoringContent = content as ProposalMonitoringContent;

        // Handle monitoring updates (e.g., failed proposal retries)
        if (monitoringContent.status === "monitoring" && monitoringContent.retryCount < monitoringContent.maxRetries) {
            // Get all monitoring memories since last processed, ordered by (timestamp, id)
            const monitoringMemories = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.PROPOSAL,
                count: 100,
                ...(this.lastProcessedMonitoring && {
                    createdAfter: this.lastProcessedMonitoring.timestamp,
                    afterId: this.lastProcessedMonitoring.id
                })
            });

            // Sort consistently by timestamp and id
            const sortedMemories = monitoringMemories.sort((a, b) => {
                const timeA = (a.content as BaseContent).createdAt || 0;
                const timeB = (b.content as BaseContent).createdAt || 0;
                const timeCompare = timeA - timeB;
                if (timeCompare === 0) {
                    // If timestamps match, compare IDs
                    return a.id < b.id ? -1 : 1;
                }
                return timeCompare;
            });

            for (const memory of sortedMemories) {
                const content = memory.content as ProposalMonitoringContent;
                if (content.type === "proposal_monitoring" && content.status === "monitoring") {
                    const proposal = await findProposal(this.runtime, content.proposalId);
                    if (proposal && proposal.status === "failed") {
                        // Schedule retry if within retry limits
                        const retryDelay = Math.min(
                            300000 * Math.pow(2, content.retryCount), // Exponential backoff
                            3600000 // Max 1 hour delay
                        );

                        setTimeout(async () => {
                            try {
                                await this.processCloseVote(
                                    this.runtime.agentId,
                                    String(proposal.shortId)
                                );
                            } catch (error) {
                                elizaLogger.error(`Retry attempt ${content.retryCount + 1} failed for proposal ${proposal.shortId}:`, error);
                            }
                        }, retryDelay);

                        // Update monitoring status with consistent timestamps
                        const now = Date.now();
                        const monitoringId = stringToUuid(`monitor-${proposal.id}-${now}`);
                        await this.runtime.messageManager.createMemory({
                            id: monitoringId,
                            content: {
                                ...content,
                                retryCount: content.retryCount + 1,
                                nextRetryTime: now + retryDelay,
                                text: `Scheduling retry attempt ${content.retryCount + 1} for proposal ${proposal.shortId}`,
                                createdAt: now,
                                updatedAt: now
                            },
                            roomId: ROOM_IDS.PROPOSAL,
                            userId: this.runtime.agentId,
                            agentId: this.runtime.agentId
                        });

                        // Update last processed state
                        this.lastProcessedMonitoring = {
                            timestamp: now,
                            id: monitoringId
                        };
                    }
                }
            }

            // If we processed all memories, update the last processed state with the final item
            if (sortedMemories.length > 0) {
                const lastMemory = sortedMemories[sortedMemories.length - 1];
                const lastContent = lastMemory.content as BaseContent;
                this.lastProcessedMonitoring = {
                    timestamp: lastContent.createdAt || Date.now(),
                    id: lastMemory.id
                };
            }
        }
    }

    protected async executeWithValidation<T extends Record<string, unknown>, R>(
        operation: string,
        params: T,
        executor: (params: T) => Promise<R>
    ): Promise<R> {
        try {
            const unknownParams = params as unknown;
            if (this.isBaseContent(unknownParams)) {
                const validationResult = await this.validateAction(unknownParams as BaseContent);
                if (!validationResult) {
                    throw new Error(`Validation failed for operation: ${operation}`);
                }
            }
            return await this.withTransaction(operation, async () => executor(params));
        } catch (error) {
            elizaLogger.error(`Error in ${operation}:`, error);
            throw error;
        }
    }

    private isBaseContent(value: unknown): value is BaseContent {
        return typeof value === 'object' && value !== null &&
            'type' in value && typeof value.type === 'string' &&
            'id' in value && typeof value.id === 'string' &&
            'text' in value && typeof value.text === 'string' &&
            'agentId' in value && typeof value.agentId === 'string';
    }
}