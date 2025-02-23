// TreasuryAgent.ts

import {
    elizaLogger,
    stringToUuid,
    UUID,
    Memory,
    generateObject,
    ModelClass,
    composeContext,
    generateText,
    Content,
    Actor,
    Goal,
    State,
    ModelProviderName,
    Character,
    Provider,
    IAgentRuntime as CoreAgentRuntime,
    IMemoryManager,
    Action
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent.ts";
import {
    BaseContent,
    SwapRequest,
    ContentStatus,
    AgentType,
    AgentTypes,
    AgentState,
    AgentCapability,
    AgentMessage,
    DistributedLock,
    IExtendedMemoryManager,
    IAgentRuntime
} from "../../shared/types/base.ts";
import {
    DepositContent,
    TransferContent,
    TreasuryTransaction,
    WalletRegistration,
    TokenBalance,
    PendingDeposit,
    PendingTransaction
} from "../../shared/types/treasury.ts";
import { WalletProvider } from "../../providers/wallet.ts";
import { TokenProvider } from "../../providers/token.ts";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { StrategyExecutionRequest, StrategyExecutionResult } from "../../shared/types/strategy.ts";
import { SwapService } from "../../services/swapService.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { getWalletKey } from "../../keypairUtils.ts";
import { verifyAndRecordDeposit, getBalanceWithUpdates } from "../../utils/depositUtils.ts";
import { toBN, BigNumber } from "../../utils/bignumber.ts";
import { settings } from "@elizaos/core";
import { clusterApiUrl } from "@solana/web3.js";
import { validateCommand, validateCommandWithParam } from "../../utils/commandValidation.ts";
import { VersionedTransaction } from "@solana/web3.js";
import { SystemProgram } from "@solana/web3.js";
import { TransactionMessage } from "@solana/web3.js";
import { jupiterSwap, raydiumSwap, pumpFunSwap, getTokenDecimals } from "../../utils/swapUtilsOrAtaHelper.ts";
import { generateShortId, shortIdToUuid } from "../../shared/types/proposal.ts";
import { UserProfile } from "../../shared/types/user.ts";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import { tokeninfo } from "../../actions/tokeninfo.js";

// -------------------------
// Type definitions
// -------------------------

interface SwapRoute {
    inputMint: string;
    outputMint: string;
    isPumpFunToken: boolean;
    bestRoute: "jupiter" | "raydium" | "pumpfun";
}

interface SwapResult {
    signature: string;
    outputAmount: string;
    price: number;
}

export interface ExtendedStrategy {
    initialTakeProfit: number;
    secondTakeProfit: number;
    stopLoss: number;
    exitTimeframe: string;
    exitIndicator: string;
    initialSellPct?: number;
    secondSellPct?: number;
    useTA?: boolean;
}

export enum PendingSwapStatus {
    AWAITING_STRATEGY = "awaiting_strategy",
    CONFIRMED = "confirmed",
    CANCELLED = "cancelled",
}

export interface TradeMemory {
    type: "trade";
    text: string;
    status: "active" | "partial_exit" | "full_exit" | "stopped_out";
    inputToken: string;
    outputToken: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
    timestamp: number;
    strategy: ExtendedStrategy;
    partialSells?: Array<{
        timestamp: number;
        amount: number;
        price: number;
        reason?: string;
        signature?: string;
    }>;
    tokensRemaining?: number;
    [key: string]: any;
}

interface JupiterQuoteResponse {
    error?: string;
    outAmount?: string;
    routePlan?: any[];
    priceImpactPct?: number;
    outAmountWithSlippage?: string;
}

function isValidQuoteResponse(data: unknown): data is JupiterQuoteResponse {
    const response = data as JupiterQuoteResponse;
    return response && typeof response === 'object' && 
        (!response.error || typeof response.error === 'string') &&
        (!response.outAmount || typeof response.outAmount === 'string') &&
        (!response.priceImpactPct || typeof response.priceImpactPct === 'number') &&
        (!response.routePlan || Array.isArray(response.routePlan));
}

interface SwapError {
    error: string;
}

function isSwapError(error: unknown): error is SwapError {
    return typeof error === 'object' && error !== null && 'error' in error && typeof (error as SwapError).error === 'string';
}

interface ErrorWithMessage {
    message: string;
    name?: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
    return (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as Record<string, unknown>).message === 'string'
    );
}

function getErrorMessage(error: unknown): string {
    if (isErrorWithMessage(error)) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
}

interface TokenApiResponse {
    tokens: Array<{ address: string; symbol: string; }>;
}

function isTokenApiResponse(data: unknown): data is TokenApiResponse {
    return (
        typeof data === 'object' &&
        data !== null &&
        'tokens' in data &&
        Array.isArray((data as TokenApiResponse).tokens)
    );
}

interface SwapContext {
    swapService: SwapService;
    connection: Connection;
    keypair: Keypair;
}

interface SwapExecutionResult extends BaseContent {
    type: "swap_execution_result";
    proposalId: UUID;
    swapId: UUID;
    success: boolean;
    error?: string;
    executedBy: UUID;
    timestamp: number;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount?: string;
}

interface GenerateObjectResult<T> {
    inputTokenCA?: string;
    outputTokenCA?: string;
    amount?: number;
    inputTokenSymbol?: string;
    outputTokenSymbol?: string;
    [key: string]: any;
}

interface ProposalInterpretation {
    details: ProposalDetails;
}

interface ProposalContent extends BaseContent {
    interpretation?: ProposalInterpretation;
    title: string;
    description: string;
    proposer: UUID;
    yes: UUID[];
    no: UUID[];
    deadline: number;
    voteStats: {
        total: number;
        yes: number;
        no: number;
        totalVotingPower: number;
        totalYesPower: number;
        totalNoPower: number;
        yesPowerPercentage: number;
        quorumReached: boolean;
        minimumYesVotesReached: boolean;
        minimumPercentageReached: boolean;
    };
}

interface TransferState extends State {
    pendingTransfer?: {
        recipient: string;
        amount: number;
        token: string;
        tokenAddress?: string;
        confirmed?: boolean;
        network?: string;
        currentBalance?: number;
        timestamp: number;
    };
    transactionComplete?: boolean;
    lastProcessedMessageId?: string;
    [key: string]: any;  // Add index signature to match State
}

// Add missing ProposalDetails type
type ProposalDetails = {
    type: 'swap';
    inputToken: string;
    outputToken: string;
    amount: string;
} | {
    type: 'strategy';
} | {
    type: 'governance';
} | {
    type: 'parameter_change';
} | {
    type: 'other';
};

// Add missing interfaces
interface RegisterValidationResult {
    isValid: boolean;
    walletAddress: string;
    reason: string;
}

interface SwapDetails {
    type: 'swap';
    inputToken: string;
    outputToken: string;
    amount: string;
}

// Add type for structured error logging
interface ErrorLogObject {
    error: string;
    [key: string]: unknown;
}

// Update error logging helper
function formatErrorLog(error: unknown): ErrorLogObject {
    return {
        error: getErrorMessage(error)
    };
}

// Fix the RegisterState interface to make roomId required
interface RegisterState extends State {
    walletAddress: string;
    bio: string;
    lore: string;
    messageDirections: string;
    postDirections: string;
    roomId: UUID;
    userId?: UUID;
    agentId?: UUID;
    actors: string;
    actorsData?: Actor[];
    goals?: string;
    goalsData?: Goal[];
    recentMessages: string;
    recentMessagesData: Memory[];
    actionNames?: string;
}

interface StopLossConfig {
    percentage: number;
    price?: number;
    isTrailing?: boolean;
    trailingDistance?: number;
    highestPrice?: number;
}

// Extend the imported type
interface ExtendedStrategyExecutionRequest extends StrategyExecutionRequest {
    stopLoss?: StopLossConfig;
    strategyType?: "TRAILING_STOP" | "TAKE_PROFIT" | "STOP_LOSS";
}

// Add this interface near the top with other interfaces
interface VerifiedDepositContent extends BaseContent {
    type: "deposit_verified";
    fromAddress: string;
    amount: string;
    token: string;
    metadata?: {
        discordId?: string;
        [key: string]: unknown;
    };
}

interface TreasuryInterpretation {
    actionType: "register" | "deposit" | "verify" | "balance" | "unknown";
    // For registration
    walletAddress?: string;
    // For verification
    transactionSignature?: string;
    // Common fields
    confidence: number;
    reason?: string;
}

const treasuryInterpretTemplate = `# Task: Interpret user's intention regarding treasury actions
You are the treasury agent responsible for managing wallet registrations, deposits, verifications, and balance checks.

The user's message is: "{{message}}"

Determine what treasury action the user wants to perform.

# Possible Actions:
1. register - User wants to register/connect their wallet
2. deposit - User wants to deposit funds or get deposit instructions
3. verify - User wants to verify a transaction/deposit
4. balance - User wants to check their balance/holdings

# Response Format:
Return a JSON object with these fields:
{
    "actionType": "register" | "deposit" | "verify" | "balance" | "unknown",
    "walletAddress": "string, if registering wallet",
    "transactionSignature": "string, if verifying transaction",
    "confidence": number between 0 and 1,
    "reason": "explanation of interpretation"
}

# Examples:
User: "I want to register my wallet ABC123..."
{
    "actionType": "register",
    "walletAddress": "ABC123...",
    "confidence": 0.95,
    "reason": "User explicitly mentions registering wallet and provides address"
}

User: "how do I deposit?"
{
    "actionType": "deposit",
    "confidence": 0.9,
    "reason": "User asks about deposit process"
}

User: "verify my transaction xyz789"
{
    "actionType": "verify",
    "transactionSignature": "xyz789",
    "confidence": 0.95,
    "reason": "User wants to verify transaction and provides signature"
}

User: "what's my balance?"
{
    "actionType": "balance",
    "confidence": 0.95,
    "reason": "User asks about their balance"
}

# Instructions:
1. Analyze the user's message for treasury-related intent
2. Extract relevant details (addresses, transaction signatures)
3. Set confidence based on clarity of intent (0.0-1.0)
4. If intent is unclear, set actionType to "unknown"
5. For Solana addresses, only extract if matches format: 32-44 characters, alphanumeric
6. For transaction signatures, only extract if matches format: 88+ characters, alphanumeric
7. Provide reason for your interpretation

# Now interpret the user's message and respond with the appropriate JSON.`;

export class TreasuryAgent extends BaseAgent {
    private walletProvider: WalletProvider;
    private tokenProvider: TokenProvider;
    private swapService: SwapService;
    private pendingSwaps: Map<UUID, NodeJS.Timeout> = new Map();
    private agentSettings: {
        swapTimeout: number;
        lockDuration: number;
        minTokenValueUsd: number;
        maxSlippage: number;
        defaultBaseToken: string;
    };

    private readonly registerValidationTemplate = `
        You are validating a Solana wallet address registration command.
        The wallet address should be a base58-encoded string between 32-44 characters.

        Wallet address to validate: {{walletAddress}}

        Respond with a JSON object:
        {
            "isValid": boolean,
            "walletAddress": string,
            "reason": string
        }
    `;

    constructor(runtime: ExtendedAgentRuntime) {
        try {
            elizaLogger.info("Initializing TreasuryAgent constructor...");
            
            // Debug log environment variables
            elizaLogger.info("Environment variables state:", {
                SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
                SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
                BASE_TOKEN: process.env.BASE_TOKEN,
                NODE_ENV: process.env.NODE_ENV
            });
            
            super(runtime);
            
            // Initialize settings with environment-based defaults
            this.agentSettings = {
                swapTimeout: parseInt(process.env.SWAP_TIMEOUT || "300000"),
                lockDuration: parseInt(process.env.LOCK_DURATION || "30000"),
                minTokenValueUsd: parseFloat(process.env.MIN_TOKEN_VALUE_USD || "0.1"),
                maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || "1"),
                defaultBaseToken: process.env.BASE_TOKEN || "So11111111111111111111111111111111111111112"
            };

            elizaLogger.info("TreasuryAgent constructor initialized successfully");
        } catch (error) {
            elizaLogger.error("Error in TreasuryAgent constructor:", {
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                    name: error.name,
                    cause: error.cause
                } : error,
                details: error instanceof Error ? {
                    ...error,
                    toJSON: undefined,
                    toString: undefined
                } : {},
                fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
            });
            throw new Error(`Failed to initialize TreasuryAgent: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    public override async initialize(): Promise<void> {
        try {
            // Initialize base agent
            await super.initialize();

            // Initialize connection
            const connection = new Connection(
                process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
            );

            // Get wallet public key
            const solanaPublicKey = process.env.SOLANA_PUBLIC_KEY;
            if (!solanaPublicKey) {
                throw new Error("SOLANA_PUBLIC_KEY environment variable is required");
            }
            const walletPubkey = new PublicKey(solanaPublicKey);

            // Load wallet and token providers
            this.walletProvider = new WalletProvider(connection, walletPubkey);
            this.tokenProvider = new TokenProvider(
                "So11111111111111111111111111111111111111112", // SOL mint address
                this.walletProvider,
                this.runtime.cacheManager
            );
            this.swapService = new SwapService(this.runtime);

            // Load agent capabilities and actions
            this.loadActions();

            // Set up cross-process event handlers
            await this.setupCrossProcessEvents();

            // Set up memory subscriptions
            this.setupMemorySubscriptions();

            elizaLogger.info("Treasury Agent initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize Treasury Agent:", error);
            throw error;
        }
    }

    private setupSwapTracking(): void {
        // Subscribe to swap execution results
        this.subscribeToMemory("swap_execution_result", async (mem: Memory) => {
            const content = mem.content as SwapExecutionResult;
            if (!content.swapId) return;

            // Clear any pending timeout
            const timeout = this.pendingSwaps.get(content.swapId);
            if (timeout) {
                clearTimeout(timeout);
                this.pendingSwaps.delete(content.swapId);
            }

            // Update proposal with swap result
            await this.handleSwapResult(content);
        });

        // Core memory subscriptions
        this.subscribeToMemory("swap_request", async (mem: Memory) => {
            const content = mem.content as SwapRequest;
            await this.handleSwapRequest(content);
        });

        this.subscribeToMemory("proposal_status_changed", async (mem: Memory) => {
            const content = mem.content as ProposalContent;
            // Only handle proposals that have passed (status changed to pending_execution)
            if (content.status === "pending_execution") {
                await this.handleProposalExecution(content);
            }
        });

        this.subscribeToMemory("strategy_status_changed", async (memory) => {
            const content = memory.content as BaseContent;
            // Only handle strategies that are ready for execution
            if (this.isStrategyContent(content) && content.status === "pending_execution") {
                await this.handleStrategyExecution(content as StrategyExecutionRequest);
            }
        });

        this.subscribeToMemory("deposit_received", async (mem: Memory) => {
            const content = mem.content as DepositContent;
            await this.handleDeposit(content);
        });

        this.subscribeToMemory("transfer_requested", async (mem: Memory) => {
            const content = mem.content as TransferContent;
            await this.handleTransfer(content);
        });

        this.subscribeToMemory("transaction_status_changed", async (mem: Memory) => {
            const content = mem.content as TreasuryTransaction;
            await this.handleTransaction(content);
        });
    }

    private async handleSwapResult(content: SwapExecutionResult): Promise<void> {
        try {
            // Create swap result memory
            await this.createMemory({
                type: "swap_completed",
                id: stringToUuid(`swap-result-${content.swapId}`),
                text: content.success 
                    ? `Swap completed: ${content.inputAmount} ${content.inputToken} -> ${content.outputAmount} ${content.outputToken}`
                    : `Swap failed: ${content.inputAmount} ${content.inputToken} -> ${content.outputToken}`,
                status: content.success ? "executed" : "failed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    swapId: content.swapId,
                    proposalId: content.proposalId,
                    success: content.success,
                    error: content.error,
                    executedBy: content.executedBy,
                    timestamp: content.timestamp,
                    inputToken: content.inputToken,
                    outputToken: content.outputToken,
                    inputAmount: content.inputAmount,
                    outputAmount: content.outputAmount
                }
            });

            // Create proposal execution result
            if (content.proposalId) {
                await this.createMemory({
                    type: "proposal_execution_result",
                    id: stringToUuid(`proposal-exec-${content.proposalId}`),
                    text: content.success 
                        ? `Proposal execution completed: Swap of ${content.inputAmount} ${content.inputToken}`
                        : `Proposal execution failed: ${content.error}`,
                    status: content.success ? "executed" : "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        proposalId: content.proposalId,
                        success: content.success,
                        error: content.error,
                        executedBy: this.runtime.agentId,
                        timestamp: content.timestamp
                    }
                });
            }

            elizaLogger.info(`Processed swap result for ${content.swapId}`, {
                success: content.success,
                error: content.error,
                proposalId: content.proposalId
            });
        } catch (error) {
            elizaLogger.error(`Error handling swap result for ${content.swapId}:`, error);
        }
    }

    protected async handleMemory(mem: Memory): Promise<void> {
        const content = mem.content;
        
        switch (content.type) {
            case "swap_request":
                await this.handleSwapRequest(content as SwapRequest);
                break;
            case "deposit_received":
                await this.handleDeposit(content as DepositContent);
                break;
            case "transfer_requested":
                await this.handleTransfer(content as TransferContent);
                break;
            case "strategy_triggered":
                await this.handleStrategyExecution(content as StrategyExecutionRequest);
                break;
            case "proposal":
            case "proposal_created":
                // Both base proposal and creation events use same handler
                await this.handleProposalEvent(content as ProposalContent);
                break;
            case "proposal_passed":
                await this.handleProposalExecution(content as ProposalContent);
                break;
            case "proposal_executed":
                // Update any dependent state after proposal execution
                await this.handleProposalExecuted(content as ProposalContent);
                break;
            default:
                // Handle commands in messages
                if ('text' in content && typeof content.text === 'string') {
                    const text = content.text.trim();
                    const agentMessage: AgentMessage = {
                        type: 'agent_message',
                        from: this.runtime.agentType,
                        to: "ALL",
                        content: {
                            type: 'agent_message',
                            id: stringToUuid(`msg-${Date.now()}`),
                            text: content.text,
                            agentId: this.runtime.agentId,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            status: "pending_execution"
                        }
                    };

                    if (validateCommand(text, "balance")) {
                        await this.handleBalanceCommand(agentMessage);
                    } else if (validateCommand(text, "register")) {
                        await this.handleRegisterCommand(agentMessage);
                    }
                }
        }
    }

    protected loadActions(): void {
        // Register existing capabilities
        this.registerCapability({
            name: "wallet_management",
            description: "Manage user wallet registrations and balances",
            requiredPermissions: ["manage_wallets"],
            actions: ["register", "verify", "balance"]
        });

        this.registerCapability({
            name: "swap_execution",
            description: "Execute token swaps",
            requiredPermissions: ["execute_swaps"],
            actions: ["swap"]
        });

        this.registerCapability({
            name: "treasury_monitoring",
            description: "Monitor treasury activities",
            requiredPermissions: ["view_treasury"],
            actions: ["balance", "history"]
        });

        this.registerCapability({
            name: "balance_tracking",
            description: "Track token balances",
            requiredPermissions: ["view_balances"],
            actions: ["balance"]
        });

        // Register shared actions
        this.runtime.registerAction(tokeninfo);

        // Register wallet registration action
        const registerAction: Action = {
            name: "register",
            similes: ["register_wallet", "wallet_registration", "connect_wallet"],
            description: "Register a wallet address with the treasury",
            handler: async (runtime, message, state) => {
                const agentMessage: AgentMessage = {
                    type: "message",
                    content: {
                        ...message.content,
                        id: message.id,
                        type: "message",
                        agentId: message.agentId,
                        createdAt: message.createdAt,
                        updatedAt: message.createdAt,
                        status: "open" as ContentStatus
                    } as BaseContent,
                    from: "USER",
                    to: "TREASURY",
                    timestamp: message.createdAt
                };
                return this.handleRegisterCommand(agentMessage);
            },
            validate: async (runtime, message) => {
                const text = message.content.text.toLowerCase();
                return text.startsWith("!register") || text.includes("register wallet");
            },
            examples: []
        };

        // Register deposit action
        const depositAction: Action = {
            name: "deposit",
            similes: ["deposit_funds", "deposit_tokens", "send_funds"],
            description: "Get instructions for depositing funds to the treasury",
            handler: async (runtime, message, state) => {
                const agentMessage: AgentMessage = {
                    type: "message",
                    content: {
                        ...message.content,
                        id: message.id,
                        type: "message",
                        agentId: message.agentId,
                        createdAt: message.createdAt,
                        updatedAt: message.createdAt,
                        status: "open" as ContentStatus
                    } as BaseContent,
                    from: "USER",
                    to: "TREASURY",
                    timestamp: message.createdAt
                };
                return this.handleDepositInstructions(agentMessage);
            },
            validate: async (runtime, message) => {
                const text = message.content.text.toLowerCase();
                return text.startsWith("!deposit") || text.includes("how") && text.includes("deposit");
            },
            examples: []
        };

        // Register verification action
        const verifyAction: Action = {
            name: "verify",
            similes: ["verify_deposit", "verify_transaction", "confirm_deposit"],
            description: "Verify a deposit transaction",
            handler: async (runtime, message, state) => {
                const agentMessage: AgentMessage = {
                    type: "message",
                    content: {
                        ...message.content,
                        id: message.id,
                        type: "message",
                        agentId: message.agentId,
                        createdAt: message.createdAt,
                        updatedAt: message.createdAt,
                        status: "open" as ContentStatus
                    } as BaseContent,
                    from: "USER",
                    to: "TREASURY",
                    timestamp: message.createdAt
                };
                return this.handleVerification(agentMessage);
            },
            validate: async (runtime, message) => {
                const text = message.content.text.toLowerCase();
                return text.startsWith("!verify") || text.includes("verify transaction");
            },
            examples: []
        };

        // Add actions to the agent
        this.runtime.registerAction(registerAction);
        this.runtime.registerAction(depositAction);
        this.runtime.registerAction(verifyAction);
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        this.messageBroker.on("transaction_executed", async (event) => {
            if (this.isValidBaseContent(event)) {
                const shortId = generateShortId();
                const transactionEvent: ProposalContent = {
                    type: "proposal",
                    id: shortIdToUuid(shortId),
                    shortId,
                    title: `Transaction ${event.id} executed`,
                    description: event.text || `Transaction executed`,
                    text: event.text || `Transaction executed`,
                    proposer: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    status: "executed",
                    yes: [],
                    no: [],
                    deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours from now
                    voteStats: {
                        total: 0,
                        yes: 0,
                        no: 0,
                        totalVotingPower: 0,
                        totalYesPower: 0,
                        totalNoPower: 0,
                        yesPowerPercentage: 0,
                        quorumReached: false,
                        minimumYesVotesReached: false,
                        minimumPercentageReached: false
                    },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        tags: ["transaction", "executed"],
                        priority: "high"
                    }
                };
                await this.createMemory(transactionEvent);
            }
        });
    }

    private isValidBaseContent(content: any): content is BaseContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            'id' in content &&
            'status' in content;
    }

    private isProposalWithSwap(content: ProposalContent): boolean {
        if (!content.interpretation || typeof content.interpretation !== 'object') {
            return false;
        }

        const details = content.interpretation.details;
        if (!details || typeof details !== 'object') {
            return false;
        }

        return 'inputToken' in details &&
            'outputToken' in details &&
            'amount' in details;
    }

    public override async shutdown(): Promise<void> {
        // Clear all swap timeouts
        for (const timeout of this.pendingSwaps.values()) {
            clearTimeout(timeout);
        }
        this.pendingSwaps.clear();
        
        await super.shutdown();
    }

    private isSwapRequest(content: any): content is SwapRequest {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'swap_request' &&
            'fromToken' in content &&
            'toToken' in content &&
            'amount' in content;
    }

    private isDepositContent(content: any): content is DepositContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'deposit_received' &&
            'token' in content &&
            'amount' in content;
    }

    private isTransferContent(content: any): content is TransferContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'transfer' &&
            'fromToken' in content &&
            'toToken' in content &&
            'amount' in content;
    }

    private isStrategyWithSwap(content: any): content is StrategyExecutionRequest {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'strategy_execution_request' &&
            'strategyId' in content &&
            'token' in content &&
            'amount' in content;
    }

    private isProposalContent(content: any): content is ProposalContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'proposal' &&
            'id' in content &&
            'title' in content &&
            'description' in content &&
            'proposer' in content &&
            'interpretation' in content;
    }

    private async getRegisteredWallet(userId: UUID): Promise<WalletRegistration | null> {
        try {
            // Get all wallet registration memories for this user
            const registrations = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 100 // Increased to handle multiple registrations
            });

            // Filter for valid wallet registrations for this user
            const userRegistrations = registrations
                .filter(mem => 
                    mem.userId === userId && 
                    mem.content.type === 'wallet_registration' &&
                    this.isValidBaseContent(mem.content)
                )
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // Sort by newest first

            // Return the most recent valid registration
            if (userRegistrations.length > 0) {
                return userRegistrations[0].content as WalletRegistration;
            }

            return null;
        } catch (error) {
            elizaLogger.error('Error getting registered wallet:', error);
            return null;
        }
    }

    private async getPendingDeposit(txSignature: string): Promise<PendingDeposit | null> {
        try {
            // Get recent deposit memories
            const deposits = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.TREASURY,
                count: 100 // Increased to handle multiple pending deposits
            });

            // Filter for matching deposit by transaction signature
            const matchingDeposits = deposits
                .filter(mem => 
                    mem.content.type === 'deposit' &&
                    this.isDepositContent(mem.content) &&
                    mem.content.txSignature === txSignature
                )
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // Sort by newest first

            // Return the most recent matching deposit
            if (matchingDeposits.length > 0) {
                return matchingDeposits[0].content as PendingDeposit;
            }

            return null;
        } catch (error) {
            elizaLogger.error('Error getting pending deposit:', error);
            return null;
        }
    }

    private async getPendingTransactions(token: string): Promise<PendingTransaction[]> {
        const now = Date.now();
        const transactions = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.TREASURY,
            count: 100
        });
        return transactions
            .filter(mem => {
                const content = mem.content as PendingTransaction;
                return content.type === "pending_transaction" &&
                       content.status === "pending_execution" &&
                       content.fromToken === token &&
                       content.expiresAt > now;
            })
            .map(mem => mem.content as PendingTransaction);
    }

    private async handleWalletRegistration(registration: WalletRegistration): Promise<void> {
        await this.withTransaction('handleWalletRegistration', async () => {
            // Check for existing registration
            const existing = await this.getRegisteredWallet(registration.userId);
            if (existing && existing.walletAddress !== registration.walletAddress) {
                throw new Error("User already has a different wallet registered");
            }

            // Create registration record
            await this.createMemory({
                type: "wallet_registration",
                id: stringToUuid(`reg-${registration.walletAddress}`),
                text: `Registering wallet ${registration.walletAddress}`,
                walletAddress: registration.walletAddress,
                userId: registration.userId,
                discordId: registration.discordId,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        });
    }

    // Add this utility function near the top of the class
    /**
     * Converts a Discord user ID to our internal UUID format.
     * This ensures consistent ID handling across all methods.
     * @param discordId The Discord user ID from message.from
     * @returns UUID formatted user ID
     * @throws Error if the ID is invalid
     */
    private getUserIdFromMessage(message: AgentMessage): UUID {
        if (!message.from || typeof message.from !== 'string') {
            throw new Error('Invalid message source: missing user ID');
        }
        
        // Validate it looks like a Discord ID (snowflake)
        if (!/^\d{17,19}$/.test(message.from)) {
            throw new Error('Invalid Discord user ID format');
        }

        return stringToUuid(message.from);
    }

    private async handleDepositInstructions(message: AgentMessage): Promise<void> {
        try {
            // 1. Get user ID using our consistent method
            const userId = this.getUserIdFromMessage(message);
            
            // 2. Check if user has registered wallet
            const registration = await this.getRegisteredWallet(userId);
            if (!registration) {
                throw new Error("Please register your wallet first using !register <address>");
            }

            // 3. Get treasury wallet address
            const connection = new Connection(
                process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
            );
            const { publicKey } = await getWalletKey(this.runtime, true);
            if (!publicKey) {
                throw new Error("Could not retrieve treasury wallet configuration");
            }
            const treasuryAddress = publicKey.toBase58();

            // 4. Create and send deposit instructions
            const response: BaseContent = {
                id: stringToUuid(`resp-${Date.now()}`),
                type: "deposit_response",
                text: `Send SOL to this treasury address:\n\n\`${treasuryAddress}\`\n\nAfter sending, use !verify <tx_signature> to confirm your deposit.`,
                action: "deposit",
                source: "discord",
                agentId: this.runtime.agentId, // This should be the treasury agent's ID
                status: "executed" as ContentStatus,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            // 5. Create memory of deposit instructions being sent
            const depositInstructions: BaseContent = {
                id: stringToUuid(`dep-${Date.now()}`),
                type: "deposit_instructions",
                text: response.text,
                agentId: this.runtime.agentId,
                status: "open" as ContentStatus,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    registeredWallet: registration.walletAddress,
                    instructionsSent: true,
                    treasuryAddress,
                    userId: userId, // Store the user's ID in metadata
                    discordId: message.from // Store original Discord ID for reference
                }
            };

            // 6. Store instructions in memory
            await this.runtime.messageManager.createMemory({
                id: depositInstructions.id,
                userId, // Use consistent user ID
                agentId: this.runtime.agentId,
                roomId: ROOM_IDS.TREASURY,
                content: depositInstructions,
                createdAt: Date.now()
            });

            // 7. Send response
            await this.sendMessage({
                type: "deposit_response",
                content: response,
                from: this.runtime.agentType,
                to: "ALL"
            });
        } catch (error) {
            elizaLogger.error("Deposit instructions error:", {
                error: error instanceof Error ? error.message : 'Unknown error',
                userId: message.from,
                messageId: message.content.id
            });
            throw error;
        }
    }

    private async handleDeposit(content: DepositContent): Promise<void> {
        // This method now only handles deposit_received events from other parts of the system
        // It doesn't handle the !deposit command or verification
        if (content.type !== "deposit_received") {
                return;
            }

        try {
            // Store the pending deposit without verification
            await this.createMemory({
                type: "pending_deposit",
                id: stringToUuid(`deposit-${content.txSignature}`),
                text: `Received deposit notification for transaction ${content.txSignature}`,
                status: "pending_execution" as ContentStatus, // Changed from pending_verification
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    txSignature: content.txSignature,
                    userId: content.userId,
                    timestamp: Date.now(),
                    requiresVerification: true // Added flag to indicate verification needed
                }
            });

            // Send response asking for verification
            await this.sendMessage({
                type: "deposit_response",
                    content: {
                    type: "deposit_response",
                    id: stringToUuid(`deposit-response-${content.txSignature}`),
                    text: `Deposit notification received. Please verify your deposit using:\n!verify ${content.txSignature}`,
                    status: "pending_execution" as ContentStatus, // Changed from pending_verification
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });

        } catch (error) {
            elizaLogger.error("Error processing deposit notification:", error);
            throw error;
        }
    }

    private async processReceivedDeposit(deposit: DepositContent): Promise<void> {
        // This is now only called after successful verification via !verify
        try {
            // Update user's balance in memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`balance-${Date.now()}`),
                userId: deposit.userId,
                agentId: this.runtime.agentId,
                roomId: ROOM_IDS.TREASURY,
                content: {
                    id: stringToUuid(`balance-${Date.now()}`),
                    type: "balance_update",
                    text: `Balance updated: +${deposit.amount} SOL`,
                    agentId: this.runtime.agentId,
                    status: "executed" as ContentStatus,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                        metadata: {
                        depositId: deposit.id,
                        amount: deposit.amount,
                        token: "SOL",
                        txSignature: deposit.txSignature,
                        verifiedAt: Date.now()
                    }
                },
                createdAt: Date.now()
            });

            // Emit deposit event
            await this.messageBroker.emit("deposit_processed", deposit);
        } catch (error) {
            elizaLogger.error("Error processing verified deposit:", error);
            throw error;
        }
    }

    private async handleTransfer(content: TransferContent | Memory): Promise<void> {
        const baseState: Partial<State> = {
            bio: "",
            lore: "",
            messageDirections: "{}",
            postDirections: "{}",
            roomId: ROOM_IDS.DAO as UUID,
            actors: "[]",
            recentMessages: "[]",
            recentMessagesData: []
        };

        const transferState = {
            ...baseState,
            pendingTransfer: undefined,
            transactionComplete: false,
            lastProcessedMessageId: undefined
        } as TransferState;

        const memoryManager = this.runtime.messageManager as IMemoryManager;
        
        try {
            elizaLogger.debug('[TRANSFER handler] Starting transfer with message:', {
                messageId: 'content' in content ? content.id : undefined,
                userId: 'userId' in content ? content.userId : undefined,
                content: content
            });

            // Skip if already processed
            const state = content as unknown as TransferState;
            if (state.lastProcessedMessageId === ('id' in content ? content.id : undefined)) {
                elizaLogger.debug('[TRANSFER handler] Skipping already processed message');
                return;
            }

            // Get wallet key first to determine the lock key
            const { keypair: senderKeypair } = await getWalletKey(this.runtime, true);
            if (!senderKeypair) {
                await this.sendMessage({
                    type: "transfer_response",
                    content: {
                        type: "transfer_response",
                        id: stringToUuid(`transfer-error-${Date.now()}`),
                        text: "Failed to get wallet keypair",
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

            // Acquire lock for treasury SOL transfers
            const lock = await this.acquireDistributedLock(`treasury-sol-transfer`);
            if (!lock) {
                throw new Error("Could not acquire treasury lock");
            }

            try {
                await this.withTransaction('handleTransfer', async () => {
                    // Rest of the transfer logic...
                    // Parse the transfer details directly from the message
                    if (!content.content || 
                        typeof content.content !== 'object' || 
                        !('text' in content.content) || 
                        typeof content.content.text !== 'string') {
                        return;
                    }

                    const text = content.content.text.trim();
                    const transferRegex = /^(?:<@\d+>\s+)?(?:transfer|send)\s+(\d*\.?\d+)\s*(?:SOL|sol)\s+(?:to\s+)?([A-HJ-NP-Za-km-z1-9]{32,44})$/i;
                    const match = text.match(transferRegex);

                    if (!match) {
                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-error-${Date.now()}`),
                                text: "Invalid transfer format. Please use: transfer <amount> SOL to <address>",
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

                    const amount = parseFloat(match[1]);
                    if (isNaN(amount) || amount <= 0) {
                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-error-${Date.now()}`),
                                text: "Invalid amount: Amount must be greater than 0",
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

                    const recipient = match[2];

                    // Validate recipient address format
                    try {
                        new PublicKey(recipient);
                    } catch (err) {
                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-error-${Date.now()}`),
                                text: "Invalid recipient address format",
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

                    elizaLogger.debug('[TRANSFER handler] Connecting to Solana...');
                    const connection = new Connection(
                        this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
                    );

                    // Check balance
                    elizaLogger.debug('[TRANSFER handler] Checking balance...');
                    const currentBalance = await this.checkWalletBalance(connection, senderKeypair.publicKey);
                    elizaLogger.debug(`[TRANSFER handler] Current balance: ${currentBalance} SOL`);

                    if (amount >= currentBalance) {
                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-error-${Date.now()}`),
                                text: `Insufficient balance. You have ${currentBalance} SOL but tried to send ${amount} SOL.`,
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

                    try {
                        elizaLogger.debug("[TRANSFER handler] Executing SOL transfer...");
                        const signature = await this.handleSolTransfer(
                            connection,
                            recipient,
                            amount
                        );

                        elizaLogger.info("Transfer successful, signature:", signature);
                        const explorerUrl = `https://explorer.solana.com/tx/${signature}`;

                        // Look up if this is a transfer to a registered wallet
                        const registeredWallets = await memoryManager.getMemories({
                            roomId: this.runtime.agentId,
                            count: 1000
                        });

                        // Find if recipient matches any registered wallet
                        const registeredUser = registeredWallets.find(mem =>
                            mem.content.type === "registered_wallet" &&
                            mem.content.publicKey === recipient
                        );

                        // Generate unique memory ID for transfer record
                        const memoryId = stringToUuid(`${'userId' in content ? content.userId : 'content'}-transfer-${signature}-${Date.now()}`);

                        // Store transfer record in memory with registered user info if found
                        await memoryManager.createMemory({
                            id: memoryId,
                            content: {
                                type: "treasury_transaction",
                                text: `Transferred ${amount} SOL to ${recipient}`,
                                status: "completed",
                                amountSOL: amount,
                                recipientAddress: recipient,
                                recipientUserId: registeredUser?.userId,
                                txHash: signature,
                                timestamp: Date.now()
                            },
                            roomId: ROOM_IDS.TREASURY,  // Transfer records should be in treasury room
                            userId: ('userId' in content && typeof content.userId === 'string') ? stringToUuid(content.userId) : this.runtime.agentId,
                            agentId: this.runtime.agentId,
                            unique: true
                        });

                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-success-${Date.now()}`),
                                text: `Transfer successful! View transaction: ${explorerUrl}`,
                                status: "executed",
                                agentId: this.runtime.agentId,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            },
                            from: this.runtime.agentType,
                            to: "ALL"
                        });

                        if ('content' in content && typeof content.content === 'object' && content.content !== null) {
                            (content.content as any).transactionComplete = true;
                            (content as unknown as TransferState).lastProcessedMessageId = content.id;
                        }

                    } catch (error) {
                        elizaLogger.error("Transfer failed:", error);
                        await this.sendMessage({
                            type: "transfer_response",
                            content: {
                                type: "transfer_response",
                                id: stringToUuid(`transfer-error-${Date.now()}`),
                                text: `Transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                                status: "failed",
                                agentId: this.runtime.agentId,
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            },
                            from: this.runtime.agentType,
                            to: "ALL"
                        });
                    }
                });
            } finally {
                await this.releaseDistributedLock(lock);
            }
        } catch (error) {
            elizaLogger.error("Error in transfer handler:", error);
            await this.sendMessage({
                type: "transfer_response",
                content: {
                    type: "transfer_response",
                    id: stringToUuid(`transfer-error-${Date.now()}`),
                    text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

    private async handleVerification(content: DepositContent | AgentMessage): Promise<void> {
        try {
            // First validate command format
            const text = this.isDepositContent(content) ? content.txSignature : 
                        'text' in content && typeof content.text === 'string' ? content.text : '';
            const isValidCommand = validateCommandWithParam(text || "", "verify", "[1-9A-HJ-NP-Za-km-z]{88}");
            if (!isValidCommand) {
                await this.sendMessage({
                    type: "verify_response",
                    content: {
                        type: "verify_response",
                        id: stringToUuid(`verify-error-${Date.now()}`),
                        text: "Invalid verify command format. Please use:\n!verify <transaction_signature>",
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

            // Extract transaction signature
            const txSignature = 'txSignature' in content ? content.txSignature : 
                              typeof text === 'string' ? text.match(/[1-9A-HJ-NP-Za-km-z]{88,}/)?.[0] : undefined;
            if (!txSignature) {
                throw new Error("Invalid transaction signature format");
            }

            // Get user's registered wallet
            const userId = this.isDepositContent(content) ? content.userId : 
                         'from' in content ? this.getUserIdFromMessage(content) : 
                         stringToUuid(Date.now().toString()); // Fallback UUID
            const registration = await this.getRegisteredWallet(userId);
            if (!registration) {
                throw new Error("Please register your wallet first using !register <address>");
            }

            // Verify and record the deposit
            const deposit = await verifyAndRecordDeposit(txSignature, this.runtime);
            if (!deposit) {
                throw new Error("Could not verify deposit transaction");
            }

            // Check that transaction sender matches registered wallet
            if (deposit.fromAddress.toLowerCase() !== registration.walletAddress.toLowerCase()) {
                throw new Error("This transaction was not sent from your registered wallet address");
            }

            // Format success message
            const successMsg = `✅ Deposit verified!\n` +
                             `Amount: ${deposit.amountSOL} SOL\n` +
                             `From: \`${deposit.fromAddress}\`\n` +
                             `Transaction: https://explorer.solana.com/tx/${txSignature}`;

            await this.sendMessage({
                type: "verify_response",
                content: {
                    type: "verify_response",
                    id: stringToUuid(`verify-success-${txSignature}`),
                    text: successMsg,
                    status: "executed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        } catch (error) {
            elizaLogger.error("Error processing verify request:", error);
            await this.sendMessage({
                type: "verify_response",
                content: {
                    type: "verify_response",
                    id: stringToUuid(`verify-error-${Date.now()}`),
                    text: "Sorry, I encountered an error verifying your deposit. Please try again later.",
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

    private async handleStrategyExecution(request: ExtendedStrategyExecutionRequest): Promise<void> {
        try {
            // Validate request
            if (!await this.validateStrategyExecution(request)) {
                throw new Error("Invalid strategy execution request");
            }

            const amountNum = parseFloat(request.amount);
            if (isNaN(amountNum) || amountNum <= 0) {
                throw new Error(`Invalid amount: ${request.amount}`);
            }

            // Acquire lock for strategy execution
            const lock = await this.acquireDistributedLock(`strategy-${request.strategyId}`);
            if (!lock) {
                throw new Error("Could not acquire strategy execution lock");
            }

            try {
                // Handle trailing stop logic if applicable
                if (request.strategyType === "TRAILING_STOP" && request.stopLoss?.isTrailing) {
                    const currentPrice = await this.swapService.getTokenPrice(request.token);
                    if (!currentPrice || currentPrice.error) {
                        throw new Error("Could not get current token price");
                    }

                    // Update highest price if needed
                    if (!request.stopLoss.highestPrice || currentPrice.price > request.stopLoss.highestPrice) {
                        request.stopLoss.highestPrice = currentPrice.price;
                        elizaLogger.info(`Updated highest price for strategy ${request.strategyId} to ${currentPrice.price}`);
                        return; // Exit early since we just updated the high
                    }

                    // Check if price has fallen below trailing stop threshold
                    const stopPrice = request.stopLoss.highestPrice * (1 - (request.stopLoss.trailingDistance! / 100));
                    if (currentPrice.price > stopPrice) {
                        elizaLogger.debug(`Current price ${currentPrice.price} above stop price ${stopPrice}, no action needed`);
                        return;
                    }

                    elizaLogger.info(`Trailing stop triggered for strategy ${request.strategyId} at ${currentPrice.price} (stop price: ${stopPrice})`);
                }

                // Create swap request instead of direct execution
                const swapRequest: SwapRequest = {
                    type: "swap_request",
                    id: stringToUuid(`strategy-swap-${request.id}`),
                    fromToken: request.token,
                    toToken: request.baseToken,
                    amount: request.amount,
                    reason: "strategy_triggered",
                    requestId: request.requestId,
                    sourceAgent: "STRATEGY",
                    sourceId: request.strategyId,
                    status: "pending_execution",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    text: `Strategy-triggered swap for ${request.strategyId}`
                };

                // Process through handleSwapRequest
                try {
                    const result = await this.handleSwapRequest(swapRequest);

                    // Create success result content
                    const resultContent: BaseContent = {
                        type: "strategy_execution_result",
                        id: stringToUuid(`result-${request.id}`),
                        text: `Successfully executed strategy ${request.strategyId}`,
                        agentId: this.id,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: "executed",
                        requestId: request.requestId,
                        success: true,
                        txSignature: result.signature,
                        executedAmount: request.amount,
                        executionPrice: result.price
                    };

                    // Store result in memory
                    await this.createMemory(resultContent);

                    // Send result message
                    await this.sendMessage({
                        type: "strategy_execution_result",
                        content: resultContent,
                        from: this.runtime.agentType,
                        to: "ALL"
                    });

                    elizaLogger.info(`Strategy execution completed: ${request.strategyId}`);
                } catch (error) {
                    throw new Error(`Swap failed: ${error instanceof Error ? error.message : String(error)}`);
                }

            } finally {
                await this.releaseDistributedLock(lock);
            }

        } catch (error) {
            elizaLogger.error(`Error executing strategy:`, error);

            // Create failure result content
            const errorContent: BaseContent = {
                type: "strategy_execution_result",
                id: stringToUuid(`result-${request.id}`),
                text: `Failed to execute strategy ${request.strategyId}`,
                agentId: this.id,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "failed",
                requestId: request.requestId,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };

            // Store result in memory
            await this.createMemory(errorContent);

            // Send result message
            await this.sendMessage({
                type: "strategy_execution_result",
                content: errorContent,
                from: this.runtime.agentType,
                to: "ALL"
            });
        }
    }

    private async validateStrategyExecution(request: StrategyExecutionRequest): Promise<boolean> {
        // Validate the request has required fields
        if (!request.token || !request.baseToken || !request.amount) {
            return false;
        }

        try {
            // Check if we have sufficient balance
            const balance = await this.walletProvider.fetchPortfolioValue(this.runtime);
            const tokenBalance = balance.items.find(item => item.address === request.token);
            
            if (!tokenBalance || parseFloat(tokenBalance.uiAmount) < parseFloat(request.amount)) {
                elizaLogger.warn(`Insufficient balance for strategy execution:`, {
                    required: request.amount,
                    available: tokenBalance?.uiAmount || "0"
                });
                return false;
            }

            return true;
        } catch (error) {
            elizaLogger.error(`Error validating strategy execution:`, error);
            return false;
        }
    }

    private async getAvailableBalance(token: string): Promise<string> {
        // Get current balance
        const balances = await this.tokenProvider.getTokensInWallet(this.runtime);
        const balance = balances.find(item => item.address === token);
        return balance?.uiAmount || "0";
    }

    private async checkWalletBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
        const balance = await connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    }

    private async handleSolTransfer(
        connection: Connection,
        recipient: string,
        amount: number
    ): Promise<string> {
        try {
            // Get wallet keypair using getWalletKey
            const { keypair } = await getWalletKey(this.runtime, true);
            if (!keypair) {
                throw new Error("Failed to get wallet keypair");
            }

            const recipientPubkey = new PublicKey(recipient);

            const transferInstruction = SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: recipientPubkey,
                lamports: amount * LAMPORTS_PER_SOL
            });

            const messageV0 = new TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: [transferInstruction]
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([keypair]);

            return await connection.sendTransaction(transaction);
        } catch (error) {
            elizaLogger.error("Error in handleSolTransfer:", error);
            throw error;
        }
    }

    private async handleSwapRequest(request: SwapRequest): Promise<{ signature: string; price: number }> {
        try {
            if (typeof request.fromToken !== 'string' || typeof request.toToken !== 'string') {
                throw new Error('Invalid token addresses in swap request');
            }

            const amountNum = parseFloat(request.amount);
            if (isNaN(amountNum) || amountNum <= 0) {
                throw new Error(`Invalid amount: ${request.amount}`);
            }

            // Acquire a lock to ensure only one swap runs at a time
            const lock = await this.acquireDistributedLock(`swap-${request.fromToken}-${request.toToken}`);
            if (!lock) {
                throw new Error(`Could not acquire swap lock for request ${request.id}`);
            }

            try {
                // Use getWalletKey to get keypair
                const { keypair } = await getWalletKey(this.runtime, true);
                if (!keypair) {
                    throw new Error("Failed to get wallet keypair");
                }

                const connection = new Connection(
                    this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
                );

                // Validate tokens first
                const [inputValid, outputValid] = await Promise.all([
                    this.quickTokenValidation(request.fromToken),
                    this.quickTokenValidation(request.toToken)
                ]);

                if (!inputValid || !outputValid) {
                    throw new Error('Invalid token addresses');
                }

                // Quick security check with timeout
                const securityCheck = this.quickSecurityCheck(request.fromToken);
                const securityTimeout = new Promise<boolean>((_, reject) => 
                    setTimeout(() => reject(new Error('Security check timeout')), SWAP_TIMEOUTS.SECURITY_CHECK)
                );
                const isSecure = await Promise.race([securityCheck, securityTimeout]);
                if (!isSecure) {
                    throw new Error('Token failed security check');
                }

                // Get optimal route with timeout
                const routeRequest = this.getOptimalSwapRoute(request.fromToken, request.toToken, amountNum);
                const routeTimeout = new Promise<SwapRoute>((_, reject) => 
                    setTimeout(() => reject(new Error('Route fetch timeout')), SWAP_TIMEOUTS.QUOTE)
                );
                const route = await Promise.race([routeRequest, routeTimeout]);

                // Execute the swap with timeout
                const swapRequest = this.executeSwapWithRoute(connection, route, amountNum);
                const swapTimeout = new Promise<{ signature: string; inputAmount: number; outputAmount: number }>((_, reject) => 
                    setTimeout(() => reject(new Error('Swap execution timeout')), SWAP_TIMEOUTS.SWAP)
                );
                const result = await Promise.race([swapRequest, swapTimeout]);

                return {
                    signature: result.signature,
                    price: result.outputAmount / result.inputAmount
                };

            } finally {
                // Always release the lock
                await this.releaseDistributedLock(lock);
            }

        } catch (error) {
            elizaLogger.error("Error in handleSwapRequest:", error);
            throw error;
        }
    }

    // Add lock interfaces and methods
    protected async acquireDistributedLock(key: string, timeoutMs: number = 30000): Promise<DistributedLock | null> {
        return await this.withTransaction('acquireLock', async () => {
            const now = Date.now();
            const expiresAt = now + timeoutMs;
            const lockId = stringToUuid(`lock-${key}-${now}`);

            try {
                // First, remove any expired locks for this key
                await this.runtime.messageManager.removeMemoriesWhere({
                    type: "distributed_lock",
                    filter: {
                        key,
                        expiresAt: { $lt: now }
                    }
                });

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

    // Add helper methods from swap.ts
    private async quickTokenValidation(tokenAddress: string): Promise<boolean> {
        if (tokenAddress === settings.SOL_ADDRESS) return true;
        try {
            // Security check
            const securityCheckPassed = await this.quickSecurityCheck(tokenAddress);
            if (!securityCheckPassed) return false;
            
            // Check if valid SPL token
            const connection = new Connection(this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com");
            const isSPLToken = await this.isStandardSPLToken(connection, tokenAddress);
            if (!isSPLToken) return false;

            // Try price info from cache
            const priceInfo = await this.swapService.getTokenPrice(tokenAddress);
            if (priceInfo.price > 0 && !priceInfo.error) return true;
            
            // Fallback to Jupiter quote check
            const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${settings.SOL_ADDRESS}&outputMint=${tokenAddress}&amount=100000000`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(quoteUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (response.status === 401) throw new Error("Unauthorized: Check API key permissions");
            const data = await response.json();
            return Boolean(!data.error && data.outAmount && data.routePlan?.length > 0);
        } catch (error) {
            elizaLogger.warn("Quick token validation error:", formatErrorLog(error));
            return false;
        }
    }

    private async quickSecurityCheck(tokenCA: string): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.agentSettings.lockDuration);
            if (tokenCA === settings.SOL_ADDRESS) {
                clearTimeout(timeoutId);
                return true;
            }
            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=${settings.SOL_ADDRESS}&outputMint=${tokenCA}&amount=100000`,
                { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            return response.ok;
        } catch (error) {
            elizaLogger.warn("[Security Check] Skipped:", formatErrorLog(error));
            return true;
        }
    }

    private async isStandardSPLToken(connection: Connection, mintAddress: string): Promise<boolean> {
        try {
            if (mintAddress === settings.SOL_ADDRESS) return false;
            const mintPubkey = new PublicKey(mintAddress);
            const accountInfo = await connection.getAccountInfo(mintPubkey);
            return accountInfo !== null && accountInfo.owner.equals(TOKEN_PROGRAM_ID);
        } catch (error) {
            return false;
        }
    }

    private async getQuoteForRoute(
        inputTokenCA: string,
        outputTokenCA: string,
        amount: number
    ): Promise<{ price: number; impact: number; minOutput: number }> {
        // Try cached prices first
        const [inputPrice, outputPrice] = await Promise.all([
            this.swapService.getTokenPrice(inputTokenCA),
            this.swapService.getTokenPrice(outputTokenCA)
        ]);

        if (inputPrice.price > 0 && outputPrice.price > 0) {
            const expectedPrice = inputPrice.price / outputPrice.price;
            
            // Get Jupiter quote for impact
            const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
            const response = await fetch(url);
            if (response.status === 401) {
                throw new Error("Unauthorized: API key issue");
            }
            const data = await response.json();
            if (!data?.outAmount || !data?.priceImpactPct) {
                throw new Error("Invalid quote response");
            }

            const actualPrice = Number(data.outAmount) / amount;
            const impact = Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
            const minOutput = Number(data.outAmountWithSlippage);

            return { price: actualPrice, impact, minOutput };
        }

        // Fallback to Jupiter quote
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
        const response = await fetch(url);
        if (response.status === 401) {
            throw new Error("Unauthorized: API key issue");
        }
        const data = await response.json();
        if (!data?.outAmount || !data?.priceImpactPct) {
            throw new Error("Invalid quote response");
        }
        return {
            price: Number(data.outAmount) / amount,
            impact: Number(data.priceImpactPct),
            minOutput: Number(data.outAmountWithSlippage)
        };
    }

    private async getOptimalSwapRoute(
        inputTokenCA: string,
        outputTokenCA: string,
        amount: number
    ): Promise<{ inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: "jupiter" | "raydium" | "pumpfun" }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.agentSettings.lockDuration);
        try {
            // Try Jupiter route first with DEX exclusions
            const jupiterQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100&onlyDirectRoutes=true&excludeDexes=Pump,Serum,Saber,Aldrin,Crema,Step,Cropper,GooseFX,Lifinity,Meteora,Invariant,Dradex,Openbook`;
            const response = await fetch(jupiterQuoteUrl, {
                signal: controller.signal,
                headers: {
                    Accept: "application/json",
                    "Cache-Control": "no-cache",
                },
            });
            if (response.status === 401) {
                throw new Error("Unauthorized: Check API key permissions for Jupiter API.");
            }
            if (response.ok) {
                clearTimeout(timeoutId);
                return {
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    isPumpFunToken: false,
                    bestRoute: "jupiter"
                };
            }

            // If Jupiter fails, try Raydium
            const raydiumResponse = await fetch("https://api.raydium.io/v2/main/quote", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                },
                body: JSON.stringify({
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    amount: amount.toString(),
                    slippage: 1.0,
                }),
                signal: controller.signal,
            });
            if (raydiumResponse.status === 401) {
                throw new Error("Unauthorized: Check API key permissions for Raydium API.");
            }
            if (raydiumResponse.ok) {
                clearTimeout(timeoutId);
                return {
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    isPumpFunToken: false,
                    bestRoute: "raydium"
                };
            }

            // Finally try PumpFun
            const pumpfunResponse = await fetch(`https://pumpportal.fun/api/pool/${outputTokenCA}`);
            if (pumpfunResponse.ok) {
                return {
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    isPumpFunToken: true,
                    bestRoute: "pumpfun"
                };
            }

            throw new Error("No valid quote found");
        } catch (error) {
            clearTimeout(timeoutId);
            if (isErrorWithMessage(error) && error.name === "AbortError") {
                throw new Error("Quote fetch timed out");
            }
            throw error;
        }
    }

    private async executeSwapWithRoute(
        connection: Connection,
        route: { inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: string },
        amount: number
    ): Promise<{ signature: string; inputAmount: number; outputAmount: number }> {
        // Get wallet keypair using getWalletKey
        const { keypair } = await getWalletKey(this.runtime, true);
        if (!keypair) {
            throw new Error("Failed to get wallet keypair");
        }

        switch (route.bestRoute) {
            case "jupiter":
                return await jupiterSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            case "raydium":
                return await raydiumSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            case "pumpfun":
                return await pumpFunSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            default:
                throw new Error(`Unknown route type: ${route.bestRoute}`);
        }
    }

    private async convertAmountToDecimals(
        connection: Connection,
        amount: number,
        tokenMint: string
    ): Promise<BigNumber> {
        try {
            const decimals = await getTokenDecimals(connection, tokenMint);
            elizaLogger.info(`Token decimals for ${tokenMint}: ${decimals}`);
            const amountBN = new BigNumber(amount);
            const multiplier = new BigNumber(10).pow(decimals);
            const rawAmount = amountBN.times(multiplier);
            if (rawAmount.gt(new BigNumber(Number.MAX_SAFE_INTEGER))) {
                throw new Error("Amount too large for safe processing");
            }
            return rawAmount;
        } catch (error) {
            elizaLogger.error("Error converting amount:", error);
            throw error;
        }
    }

    private async handleProposalExecution(proposal: ProposalContent): Promise<void> {
        try {
            if (!this.isProposalWithSwap(proposal)) {
                elizaLogger.warn("Proposal does not contain swap details");
                return;
            }

            const details = proposal.interpretation?.details as SwapDetails;
            const swapRequest: SwapRequest = {
                type: "swap_request",
                id: stringToUuid(`swap-${proposal.id}`),
                fromToken: details.inputToken,
                toToken: details.outputToken,
                amount: details.amount,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                reason: "proposal_passed",
                requestId: proposal.id,
                sourceAgent: "TREASURY",
                sourceId: proposal.id,
                text: `Executing swap from proposal ${proposal.id}`
            };

            await this.handleSwapRequest(swapRequest);
        } catch (error) {
            elizaLogger.error("Error executing proposal:", error);
            throw error;
        }
    }

    private async handleBalanceCommand(message: AgentMessage): Promise<void> {
        try {
            const swapService = new SwapService(this.runtime);
            const { publicKey } = await getWalletKey(this.runtime, false);
            if (!publicKey) {
                await this.sendMessage({
                    type: "balance_response",
                    content: {
                        type: "balance_response",
                        id: stringToUuid(`balance-${Date.now()}`),
                        text: "No wallet configured for DAO treasury",
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

            const connection = new Connection(
                this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
            );

            // First get native SOL balance
            let totalValueUsd = 0;
            const balances: Array<{
                token: string;
                symbol: string;
                amount: string;
                valueUsd: number;
                price: number;
            }> = [];

            const solBalance = await connection.getBalance(publicKey);
            const solAmount = solBalance / LAMPORTS_PER_SOL;
            
            if (solAmount > 0) {
                const solPriceInfo = await swapService.getTokenPrice(settings.SOL_ADDRESS);
                if (solPriceInfo) {
                    const valueUsd = solAmount * solPriceInfo.price;
                    if (valueUsd >= this.agentSettings.minTokenValueUsd) {
                        totalValueUsd += valueUsd;
                        balances.push({
                            token: settings.SOL_ADDRESS,
                            symbol: "SOL",
                            amount: solAmount.toString(),
                            valueUsd,
                            price: solPriceInfo.price
                        });
                    }
                }
            }

            // Then get token balances
            const tokens = await connection.getParsedTokenAccountsByOwner(publicKey, {
                programId: TOKEN_PROGRAM_ID
            });

            // Process each token balance
            for (const { account, pubkey } of tokens.value) {
                const parsedInfo = account.data.parsed.info;
                const tokenAddress = parsedInfo.mint;
                const amount = parsedInfo.tokenAmount.uiAmount;

                if (amount > 0) {
                    const priceInfo = await swapService.getTokenPrice(tokenAddress);
                    if (priceInfo) {
                        const valueUsd = amount * priceInfo.price;
                        if (valueUsd >= this.agentSettings.minTokenValueUsd) {
                            totalValueUsd += valueUsd;
                            balances.push({
                                token: tokenAddress,
                                symbol: parsedInfo.tokenAmount.symbol || "Unknown",
                                amount: amount.toString(),
                                valueUsd,
                                price: priceInfo.price
                            });
                        }
                    }
                }
            }

            // Get verified deposits to show contributors
            const verifiedDeposits = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.TREASURY,
                count: 1000
            });

            // Track deposits per user
            const userDeposits = new Map<string, {
                discordId: string;
                deposits: Array<{
                    token: string;
                    amount: number;
                    valueUsd: number;
                    timestamp: number;
                }>;
                totalValueUsd: number;
                percentageOfTotal: number;
            }>();

            // Process verified deposits
            for (const mem of verifiedDeposits) {
                if (mem.content.type !== "deposit_verified") continue;
                const deposit = mem.content as VerifiedDepositContent;
                if (!deposit.fromAddress || !deposit.amount || !deposit.token) continue;

                // Get the wallet registration to find the Discord user
                const registration = await this.findWalletRegistration(deposit.fromAddress);
                if (!registration?.discordId) continue;

                const priceInfo = await swapService.getTokenPrice(deposit.token);
                if (!priceInfo?.price) continue;

                const valueUsd = Number(deposit.amount) * priceInfo.price;
                
                if (!userDeposits.has(registration.discordId)) {
                    userDeposits.set(registration.discordId, {
                        discordId: registration.discordId,
                        deposits: [],
                        totalValueUsd: 0,
                        percentageOfTotal: 0
                    });
                }

                const userData = userDeposits.get(registration.discordId)!;
                userData.deposits.push({
                    token: deposit.token,
                    amount: Number(deposit.amount),
                    valueUsd,
                    timestamp: deposit.createdAt || Date.now()
                });
                userData.totalValueUsd += valueUsd;
            }

            // Calculate percentages
            for (const userData of userDeposits.values()) {
                userData.percentageOfTotal = (userData.totalValueUsd / totalValueUsd) * 100;
            }

            // Sort users by total value
            const sortedUsers = Array.from(userDeposits.values())
                .sort((a, b) => b.totalValueUsd - a.totalValueUsd);

            // Format response
            const sortedBalances = balances.sort((a, b) => b.valueUsd - a.valueUsd);
            let response = "🏦 **DAO Treasury Overview**\n\n";
            
            // Portfolio Section
            response += "📊 **Current Holdings**\n";
            for (const balance of sortedBalances) {
                const symbol = balance.symbol === "Unknown" ? balance.token : balance.symbol;
                response += `${symbol}:\n`;
                response += `• Amount: ${balance.amount}\n`;
                response += `• Price: $${balance.price.toFixed(4)}\n`;
                response += `• Value: $${balance.valueUsd.toFixed(2)}\n\n`;
            }
            
            response += `💰 **Total Treasury Value**: $${totalValueUsd.toFixed(2)}\n\n`;

            // Contributors Section
            if (sortedUsers.length > 0) {
                response += "👥 **All Contributors**\n";
                for (const user of sortedUsers) {
                    response += `<@${user.discordId}>:\n`;
                    response += `• Total Contributed: $${user.totalValueUsd.toFixed(2)}\n`;
                    response += `• Share of Treasury: ${user.percentageOfTotal.toFixed(2)}%\n`;
                    response += "• Deposits:\n";
                    
                    // Sort deposits by timestamp, newest first
                    const sortedDeposits = user.deposits.sort((a, b) => b.timestamp - a.timestamp);
                    for (const deposit of sortedDeposits) {
                        const date = new Date(deposit.timestamp).toLocaleDateString();
                        response += `  - ${deposit.amount} ${deposit.token} ($${deposit.valueUsd.toFixed(2)}) on ${date}\n`;
                    }
                    response += "\n";
                }
            }

            await this.sendMessage({
                type: "balance_response",
                content: {
                    type: "balance_response",
                    id: stringToUuid(`balance-${Date.now()}`),
                    text: response,
                    status: "executed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                        metadata: {
                        totalValueUsd,
                        balances: sortedBalances,
                        contributors: sortedUsers
                    }
                },
                from: this.runtime.agentType,
                to: "ALL"
            });
        } catch (error) {
            elizaLogger.error("Error checking balance:", error);
            await this.sendMessage({
                type: "balance_response",
                content: {
                    type: "balance_response",
                    id: stringToUuid(`balance-${Date.now()}`),
                    text: "Sorry, I encountered an error checking the DAO treasury balance. Please try again.",
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

    /**
     * Validates if a given string is a valid Solana address by checking if it's on the ed25519 curve
     * @param address The address to validate
     * @returns true if the address is valid, false otherwise
     */
    private async validateSolanaAddress(address: string): Promise<boolean> {
        try {
            const pubKey = new PublicKey(address);
            return PublicKey.isOnCurve(pubKey);
        } catch (error) {
            elizaLogger.debug(`Invalid Solana address format: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    private async handleRegisterCommand(message: AgentMessage): Promise<void> {
        const memoryManager = this.runtime.messageManager;
        
        try {
            // Validate command format
            const text = message.content.text.trim();
            const match = validateCommandWithParam(text, "register", "[1-9A-HJ-NP-Za-km-z]{32,44}");
            if (!match) {
                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-error-${Date.now()}`),
                        text: "Invalid command format. Please use:\n!register <solana_address>\n\nExample:\n!register 7TYC...",
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

            const walletAddress = match[1];

            // Validate that the address is a valid Solana address
            const isValidSolanaAddress = await this.validateSolanaAddress(walletAddress);
            if (!isValidSolanaAddress) {
                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-error-${Date.now()}`),
                        text: "Invalid Solana address. Please provide a valid address that exists on the ed25519 curve.",
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

            // Get user ID using our consistent method
            const userId = this.getUserIdFromMessage(message);
            const existing = await this.getRegisteredWallet(userId);

            // Check existing registration scenarios
            if (existing) {
                if (existing.walletAddress === walletAddress) {
                    // User trying to register the same wallet again
                    await this.sendMessage({
                        type: "register_response",
                        content: {
                            type: "register_response",
                            id: stringToUuid(`register-error-${Date.now()}`),
                            text: "This wallet is already registered to your account. No need to register it again.",
                            status: "failed",
                            agentId: this.runtime.agentId,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        },
                        from: this.runtime.agentType,
                        to: "ALL"
                    });
                    return;
                } else {
                    // User trying to register a different wallet
                    await this.sendMessage({
                        type: "register_response",
                        content: {
                            type: "register_response",
                            id: stringToUuid(`register-error-${Date.now()}`),
                            text: `You already have a wallet registered (${existing.walletAddress}). Each user can only register one wallet. Please use your existing wallet.`,
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
            }

            // Check if wallet is already registered by another user
            const globalRegistration = await this.checkWalletGlobalRegistration(walletAddress);
            if (globalRegistration.isRegistered) {
                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-error-${Date.now()}`),
                        text: `This wallet address is already registered by another user (${globalRegistration.registeredBy}). Each wallet can only be registered once.`,
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

            // Registration logic
            const registrationContext = composeContext({
                state: { 
                    walletAddress,
                    bio: "",
                    lore: "",
                    messageDirections: "{}",
                    postDirections: "{}",
                    message: undefined,
                    roomId: ROOM_IDS.DAO as UUID,
                    actors: "[]",
                    recentMessages: "[]",
                    recentMessagesData: []
                } as RegisterState,
                template: this.registerValidationTemplate
            });
            
            const validationResult = await generateObject({
                runtime: this.runtime,
                context: registrationContext,
                modelClass: ModelClass.SMALL
            }) as unknown as RegisterValidationResult;

            if (!validationResult?.isValid) {
                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-error-${Date.now()}`),
                        text: validationResult?.reason || "Invalid wallet address",
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

            await this.withTransaction('handleRegister', async () => {
                // Check for existing registration for this user
                if (existing && existing.walletAddress !== walletAddress) {
                    throw new Error("User already has a different wallet registered");
                }

                // Create registration record
                await memoryManager.createMemory({
                    id: stringToUuid(`reg-${walletAddress}`),
                    content: {
                        type: "wallet_registration",
                        text: `Connected address ${walletAddress}`,
                        walletAddress,
                        userId,
                        discordId: message.from, // Store original Discord ID
                        status: "executed",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    metadata: {
                            originalDiscordId: message.from, // Additional reference
                            registrationTimestamp: Date.now()
                    }
                },
                roomId: ROOM_IDS.DAO,
                    userId,
                agentId: this.runtime.agentId
            });

                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-success-${Date.now()}`),
                        text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
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
            elizaLogger.error("Error in wallet registration:", {
                error: error instanceof Error ? error.message : 'Unknown error',
                userId: message.from,
                messageId: message.content.id
            });
            
            await this.sendMessage({
                type: "register_response",
                content: {
                    type: "register_response",
                    id: stringToUuid(`register-error-${Date.now()}`),
                    text: `Registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

    private async interpretMessage(message: AgentMessage): Promise<{ confidence: number; actionType: string; walletAddress?: string; transactionSignature?: string }> {
        const text = message.content.text || "";
        const context = composeContext({
            state: {
                message: text,
                bio: "",
                lore: "",
                messageDirections: "{}",
                postDirections: "{}",
                roomId: ROOM_IDS.DAO,
                actors: "[]",
                recentMessages: "[]",
                recentMessagesData: []
            } as State,
            template: treasuryInterpretTemplate
        });

        const result = await generateObject({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        return result as unknown as { confidence: number; actionType: string; walletAddress?: string; transactionSignature?: string };
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            const text = (message.content.text || "").trim();
            if (!text) return;

            // Always try natural language interpretation first
            const interpretation = await this.interpretMessage(message);
            
            // If we have high confidence in the interpretation, use it
            if (interpretation.confidence >= 0.8) {
                switch (interpretation.actionType) {
                    case "register":
                        if (interpretation.walletAddress) {
                            message.content.text = `!register ${interpretation.walletAddress}`;
                            await this.handleRegisterCommand(message);
                            return;
                        }
                        break;

                    case "deposit":
                        await this.handleDepositInstructions(message);
                        return;

                    case "verify":
                        if (interpretation.transactionSignature) {
                            message.content.text = `!verify ${interpretation.transactionSignature}`;
                            await this.handleVerification(message);
                            return;
                        }
                        break;

                    case "balance":
                        await this.handleBalanceCommand(message);
                        return;
                }
            }

            // Handle swap separately since it has its own sophisticated handling
            if (text.toLowerCase().includes('swap')) {
                const swapContext = composeContext({
                    state: {
                        message: text,
                        bio: "",
                        lore: "",
                        messageDirections: "{}",
                        postDirections: "{}",
                        roomId: ROOM_IDS.DAO,
                        actors: "[]",
                        recentMessages: "[]",
                        recentMessagesData: []
                    } as State,
                    template: swapTemplate
                });
                
                const swapParams = await generateObject({
                    runtime: this.runtime,
                    context: swapContext,
                    modelClass: ModelClass.SMALL
                });

                if (swapParams) {
                    return;
                }
            }

            // If interpretation had low confidence, try strict command format as fallback
            const isExactCommand = text.startsWith('!') || text.startsWith('/');
            if (isExactCommand) {
                // Use strict command validation that requires exact format
                if (text === '!balance' || text === '/balance') {
                    await this.handleBalanceCommand(message);
                    return;
                }
                
                const registerMatch = text.match(/^[!/]register\s+([A-HJ-NP-Za-km-z1-9]{32,44})$/);
                if (registerMatch) {
                    await this.handleRegisterCommand(message);
                    return;
                }
                
                if (text === '!deposit' || text === '/deposit') {
                    await this.handleDepositInstructions(message);
                    return;
                }
                
                const verifyMatch = text.match(/^[!/]verify\s+([A-HJ-NP-Za-km-z1-9]{88,})$/);
                if (verifyMatch) {
                    await this.handleVerification(message);
                    return;
                }
            }

            // If we get here, neither interpretation nor command matching worked
            // Send help message with available commands
            const helpMessage = "I'm not sure I understand. You can:\n\n" +
                              "**Register Your Wallet**\n" +
                              "• Register your Solana wallet to participate\n" +
                              "• Example: `!register <wallet_address>` or just tell me 'I want to register my wallet <address>'\n\n" +
                              "**Make Deposits**\n" +
                              "• Get deposit instructions: Ask me 'how do I deposit?' or use `!deposit`\n" +
                              "• Verify your deposit: Tell me 'verify my transaction <signature>' or use `!verify <txn_signature>`\n\n" +
                              "**Check Balances**\n" +
                              "• View treasury holdings: Ask 'what's in the treasury?' or use `!balance`\n" +
                              "• Check specific tokens: Ask 'how much USDC do we have?'\n\n" +
                              "You can use natural language or commands - I'll understand either way!";

            await this.sendMessage({
                type: "help_response",
                content: {
                    type: "help_response",
                    id: stringToUuid(`help-${Date.now()}`),
                    text: helpMessage,
                    status: "executed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.runtime.agentType,
                to: "ALL"
            });

        } catch (error) {
            elizaLogger.error("Error in TreasuryAgent.handleMessage:", error);
            
            // Send error fallback message
            const errorMessage = "I encountered an error processing your request. You can:\n\n" +
                               "**Register Your Wallet**\n" +
                               "• Register your Solana wallet to participate\n" +
                               "• Example: `!register <wallet_address>` or just tell me 'I want to register my wallet <address>'\n\n" +
                               "**Make Deposits**\n" +
                               "• Get deposit instructions: Ask me 'how do I deposit?' or use `!deposit`\n" +
                               "• Verify your deposit: Tell me 'verify my transaction <signature>' or use `!verify <txn_signature>`\n\n" +
                               "**Check Balances**\n" +
                               "• View treasury holdings: Ask 'what's in the treasury?' or use `!balance`\n" +
                               "• Check specific tokens: Ask 'how much USDC do we have?'\n\n" +
                               "You can use natural language or commands - I'll understand either way!";

            await this.sendMessage({
                type: "help_response",
                content: {
                    type: "help_response",
                    id: stringToUuid(`help-error-${Date.now()}`),
                    text: errorMessage,
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

    private async handleProposalExecuted(content: ProposalContent): Promise<void> {
        // Handle any post-execution updates or notifications
        if (content.interpretation?.details.type === 'swap') {
            // Update swap-related state if needed
            await this.updateSwapState(content);
        }
        
        // Log the execution
        elizaLogger.info(`Proposal ${content.id} executed successfully`);
    }

    private async handleProposalEvent(content: ProposalContent): Promise<void> {
        // For base proposals and creation events, we just log and track
        elizaLogger.info(`Processing proposal event: ${content.id}`);
        
        // Create tracking record
        await this.createMemory({
            type: "proposal_tracked",
            id: stringToUuid(`proposal-track-${content.id}`),
            text: `Tracking proposal ${content.id}`,
            status: "executed",
            agentId: this.runtime.agentId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
                        metadata: {
                proposalId: content.id,
                proposalType: content.interpretation?.details.type,
                timestamp: Date.now()
            }
        });
    }

    private async updateSwapState(proposal: ProposalContent): Promise<void> {
        if (!this.isProposalWithSwap(proposal)) return;
        
        const details = proposal.interpretation?.details as SwapDetails;
        
        // Update any swap-related state, balances, etc.
        await this.createMemory({
            type: "swap_state_updated",
            id: stringToUuid(`swap-state-${proposal.id}`),
            text: `Updated swap state for proposal ${proposal.id}`,
            status: "executed",
            agentId: this.runtime.agentId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
                proposalId: proposal.id,
                swapDetails: {
                    maxSlippage: 1.0, // Default 1% slippage
                    minOutputAmount: 0 // Will be calculated based on amount and price
                }
            }
        });
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        try {
            if (!await this.validateAction(content)) {
                return false;
            }

            // Since we've validated the content, we can safely cast
            switch (content.type) {
                case "proposal":
                case "proposal_created":
                case "proposal_passed":
                    if (this.isProposalContent(content)) {
                        await this.handleProposalEvent(content);
                        return true;
                    }
                    break;
                case "proposal_executed":
                    if (this.isProposalContent(content)) {
                        await this.handleProposalExecuted(content);
                        return true;
                    }
                    break;
                case "swap_request":
                    if (this.isSwapRequest(content)) {
                        await this.handleSwapRequest(content);
                        return true;
                    }
                    break;
                case "deposit_received":
                    if (this.isDepositContent(content)) {
                        await this.handleDeposit(content);
                        return true;
                    }
                    break;
                case "transfer_requested":
                    if (this.isTransferContent(content)) {
                        await this.handleTransfer(content);
                        return true;
                    }
                    break;
                case "strategy_triggered":
                    if (this.isStrategyWithSwap(content)) {
                        await this.handleStrategyExecution(content);
                        return true;
                    }
                    break;
                case "transaction_status_update":
                    if (this.isValidTransactionUpdate(content)) {
                        await this.handleTransaction(content as TreasuryTransaction);
                        return true;
                    }
                    break;
            }
            return false;
        } catch (error) {
            elizaLogger.error("Error executing action:", error);
            return false;
        }
    }

    public async validateAction(content: BaseContent): Promise<boolean> {
        if (!content || typeof content !== 'object') {
            return false;
        }

        switch (content.type) {
            case "proposal":
            case "proposal_created":
            case "proposal_passed":
            case "proposal_executed":
                return this.isProposalContent(content);
            case "swap_request":
                return this.isSwapRequest(content);
            case "deposit_received":
                return this.isDepositContent(content);
            case "transfer_requested":
                return this.isTransferContent(content);
            case "strategy_triggered":
                return this.isStrategyWithSwap(content);
            case "transaction_status_update":
                return this.isValidTransactionUpdate(content);
            default:
                return false;
        }
    }

    private async handleTransaction(transaction: TreasuryTransaction): Promise<void> {
        try {
            await this.createMemory({
                type: "transaction_status_update",
                id: stringToUuid(`tx-status-${transaction.id}`),
                text: `Transaction ${transaction.txHash} status updated to ${transaction.status}`,
                status: transaction.status,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    txHash: transaction.txHash,
                    status: transaction.status,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling transaction status change:", error);
            throw error;
        }
    }

    private isValidTransactionUpdate(content: any): boolean {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'transaction_status_update' &&
            'txHash' in content &&
            'status' in content &&
            'timestamp' in content;
    }

    // Add missing required methods
    private isBaseContent(value: unknown): value is BaseContent {
        return typeof value === 'object' && value !== null &&
            'type' in value && typeof value.type === 'string' &&
            'id' in value && typeof value.id === 'string' &&
            'text' in value && typeof value.text === 'string' &&
            'agentId' in value && typeof value.agentId === 'string';
    }

    protected async getUserProfile(userId: UUID): Promise<{ reputation?: number; role?: string; } | null> {
        const profiles = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
            count: 1
        });
        
        const profile = profiles.find(p => 
            p.content.type === "user_profile" && 
            p.content.userId === userId
        );

        if (!profile) return null;

        const content = profile.content as UserProfile;
        return {
            reputation: typeof content.reputation === 'number' ? content.reputation : undefined,
            role: typeof content.role === 'string' ? content.role : undefined
        };
    }

    protected async executeWithValidation<T extends Record<string, unknown>, R>(
        operation: string,
        params: T,
        executor: (params: T) => Promise<R>
    ): Promise<R> {
        try {
            const unknownParams = params as unknown;
            if (this.isBaseContent(unknownParams)) {
                const validationResult = await this.validateAction(unknownParams);
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

    protected setupMemorySubscriptions(): void {
        // Call parent implementation first
        super.setupMemorySubscriptions();

        // Add Treasury-specific subscriptions
        this.subscribeToMemory("proposal_status_changed", async (memory) => {
            const content = memory.content as BaseContent;
            // Only handle proposals that have passed (status changed to pending_execution)
            if (this.isProposalContent(content) && content.status === "pending_execution") {
                await this.handleProposalEvent(content as ProposalContent);
            }
        });

        this.subscribeToMemory("swap_request", async (memory) => {
            const content = memory.content as BaseContent;
            if (this.isSwapRequest(content)) {
                await this.handleSwapRequest(content as SwapRequest);
            }
        });

        this.subscribeToMemory("strategy_triggered", async (memory) => {
            const content = memory.content as BaseContent;
            if (this.isStrategyWithSwap(content)) {
                await this.handleStrategyExecution(content as StrategyExecutionRequest);
            }
        });

        this.subscribeToMemory("deposit_received", async (memory) => {
            const content = memory.content as BaseContent;
            if (this.isDepositContent(content)) {
                await this.handleDeposit(content as DepositContent);
            }
        });

        this.subscribeToMemory("transfer_requested", async (memory) => {
            const content = memory.content as BaseContent;
            if (this.isTransferContent(content)) {
                await this.handleTransfer(content as TransferContent);
            }
        });

        this.subscribeToMemory("transaction_status_changed", async (memory) => {
            const content = memory.content as TreasuryTransaction;
            await this.handleTransaction(content);
        });

        this.subscribeToMemory("swap_execution_result", async (memory) => {
            const content = memory.content as SwapExecutionResult;
            await this.handleSwapResult(content);
        });
    }

    private async checkWalletGlobalRegistration(walletAddress: string): Promise<{ isRegistered: boolean; registeredBy?: string }> {
        try {
            // Get all wallet registrations
            const registrations = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000 // Get a large number to ensure we catch all registrations
            });

            // Find any registration with this wallet address
            const existingRegistration = registrations.find(mem => {
                if (mem.content.type !== 'wallet_registration') {
                    return false;
                }
                const registration = mem.content as { walletAddress?: string; status?: string; discordId?: string };
                return registration.walletAddress === walletAddress && 
                       registration.status === "executed"; // Only consider successful registrations
            });

            if (existingRegistration) {
                const registration = existingRegistration.content as { discordId?: string };
        return {
                    isRegistered: true,
                    registeredBy: registration.discordId || 'unknown user'
                };
            }

            return { isRegistered: false };
        } catch (error) {
            elizaLogger.error('Error checking global wallet registration:', error);
            throw error;
        }
    }

    private async findWalletRegistration(walletAddress: string): Promise<{ discordId: string } | null> {
        try {
            const registrations = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000
            });

            const registration = registrations.find(reg => 
                reg.content.type === "wallet_registration" &&
                reg.content.status === "executed" &&
                typeof reg.content.walletAddress === 'string' &&
                reg.content.walletAddress.toLowerCase() === walletAddress.toLowerCase()
            );

            if (registration?.content && 
                typeof registration.content === 'object' && 
                'discordId' in registration.content &&
                typeof registration.content.discordId === 'string') {
                return { discordId: registration.content.discordId };
            }

            return null;
        } catch (error) {
            elizaLogger.error("Error finding wallet registration:", error);
            return null;
        }
    }

    private isStrategyContent(content: BaseContent): boolean {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'strategy' &&
            'status' in content;
    }
}

// Add after other interfaces
export const swapTemplate = `You are a swap parameter extractor. Your task is to extract swap parameters from the user's message and format them in JSON.

PREPROCESSING INSTRUCTIONS:
1. EXACT PATTERN MATCHING:
    - "swap X [TOKEN1] for [TOKEN2]" → amount=X (MUST be a number), input=TOKEN1, output=TOKEN2
    - "swap [TOKEN1] for [TOKEN2]" → amount=null, input=TOKEN1, output=TOKEN2

2. TOKEN ADDRESS RULES:
    - If you see "SOL" (case-insensitive), you MUST use "So11111111111111111111111111111111111111112"
    - If you see a 44-character address, you MUST use it EXACTLY as provided
    - DO NOT try to resolve any other token symbols to addresses
    - DO NOT make up or generate random addresses
    - DO NOT try to guess token symbols or addresses

3. AMOUNT RULES:
    - CRITICAL: The amount MUST be returned as a NUMBER, not a string
    - Extract the EXACT number that appears after "swap" and before the input token
    - DO NOT modify, round, or change the amount in any way
    - Use the EXACT amount specified in the message (e.g., if user says "swap 3500", use 3500)
    - Support both whole numbers (3500) and decimals (3500.5)
    - If no amount is found, return null
    - NEVER make up or guess an amount - use exactly what's in the message

4. CRITICAL: When you see a 44-character address like "CwismAYtSdQbo3MLLY4mob31UhF6kwo1ZG835L3eDqFw":
    - If it's the input token, set inputTokenCA to this exact address
    - If it's the output token, set outputTokenCA to this exact address
    - Set the corresponding tokenSymbol to null

5. CRITICAL: When you see "SOL" (case-insensitive):
    - You MUST set the tokenSymbol to "SOL"
    - You MUST set the tokenCA to "So11111111111111111111111111111111111111112"
    - This applies to both input and output tokens`;

// Add timeout configurations
const SWAP_TIMEOUTS = {
    SECURITY_CHECK: 1000, // 1 second
    QUOTE: 3000,          // 3 seconds
    SWAP: 15000,          // 15 seconds
};

// Add token validation functions
function validateTokenAddress(address: string | null): boolean {
    if (!address) return false;
    if (address === settings.SOL_ADDRESS) return true;
    // Allow standard Solana addresses and PumpFun addresses ending with 'pump'
    return /^[A-HJ-NP-Za-km-z1-9]{43,44}(?:pump)?$/.test(address);
}

function extractTokenAddresses(text: string): { input: string | null; output: string | null } {
    const addresses: string[] = [];
    // Updated pattern to match both standard and PumpFun addresses
    const pattern = /([A-HJ-NP-Za-km-z1-9]{43,44}(?:pump)?)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (validateTokenAddress(match[1])) {
            addresses.push(match[1]);
        }
    }
    if (addresses.length === 2) {
        return { input: addresses[0], output: addresses[1] };
    }
    if (addresses.length === 1) {
        const forIndex = text.toLowerCase().indexOf("for");
        if (forIndex === -1) return { input: addresses[0], output: null };
        const addressIndex = text.indexOf(addresses[0]);
        return addressIndex < forIndex
            ? { input: addresses[0], output: null }
            : { input: null, output: addresses[0] };
    }
    return { input: null, output: null };
}

function detectSOLToken(text: string, position: "input" | "output"): boolean {
    const normalizedText = text.toLowerCase();
    const solPattern = /\b(sol|wsol)\b/;
    if (position === "output") {
        const forIndex = normalizedText.indexOf("for");
        if (forIndex === -1) return false;
        const textAfterFor = normalizedText.slice(forIndex);
        return solPattern.test(textAfterFor);
    } else {
        const forIndex = normalizedText.indexOf("for");
        if (forIndex === -1) return solPattern.test(normalizedText);
        const textBeforeFor = normalizedText.slice(0, forIndex);
        return solPattern.test(textBeforeFor);
    }
}

// Add parameter extraction
function parseUserAmount(text: string): number | null {
    try {
        const cleanText = text.toLowerCase().replace(/[$,]/g, "");
        const swapMatch = cleanText.match(/swap\s+(\d*\.?\d+)/i);
        if (swapMatch) {
            const amount = parseFloat(swapMatch[1]);
            return !isNaN(amount) ? amount : null;
        }
        return null;
    } catch {
        return null;
    }
}

// Add LLM response validation
const validateLLMResponse = (content: any, messageText: string) => {
    elizaLogger.info("Validating LLM response:", content);
    const extractedAddresses = extractTokenAddresses(messageText);
    const extractedAmount = parseUserAmount(messageText);
    if (extractedAmount !== null) {
        content.amount = extractedAmount;
        elizaLogger.info("Using extracted amount:", extractedAmount);
    } else {
        content.amount = null;
        elizaLogger.warn("Could not extract amount from message");
    }
    if (
        !validateTokenAddress(content.inputTokenCA) ||
        (extractedAddresses.input && content.inputTokenCA !== extractedAddresses.input)
    ) {
        content.inputTokenCA = extractedAddresses.input;
        elizaLogger.info("Corrected input token address:", content.inputTokenCA);
    }
    if (
        !validateTokenAddress(content.outputTokenCA) ||
        (extractedAddresses.output && content.outputTokenCA !== extractedAddresses.output)
    ) {
        content.outputTokenCA = extractedAddresses.output;
        elizaLogger.info("Corrected output token address:", content.outputTokenCA);
    }
    if (detectSOLToken(messageText, "input")) {
        content.inputTokenSymbol = "SOL";
        content.inputTokenCA = settings.SOL_ADDRESS;
        elizaLogger.info("Set input token to SOL");
    }
    if (detectSOLToken(messageText, "output")) {
        content.outputTokenSymbol = "SOL";
        content.outputTokenCA = settings.SOL_ADDRESS;
        elizaLogger.info("Set output token to SOL");
    }
    return content;
};

// Add pool reserve checks
async function checkPoolReserves(
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number
): Promise<boolean> {
    try {
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
        const response = await fetch(quoteUrl);
        const data = await response.json() as JupiterQuoteResponse;
        if (data.error) {
            elizaLogger.warn("Pool reserve check failed:", data.error);
            return false;
        }
        const priceImpact = data.priceImpactPct ?? 0;
        if (priceImpact > 10) {
            elizaLogger.warn("Price impact too high:", priceImpact);
            return false;
        }
        return true;
    } catch (error) {
        elizaLogger.error("Error checking pool reserves:", error);
        return false;
    }
}