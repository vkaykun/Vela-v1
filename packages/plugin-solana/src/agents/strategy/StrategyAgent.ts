// packages/plugin-solana/src/agents/strategy/StrategyAgent.ts

import {
    IAgentRuntime,
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
import { 
    AgentType, 
    BaseContent, 
    ContentStatus, 
    DistributedLock,
    AgentMessage,
    ContentStatusIndex,
    getContentStatus,
    ServiceType 
} from "../../shared/types/base.ts";
import {
    StrategyContent,
    StrategyType,
    StrategyCondition,
    StrategyExecution,
    PositionUpdate,
    StrategyExecutionRequest,
    StrategyExecutionResult,
    StrategyStatus,
    Position,
    StrategyConfig
} from "../../shared/types/strategy.ts";
import { SwapRequest } from "../../shared/types/treasury.ts";
import { DAOMemoryType, DAOMemoryContent, createMemoryContent, createStrategyMemoryContent } from "../../shared/types/memory.ts";
import { TokenProvider } from "../../providers/token.ts";
import { WalletProvider } from "../../providers/wallet.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import crypto from 'crypto';
import { ROOM_IDS } from "../../shared/constants.ts";
import { IAgentRuntime as SolanaAgentRuntime } from "../../shared/types/base.ts";
import { StrategyExecutor } from "../../services/strategyExecutor.ts";
import { SwapService } from "../../services/swapService.ts";
import { readAgentBalanceForToken } from "../../utils/swapUtilsOrAtaHelper.ts";
import { TOKEN_MINTS } from "../../utils/governanceUtils.ts";
import { ProposalContent } from "../../shared/types/vote.ts";
import { StrategyDetails } from "../../shared/types/proposal.ts";
import { UserProfile } from "../../shared/types/user.ts";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import { tokeninfo } from "../../actions/tokeninfo.js";

// Extend the core ServiceType
declare module "@elizaos/core" {
    export enum ServiceType {
        STRATEGY_EXECUTOR = "STRATEGY_EXECUTOR"
    }
}

// Update the strategy interpretation template to be more sophisticated
const strategyInterpretTemplate = `# Task: Interpret user's strategy command for trading
You are a strategy interpreter responsible for understanding trading strategy commands.

The user's message is: "{{message.content.text}}"
Current entry price: {{entryPrice}}

# Strategy Types:
1. TAKE_PROFIT - Set profit targets with optional sell percentages
2. STOP_LOSS - Set stop loss level
3. TRAILING_STOP - Dynamic stop loss that follows price
4. DCA - Dollar cost averaging strategy
5. GRID - Grid trading strategy
6. REBALANCE - Portfolio rebalancing strategy

# Common Patterns:
- Take Profit: "tp at X%" or "take profit at X%" (with optional "sell Y%")
- Stop Loss: "sl at X%" or "stop loss at X%"
- Trailing Stop: "trailing stop X%" or "ts X%"
- Multiple TPs: "tp1 at X%, tp2 at Y%" or "tp at X% (sell A%), Y% (sell B%)"
- Combined: "tp at X%, sl at Y%" or "tp X% sell A%, Y% sell B%, sl Z%"

# Response Format:
Return a JSON object with these fields:
{
    "type": "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "DCA" | "GRID" | "REBALANCE",
    "token": "string (token symbol or address)",
    "baseToken": "string (usually USDC)",
    "takeProfitLevels": [
        {
            "percentage": number,
            "sellAmount": number,
            "price": number (calculated from entry price)
        }
    ],
    "stopLoss": {
        "percentage": number,
        "price": number (calculated from entry price),
        "isTrailing": boolean,
        "trailingDistance": number (if trailing stop)
    }
}

# Examples:
User: "set tp at 20% and 50%, sl at 10%"
{
    "type": "TAKE_PROFIT",
    "token": "SOL",
    "baseToken": "USDC",
    "takeProfitLevels": [
        {
            "percentage": 20,
            "sellAmount": 50,
            "price": (entryPrice * 1.2)
        },
        {
            "percentage": 50,
            "sellAmount": 50,
            "price": (entryPrice * 1.5)
        }
    ],
    "stopLoss": {
        "percentage": 10,
        "price": (entryPrice * 0.9),
        "isTrailing": false
    }
}

User: "trailing stop 5%"
{
    "type": "TRAILING_STOP",
    "token": "SOL",
    "baseToken": "USDC",
    "stopLoss": {
        "percentage": 5,
        "price": (entryPrice * 0.95),
        "isTrailing": true,
        "trailingDistance": 5,
        "highestPrice": entryPrice
    }
}

# Instructions:
1. Identify the strategy type from the command
2. Extract token if specified (default to SOL)
3. Parse all numeric values (percentages, amounts)
4. Calculate actual prices based on entry price
5. Validate all numbers are positive and reasonable
6. For take profits:
   - Split sell amounts evenly if not specified
   - Ensure total sell amounts don't exceed 100%
   - Sort levels by percentage ascending
7. For stop losses:
   - Detect if it's a trailing stop
   - Set trailing distance if applicable
8. Return null if the command cannot be interpreted

# Now interpret the user's strategy command.`;

// Update StrategyInterpretation interface to match StrategyConfig exactly
interface StrategyInterpretation {
    type: StrategyType;
    token: string;
    baseToken: string;
    // Take Profit fields
    takeProfitLevels: Array<{
        percentage: number;
        sellAmount: number;
        price?: number;
    }>;
    // Stop Loss fields
    stopLoss?: {
        percentage: number;
        price?: number;
        isTrailing?: boolean;
        trailingDistance?: number;
        highestPrice?: number;
    };
    // DCA fields
    amount?: number;
    interval?: number;
    duration?: number;
    // Grid fields
    gridLevels?: Array<{
        price: number;
        amount: number;
    }>;
    // Rebalance fields
    targetAllocations?: Array<{
        token: string;
        percentage: number;
        amount?: number;
    }>;
    rebalanceThreshold?: number;
    // Common fields
    timeLimit?: {
        timestamp: number;
        action: "sell" | "hold";
    };
}

// Update message types
interface BaseMessage extends Record<string, any> {
    type: string;
    id: UUID;
    text: string;
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
    status: ContentStatus;
}

interface ErrorMessage extends BaseMessage {
    type: "error";
    status: "failed";
}

interface StrategyCreatedMessage extends BaseMessage {
    type: "strategy_created";
    status: "executed";
}

// Update message state type
interface MessageState extends State {
    message: {
        content: {
            text: string;
        };
    };
    entryPrice: number;
}

interface SwapCompletedContent extends BaseContent {
    success: boolean;
    swapId: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount: string;
    metadata?: {
        inputSymbol?: string;
        outputSymbol?: string;
    };
}

interface StrategyCancelledContent extends BaseContent {
    type: "strategy_cancelled";
    positionId: string;
}

export class StrategyAgent extends BaseAgent {
    private walletProvider: WalletProvider;
    private tokenProvider: TokenProvider;
    private strategyExecutor: StrategyExecutor;
    private swapService: SwapService;
    private monitoringInterval: NodeJS.Timeout | null = null;
    private agentSettings: {
        monitoringInterval: number;
        maxStrategiesPerUser: number;
        minTokenBalance: number;
        maxSlippage: number;
        defaultBaseToken: string;
    };

    // Pattern constants for strategy parsing
    private readonly TP_VARIATIONS = [
        'tp at', 'tp', 'take profit at', 'take profit',
        'target at', 'target', 'sell at', 't/p at', 't/p'
    ];

    private readonly SL_VARIATIONS = [
        'sl at', 'sl', 'stop loss at', 'stop loss',
        'stop at', 'stop', 's/l at', 's/l'
    ];

    private readonly TRAILING_VARIATIONS = [
        'trailing', 'trailing stop', 'trailing sl',
        'trailing stop loss', 'ts', 't/s'
    ];

    private readonly SPLIT_VARIATIONS = [
        'sell', 'split', 'size'
    ];

    constructor(runtime: ExtendedAgentRuntime) {
        super(runtime);
        
        // Initialize settings with environment-based defaults
        this.agentSettings = {
            monitoringInterval: parseInt(this.runtime.getSetting("strategyMonitoringInterval") || "60000"),
            maxStrategiesPerUser: parseInt(this.runtime.getSetting("maxStrategiesPerUser") || "10"),
            minTokenBalance: parseFloat(this.runtime.getSetting("minTokenBalance") || "0.1"),
            maxSlippage: parseFloat(this.runtime.getSetting("maxSlippage") || "1.0"),
            defaultBaseToken: this.runtime.getSetting("defaultBaseToken") || "USDC"
        };

        // Initialize providers and services
        const connection = new Connection(
            this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        
        const walletPubkey = new PublicKey(this.id);
        this.walletProvider = new WalletProvider(connection, walletPubkey);
        this.tokenProvider = new TokenProvider(
            "So11111111111111111111111111111111111111112",
            this.walletProvider,
            this.runtime.cacheManager
        );
        this.strategyExecutor = new StrategyExecutor(
            this.runtime,
            this.swapService
        );
        this.swapService = new SwapService(this.runtime);
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // Subscribe to proposal events
        this.messageBroker.on("proposal_passed", async (event) => {
            if (this.isBaseContent(event)) {
                await this.handleProposalPassed(event as ProposalContent);
            }
        });

        this.messageBroker.on("proposal_executed", async (event) => {
            if (this.isBaseContent(event)) {
                await this.handleProposalExecuted(event as ProposalContent);
            }
        });
    }

    private registerCapabilities(): void {
        this.registerCapability({
            name: "strategy_management",
            description: "Create and manage trading strategies",
            requiredPermissions: ["manage_strategies"],
            actions: ["create", "update", "cancel"]
        });

        this.registerCapability({
            name: "position_monitoring",
            description: "Monitor positions and execute strategies",
            requiredPermissions: ["monitor_positions", "execute_trades"],
            actions: ["monitor", "execute"]
        });
    }

    public async initialize(): Promise<void> {
        await super.initialize();
        
        // Subscribe to strategy-related updates
        this.subscribeToMemory("strategy", this.handleStrategyUpdate.bind(this));
        this.subscribeToMemory("position_update", async (memory) => {
            // Forward to StrategyExecutor
            const content = memory.content as PositionUpdate;
            if (content.type === "position_update" && content.id) {
                await this.strategyExecutor.updatePositionAmount(
                    content.id,
                    content.soldAmount ? parseFloat(content.soldAmount) : 0,
                    content.remainingAmount ? parseFloat(content.remainingAmount) : 0,
                    parseFloat(content.price),
                    'take_profit' // Default to take_profit if not specified
                );
            }
        });
        this.subscribeToMemory("strategy_execution_request", this.handleExecutionRequest.bind(this));
        this.subscribeToMemory("strategy_execution", async (memory) => {
            // Forward to StrategyExecutor
            const content = memory.content as StrategyContent;
            if (!content.id || typeof content.id !== 'string') {
                elizaLogger.error("Invalid strategy execution content: missing or invalid id");
                return;
            }

            const position = await this.strategyExecutor.getLatestPosition(memory.userId);
            if (position) {
                const positionUpdate: PositionUpdate = {
                    type: "position_update",
                    id: stringToUuid(`pos-update-${position.id}-${Date.now()}`),
                    text: `Position update for ${position.token}`,
                    token: position.token,
                    baseToken: "USDC",
                    price: position.entryPrice.toString(),
                    size: position.amount.toString(),
                    value: (position.amount * position.entryPrice).toString(),
                    activeStrategies: [stringToUuid(content.id)],
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "executed"
                };
                await this.strategyExecutor.executeStrategy(content, positionUpdate);
            }
        });
        this.subscribeToMemory("strategy_execution_result", this.handleExecutionResult.bind(this));
        this.subscribeToMemory("strategy_cancelled", async (memory) => {
            // Forward to StrategyExecutor
            const content = memory.content as unknown as StrategyCancelledContent;
            if (content.type === "strategy_cancelled" && content.positionId) {
                await this.strategyExecutor.cancelStrategy(content.positionId);
            }
        });
        this.subscribeToMemory("proposal_passed", this.handleProposalPassed.bind(this));
        this.subscribeToMemory("proposal_executed", this.handleProposalExecuted.bind(this));
        this.subscribeToMemory("swap_completed", this.handleSwapCompleted.bind(this));

        elizaLogger.info("Strategy agent initialized");

        // Start strategy monitoring with proper concurrency
        this.monitoringInterval = setInterval(async () => {
            const lock = await this.acquireDistributedLock('strategy-monitoring');
            if (!lock) {
                elizaLogger.debug('Could not acquire strategy monitoring lock, skipping this iteration');
                return;
            }

            try {
                const strategies = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.STRATEGY,
                    count: 1000
                });

                const activeStrategies = strategies.filter(mem =>
                    mem.content.type === "strategy" &&
                    mem.content.status === "active"
                );

                for (const strategy of activeStrategies) {
                    // Acquire a lock specific to this strategy
                    const strategyLock = await this.acquireDistributedLock(`strategy-${strategy.content.id}`);
                    if (!strategyLock) {
                        elizaLogger.debug(`Could not acquire lock for strategy ${strategy.content.id}, skipping`);
                        continue;
                    }

                    try {
                        await this.checkStrategyConditions(strategy.content as StrategyContent);
                    } finally {
                        await this.releaseDistributedLock(strategyLock);
                    }
                }
            } catch (error) {
                elizaLogger.error("Error in strategy monitoring:", error);
            } finally {
                await this.releaseDistributedLock(lock);
            }
        }, this.agentSettings.monitoringInterval);
    }

    public async shutdown(): Promise<void> {
        // Clear monitoring interval
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }

        // Call base shutdown
        await super.shutdown();
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            const text = (message.content?.text || "").trim();
            if (!text) return;

            // Strategy commands
            if (text.startsWith("!strategy") || text.toLowerCase().includes("set tp") || text.toLowerCase().includes("stop loss")) {
                await this.handleStrategyCommand(message);
                return;
            }

            // Cancel strategy
            if (text.startsWith("!cancel") || text.toLowerCase().includes("cancel strategy")) {
                await this.handleCancelStrategyCommand(message);
                return;
            }

            // Default fallback
            elizaLogger.debug(`Unhandled message in StrategyAgent: ${text}`);
        } catch (error) {
            elizaLogger.error("Error in StrategyAgent.handleMessage:", error);
        }
    }

    // Update sendMessage helper
    private async sendAgentMessage(message: BaseMessage, to: AgentType): Promise<void> {
        await this.sendMessage({
            type: "agent_message",
            content: message,
            from: this.runtime.agentType as AgentType,
            to
        });
    }

    // Update handleStrategyCommand to use StrategyExecutor
    private async handleStrategyCommand(message: AgentMessage): Promise<void> {
        try {
            await this.withTransaction("handleStrategyCommand", async () => {
                // Parse strategy from natural language
                const strategy = await this.interpretStrategy(message.content.text, 0);
                if (!strategy) {
                    const errorMessage: ErrorMessage = {
                        type: "error",
                        text: "I couldn't understand the strategy. Please use formats like:\n" +
                             "• \"set tp at 20% and 50%, sl at 10%\"\n" +
                             "• \"exit when price drops below entry\"",
                        id: stringToUuid(`error-${Date.now()}`),
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: "failed"
                    };
                    await this.sendAgentMessage(errorMessage, message.from);
                    return;
                }

                // Get token mint address
                const tokenMintAddress = TOKEN_MINTS[strategy.token.toUpperCase() as keyof typeof TOKEN_MINTS] || strategy.token;

                // Verify treasury has a balance of this token
                const tokenBalance = await readAgentBalanceForToken(this.runtime, tokenMintAddress);
                if (!tokenBalance || tokenBalance <= 0) {
                    const errorMessage: ErrorMessage = {
                        type: "error",
                        text: `The treasury does not hold any ${strategy.token} tokens. Please acquire some tokens before setting up a strategy.`,
                        id: stringToUuid(`error-${Date.now()}`),
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: "failed"
                    };
                    await this.sendAgentMessage(errorMessage, message.from);
                    return;
                }

                // Get current price for reference
                const currentPrice = await this.swapService.getTokenPrice(strategy.token);
                if (!currentPrice || currentPrice.error) {
                    const errorMessage: ErrorMessage = {
                        type: "error",
                        text: "Could not get current token price. Please try again later.",
                        id: stringToUuid(`error-${Date.now()}`),
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        status: "failed"
                    };
                    await this.sendAgentMessage(errorMessage, message.from);
                    return;
                }

                // Get or create position
                const existingPosition = await this.strategyExecutor.getLatestPosition(message.from);
                const position: Position = existingPosition || {
                    id: stringToUuid(`pos-${strategy.token}-${Date.now()}`),
                    txSignature: `strategy-${Date.now()}`, // Required for Position type
                    token: strategy.token,
                    amount: tokenBalance,
                    entryPrice: currentPrice.price,
                    timestamp: Date.now(),
                    status: 'active' as const,
                    userId: message.from,
                    remainingAmount: tokenBalance
                };

                // Attach strategy to position
                await this.strategyExecutor.attachStrategy(position, strategy);

                // Create success message
                const successMessage: StrategyCreatedMessage = {
                    type: "strategy_created",
                    id: stringToUuid(`strategy-${Date.now()}`),
                    text: `Strategy set for treasury's ${position.token} position:\n` +
                          `Current Balance: ${tokenBalance} ${position.token}\n` +
                          `Current Price: $${currentPrice.price.toFixed(4)}\n` +
                          this.formatStrategyDetails(strategy) +
                          `\n\nI'll monitor the position and execute automatically when conditions are met.`,
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "executed"
                };

                await this.sendAgentMessage(successMessage, message.from);
            });
        } catch (error) {
            elizaLogger.error("Error handling strategy command:", error);
            
            const errorMessage: ErrorMessage = {
                type: "error",
                text: `Failed to set strategy: ${error instanceof Error ? error.message : String(error)}`,
                id: stringToUuid(`error-${Date.now()}`),
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "failed"
            };
            await this.sendAgentMessage(errorMessage, message.from);
        }
    }

    private formatStrategyDetails(strategy: StrategyInterpretation): string {
        let details = '';
        
        switch (strategy.type) {
            case 'TAKE_PROFIT':
                if (strategy.takeProfitLevels.length > 0) {
                    strategy.takeProfitLevels.forEach((tp, index) => {
                        details += `Take Profit ${index + 1}: ${tp.percentage}% (sell ${tp.sellAmount}%)\n`;
                    });
                }
                break;

            case 'STOP_LOSS':
                if (strategy.stopLoss) {
                    details += `Stop Loss: ${strategy.stopLoss.percentage}%\n`;
                }
                break;

            case 'TRAILING_STOP':
                if (strategy.stopLoss) {
                    details += `Trailing Stop: ${strategy.stopLoss.percentage}% (Distance: ${strategy.stopLoss.trailingDistance}%)\n`;
                }
                break;

            case 'DCA':
                details += `DCA Strategy:\n` +
                    `Amount: ${strategy.amount} ${strategy.token}\n` +
                    `Interval: ${strategy.interval} minutes\n` +
                    `Duration: ${strategy.duration} days\n`;
                break;

            case 'GRID':
                if (strategy.gridLevels) {
                    details += `Grid Strategy:\n`;
                    strategy.gridLevels.forEach((level, index) => {
                        details += `Level ${index + 1}: ${level.price} (${level.amount} ${strategy.token})\n`;
                    });
                }
                break;

            case 'REBALANCE':
                if (strategy.targetAllocations) {
                    details += `Rebalance Strategy:\n` +
                        `Threshold: ${strategy.rebalanceThreshold}%\n` +
                        `Target Allocations:\n`;
                    strategy.targetAllocations.forEach(allocation => {
                        details += `${allocation.token}: ${allocation.percentage}%\n`;
                    });
                }
                break;
        }

        if (strategy.timeLimit) {
            details += `Time-based exit: ${new Date(strategy.timeLimit.timestamp).toLocaleString()}\n`;
        }

        return details;
    }

    // Add helper methods for parsing
    private createVariationPattern(variations: string[]): string {
        return variations.map(v => v.replace('/', '\\/')).join('|');
    }

    private async parseNaturalLanguageStrategy(text: string, entryPrice: number): Promise<StrategyConfig | null> {
        try {
            const strategy: StrategyConfig = {
                takeProfitLevels: []
            };

            const normalizedText = text.toLowerCase()
                .replace(/[,]/g, ' ')
                .replace(/\s+/g, ' ')
                .replace(/(\d+)%/g, '$1 %')
                .replace(/\(/g, ' ')
                .replace(/\)/g, ' ')
                .trim();

            const tpPattern = new RegExp(`(?:${this.createVariationPattern(this.TP_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%(?:\\s*(?:${this.createVariationPattern(this.SPLIT_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%)?`, 'g');
            const trailingPattern = new RegExp(`(?:${this.createVariationPattern(this.TRAILING_VARIATIONS)})(?:\\s+stop)?(?:\\s+at)?\\s*(\\d*\\.?\\d+)\\s*%`);
            const slPattern = new RegExp(`(?:${this.createVariationPattern(this.SL_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%`);

            const tpMatches = Array.from(normalizedText.matchAll(tpPattern));
            let remainingSellAmount = 100;

            if (tpMatches.length > 0) {
                for (const match of tpMatches) {
                    const percentage = parseFloat(match[1]);
                    let sellAmount: number;

                    if (match[2]) {
                        sellAmount = parseFloat(match[2]);
                        if (sellAmount > remainingSellAmount) {
                            sellAmount = remainingSellAmount;
                        }
                    } else {
                        sellAmount = Math.floor(remainingSellAmount / (tpMatches.length - strategy.takeProfitLevels.length));
                    }

                    if (!isNaN(percentage) && percentage > 0 && sellAmount > 0) {
                        strategy.takeProfitLevels.push({
                            percentage,
                            price: entryPrice * (1 + (percentage / 100)),
                            sellAmount
                        });
                        remainingSellAmount -= sellAmount;
                    }

                    if (remainingSellAmount <= 0) break;
                }

                if (remainingSellAmount > 0 && strategy.takeProfitLevels.length > 0) {
                    strategy.takeProfitLevels[strategy.takeProfitLevels.length - 1].sellAmount += remainingSellAmount;
                }
            }

            const trailingMatch = normalizedText.match(trailingPattern);
            if (trailingMatch) {
                const percentage = parseFloat(trailingMatch[1]);
                if (!isNaN(percentage) && percentage > 0) {
                    strategy.stopLoss = {
                        percentage,
                        price: entryPrice * (1 - (percentage / 100)),
                        isTrailing: true,
                        trailingDistance: percentage,
                        highestPrice: entryPrice
                    };
                }
            } else {
                const slMatch = normalizedText.match(slPattern);
                if (slMatch) {
                    const percentage = parseFloat(slMatch[1]);
                    if (!isNaN(percentage) && percentage > 0) {
                        strategy.stopLoss = {
                            percentage,
                            price: entryPrice * (1 - (percentage / 100)),
                            isTrailing: false
                        };
                    }
                }
            }

            if (strategy.takeProfitLevels.length === 0 && !strategy.stopLoss) {
                elizaLogger.debug("No valid take profit or stop loss levels found");
                return null;
            }

            strategy.takeProfitLevels.sort((a, b) => a.percentage - b.percentage);

            elizaLogger.debug("Parsed strategy:", {
                strategy,
                entryPrice,
                text,
                normalizedText
            });
            return strategy;

        } catch (error) {
            elizaLogger.error("Error parsing strategy:", error);
            return null;
        }
    }

    // Update the interpretStrategy method to use our internal parser
    private async interpretStrategy(text: string, entryPrice: number): Promise<StrategyInterpretation | null> {
        try {
            // First try using our precise parser
            const parsedStrategy = await this.parseNaturalLanguageStrategy(text, entryPrice);
            if (parsedStrategy) {
                return this.convertParserResultToInterpretation(parsedStrategy);
            }

            // If parser fails, fall back to template-based interpretation
            const context = composeContext({
                state: {
                    message: { content: { text } },
                    entryPrice,
                    bio: "",
                    lore: "",
                    messageDirections: "",
                    postDirections: "",
                    roomId: stringToUuid("strategy"),
                    actors: "user,assistant",
                    recentMessages: "",
                    recentMessagesData: [] as Memory[]
                },
                template: strategyInterpretTemplate
            });

            const result = await generateObject({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            if (this.isValidStrategyInterpretation(result)) {
                return result;
            }

            return null;
        } catch (error) {
            elizaLogger.error("Error interpreting strategy:", error);
            return null;
        }
    }

    private convertParserResultToInterpretation(parsedStrategy: StrategyConfig): StrategyInterpretation {
        return {
            type: this.determineStrategyType(parsedStrategy),
            token: "SOL", // Default to SOL, should be updated based on context
            baseToken: "USDC",
            takeProfitLevels: parsedStrategy.takeProfitLevels || [],
            stopLoss: parsedStrategy.stopLoss,
            // Add other fields as needed
        };
    }

    private determineStrategyType(strategy: StrategyConfig): StrategyType {
        if (strategy.stopLoss?.isTrailing) {
            return "TRAILING_STOP";
        }
        if (strategy.takeProfitLevels?.length > 0) {
            return "TAKE_PROFIT";
        }
        if (strategy.stopLoss) {
            return "STOP_LOSS";
        }
        return "TAKE_PROFIT"; // Default
    }

    private isValidStrategyInterpretation(obj: unknown): obj is StrategyInterpretation {
        if (typeof obj !== 'object' || obj === null) return false;

        const interpretation = obj as any;
        const validTypes = [
            'TAKE_PROFIT',
            'STOP_LOSS',
            'TRAILING_STOP',
            'DCA',
            'GRID',
            'REBALANCE'
        ] as const;
        
        return (
            typeof interpretation.type === 'string' &&
            validTypes.includes(interpretation.type) &&
            typeof interpretation.token === 'string' &&
            typeof interpretation.baseToken === 'string' &&
            // Validate based on strategy type
            this.validateStrategyTypeSpecificFields(interpretation)
        );
    }

    private validateStrategyTypeSpecificFields(interpretation: any): boolean {
        switch (interpretation.type) {
            case 'TAKE_PROFIT':
                return Array.isArray(interpretation.takeProfitLevels) &&
                    interpretation.takeProfitLevels.every((tp: any) =>
                        typeof tp === 'object' &&
                        typeof tp.percentage === 'number' &&
                        typeof tp.sellAmount === 'number'
                    );

            case 'STOP_LOSS':
                return typeof interpretation.stopLoss === 'object' &&
                    typeof interpretation.stopLoss.percentage === 'number';

            case 'TRAILING_STOP':
                return typeof interpretation.stopLoss === 'object' &&
                    typeof interpretation.stopLoss.percentage === 'number' &&
                    interpretation.stopLoss.isTrailing === true &&
                    typeof interpretation.stopLoss.trailingDistance === 'number';

            case 'DCA':
                return typeof interpretation.interval === 'number' &&
                    typeof interpretation.amount === 'number' &&
                    typeof interpretation.duration === 'number';

            case 'GRID':
                return Array.isArray(interpretation.gridLevels) &&
                    interpretation.gridLevels.every((level: any) =>
                        typeof level === 'object' &&
                        typeof level.price === 'number' &&
                        typeof level.amount === 'number'
                    );

            case 'REBALANCE':
                return Array.isArray(interpretation.targetAllocations) &&
                    interpretation.targetAllocations.every((allocation: any) =>
                        typeof allocation === 'object' &&
                        typeof allocation.token === 'string' &&
                        typeof allocation.percentage === 'number'
                    ) &&
                    typeof interpretation.rebalanceThreshold === 'number';

            default:
                return false;
        }
    }

    private async handleCancelStrategyCommand(message: AgentMessage): Promise<void> {
        const memoryManager = this.runtime.messageManager as IMemoryManager;
        const userId = stringToUuid(message.content.agentId);
        
        try {
            await memoryManager.beginTransaction();

            const strategies = await memoryManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 1000
            });

            const activeStrategy = strategies.find(mem =>
                mem.content.type === "strategy" &&
                mem.content.status === "active" &&
                stringToUuid(mem.userId) === userId
            );

            if (!activeStrategy) {
                await this.sendAgentMessage({
                    type: "error",
                    text: "No active strategy found to cancel.",
                    id: stringToUuid(`error-${Date.now()}`),
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "failed"
                }, message.from);
                return;
            }

            // Update strategy status
            const strategy = activeStrategy.content as StrategyContent;
            strategy.status = "cancelled";
            strategy.updatedAt = Date.now();

            await memoryManager.createMemory({
                id: stringToUuid(`cancel-${strategy.id}`),
                content: strategy,
                roomId: ROOM_IDS.STRATEGY,
                userId: stringToUuid(strategy.userId as string),
                agentId: this.runtime.agentId
            });

            // Create cancellation record
            await memoryManager.createMemory({
                id: stringToUuid(`cancel-record-${strategy.id}`),
                content: {
                    type: "strategy_cancelled",
                    id: stringToUuid(`cancel-${strategy.id}`),
                    strategyId: strategy.id,
                    text: `Strategy cancelled for ${strategy.token}`,
                    reason: "User requested cancellation",
                    timestamp: Date.now(),
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                roomId: ROOM_IDS.STRATEGY,
                userId: stringToUuid(strategy.userId as string),
                agentId: this.runtime.agentId
            });

            await memoryManager.commitTransaction();

            // Send response
            await this.sendAgentMessage({
                type: "strategy_cancelled",
                id: stringToUuid(`response-${strategy.id}`),
                text: `✅ Strategy cancelled for ${strategy.token}. Position will no longer be monitored.`,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "executed"
            }, message.from);

        } catch (error) {
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Error in cancel strategy handler:", error);
            await this.sendAgentMessage({
                type: "error",
                text: "Sorry, I encountered an error cancelling the strategy. Please try again.",
                id: stringToUuid(`error-${Date.now()}`),
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "failed"
            }, message.from);
        }
    }

    private async checkStrategyConditions(strategy: StrategyContent): Promise<void> {
        try {
            const priceInfo = await this.swapService.getTokenPrice(strategy.token);
            if (!priceInfo || priceInfo.error) {
                elizaLogger.warn(`Could not get current price for ${strategy.token}`);
                return;
            }
            const currentPrice = priceInfo.price;

            for (const condition of strategy.conditions) {
                if (await this.isConditionMet(condition, currentPrice)) {
                    await this.executeStrategyAction(strategy, condition);
                }
            }
        } catch (error) {
            elizaLogger.error("Error checking strategy conditions:", error);
        }
    }

    private async isConditionMet(condition: StrategyCondition, currentPrice: number): Promise<boolean> {
        switch (condition.type) {
            case "PRICE":
                return this.isPriceConditionMet(condition, currentPrice);
            case "TIME":
                return this.isTimeConditionMet(condition);
            case "VOLUME":
                return this.isVolumeConditionMet(condition);
            case "CUSTOM":
                return this.isCustomConditionMet(condition);
            default:
                return false;
        }
    }

    private isPriceConditionMet(condition: StrategyCondition, currentPrice: number): boolean {
        const targetPrice = parseFloat(condition.value);
        switch (condition.operator) {
            case ">=": return currentPrice >= targetPrice;
            case "<=": return currentPrice <= targetPrice;
            case ">": return currentPrice > targetPrice;
            case "<": return currentPrice < targetPrice;
            case "==": return Math.abs(currentPrice - targetPrice) < 0.0001;
            default: return false;
        }
    }

    private isTimeConditionMet(condition: StrategyCondition): boolean {
        const targetTime = new Date(condition.value).getTime();
        return Date.now() >= targetTime;
    }

    private isVolumeConditionMet(condition: StrategyCondition): boolean {
        // Implement volume condition check here
        return false;
    }

    private isCustomConditionMet(condition: StrategyCondition): boolean {
        // Implement custom condition check here
        return false;
    }

    private async executeStrategyAction(strategy: StrategyContent, condition: StrategyCondition): Promise<void> {
        const memoryManager = this.runtime.messageManager as IMemoryManager;
        
        try {
            await memoryManager.beginTransaction();

            let amount: string;
            let reason: string;

            // Cast strategy.type to StrategyType to handle the type checking
            const strategyType = strategy.type as StrategyType;
            switch (strategyType) {
                case "TAKE_PROFIT":
                case "STOP_LOSS":
                    amount = condition.amount;
                    reason = strategyType.toLowerCase();
                    break;

                case "TRAILING_STOP":
                    amount = condition.amount;
                    reason = 'trailing_stop';
                    break;

                case "DCA":
                    amount = (strategy as any).amount?.toString() || condition.amount;
                    reason = 'dca_execution';
                    break;

                case "GRID":
                    const gridStrategy = strategy as any;
                    const level = gridStrategy.gridLevels?.find((l: any) => l.price === parseFloat(condition.value));
                    amount = level ? level.amount.toString() : condition.amount;
                    reason = 'grid_execution';
                    break;

                case "REBALANCE":
                    const rebalanceStrategy = strategy as any;
                    const allocation = rebalanceStrategy.targetAllocations?.find((a: any) => a.token === strategy.token);
                    amount = allocation ? allocation.amount.toString() : condition.amount;
                    reason = 'rebalance_execution';
                    break;

                default:
                    throw new Error(`Unsupported strategy type: ${strategy.type}`);
            }

            // Create swap request
            const requestId = stringToUuid(`request-${strategy.id}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: requestId,
                content: {
                    type: "swap_request",
                    id: requestId,
                    inputToken: strategy.token,
                    outputToken: strategy.baseToken,
                    amount,
                    reason,
                    requestId,
                    sourceAgent: "STRATEGY",
                    sourceId: strategy.id,
                    status: "pending_execution",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    text: `Swap triggered by ${strategyType} strategy: ${condition.type} at ${condition.value}`
                },
                roomId: ROOM_IDS.TREASURY,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            // Create execution tracking memory
            const executionId = stringToUuid(`execution-${strategy.id}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: executionId,
                content: createStrategyMemoryContent(
                    "strategy_execution_request",
                    `Strategy execution requested for ${strategy.token}`,
                    "pending_execution",
                    strategy.id,
                    {
                        tags: ["execution", strategy.token, strategyType.toLowerCase()],
                        priority: "high",
                        swapRequestId: requestId,
                        strategyType
                    }
                ),
                roomId: ROOM_IDS.STRATEGY,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            await memoryManager.commitTransaction();

        } catch (error) {
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Error creating swap request:", error);
            throw error;
        }
    }

    // Required BaseAgent implementations
    public async validateAction(content: any): Promise<boolean> {
        if (!content || typeof content !== 'object') {
            return false;
        }

        switch (content.type) {
            case "strategy":
                return this.isValidStrategyContent(content);
            case "strategy_execution_request":
                return this.isValidExecutionRequest(content);
            default:
                return false;
        }
    }

    public async executeAction(content: any): Promise<boolean> {
        try {
            switch (content.type) {
                case "strategy":
                    if (this.isValidStrategyContent(content)) {
                        await this.handleStrategyEvent(content as StrategyContent);
                        return true;
                    }
                    break;
                case "strategy_execution_request":
                    if (this.isValidExecutionRequest(content)) {
                        await this.handleExecutionRequest(content as StrategyExecutionRequest);
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

    protected async handleMemory(memory: Memory): Promise<void> {
        if (memory.content.type === "message") {
            await this.handleMessage(memory as unknown as AgentMessage);
        } else {
            await this.processStrategyMemory(memory);
        }
    }

    protected loadActions(): void {
        // Only register capabilities - memory handling is done in handleMemory
        this.registerCapability({
            name: "strategy_management",
            description: "Manage trading strategies",
            requiredPermissions: ["manage_strategies"],
            actions: ["strategy", "cancel_strategy"]
        });

        // Register shared actions
        this.runtime.registerAction(tokeninfo);
    }

    private isValidStrategyContent(content: any): content is StrategyContent {
        return content &&
            typeof content === 'object' &&
            content.type === 'strategy' &&
            typeof content.token === 'string' &&
            typeof content.baseToken === 'string' &&
            typeof content.strategyType === 'string' &&
            Array.isArray(content.conditions);
    }

    private isValidExecutionRequest(content: any): content is StrategyExecutionRequest {
        return content &&
            typeof content === 'object' &&
            content.type === 'strategy_execution_request' &&
            typeof content.strategyId === 'string' &&
            typeof content.token === 'string' &&
            typeof content.action === 'string' &&
            typeof content.amount === 'string';
    }

    private async processStrategyMemory(memory: Memory): Promise<void> {
        const content = memory.content;
        switch (content.type) {
            case "strategy":
                await this.handleStrategyEvent(content as StrategyContent);
                break;
            case "strategy_execution_request":
                await this.handleExecutionRequest(content as StrategyExecutionRequest);
                break;
            case "proposal_passed":
                await this.handleProposalPassed(content as ProposalContent);
                break;
            case "proposal_executed":
                await this.handleProposalExecuted(content as ProposalContent);
                break;
            default:
                elizaLogger.debug(`Unhandled memory type: ${content.type}`);
        }
    }

    private async handleStrategyEvent(content: StrategyContent): Promise<void> {
        elizaLogger.debug("Handling strategy event:", content);
    }

    private async handleExecutionRequest(content: StrategyExecutionRequest): Promise<void> {
        elizaLogger.debug("Handling execution request:", content);
    }

    // Add missing event handlers
    private async handleStrategyUpdate(memory: Memory): Promise<void> {
        const content = memory.content as StrategyContent;
        elizaLogger.debug("Handling strategy update:", content);
        await this.handleStrategyEvent(content);
    }

    private async handleExecutionResult(result: StrategyExecutionResult): Promise<void> {
        elizaLogger.debug("Handling execution result:", result);
        // Implement execution result handling
    }

    private isValidStrategyType(type: string): type is "PRICE" | "TIME" | "VOLUME" | "CUSTOM" {
        return ["PRICE", "TIME", "VOLUME", "CUSTOM"].includes(type);
    }

    private isValidOperator(op: string): op is ">" | "<" | "==" | ">=" | "<=" {
        return [">", "<", "==", ">=", "<="].includes(op);
    }

    // Add handlers for proposal events
    private async handleProposalPassed(proposal: ProposalContent): Promise<void> {
        elizaLogger.debug("Handling passed proposal:", proposal);
        
        // Check if this proposal affects strategy configuration
        if (proposal.interpretation && 
            typeof proposal.interpretation === 'object' &&
            'type' in proposal.interpretation &&
            proposal.interpretation.type === "strategy" &&
            'details' in proposal.interpretation) {
            try {
                // Extract strategy details from the proposal
                const strategyDetails = proposal.interpretation.details as StrategyDetails;
                // Ensure proposer is converted to UUID consistently
                const proposerId = typeof proposal.proposer === 'string' ? stringToUuid(proposal.proposer) : proposal.proposer;
                const proposalId = stringToUuid(`proposal-${proposal.shortId}`);
                
                // Create or update strategy based on proposal
                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(`strategy-${proposalId}`),
                    content: {
                        type: "strategy",
                        id: stringToUuid(`strategy-${proposalId}`),
                        text: `Strategy created from proposal ${proposal.shortId}`,
                        token: strategyDetails.token,
                        baseToken: strategyDetails.baseToken || "USDC",
                        conditions: strategyDetails.conditions,
                        status: "pending_execution",
                        agentId: this.runtime.agentId,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        metadata: {
                            proposalId,
                            proposer: proposerId
                        }
                    },
                    roomId: ROOM_IDS.STRATEGY,
                    userId: proposerId,
                    agentId: this.runtime.agentId
                });

                elizaLogger.info(`Created strategy from proposal ${proposal.shortId}`);
            } catch (error) {
                elizaLogger.error(`Error handling passed proposal ${proposal.shortId}:`, error);
            }
        }
    }

    private async handleProposalExecuted(proposal: ProposalContent): Promise<void> {
        elizaLogger.debug("Handling executed proposal:", proposal);
        
        // Update any strategies that were created from this proposal
        const strategies = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.STRATEGY,
            count: 1000
        });

        // Ensure proposer is converted to UUID consistently
        const proposerId = typeof proposal.proposer === 'string' ? stringToUuid(proposal.proposer) : proposal.proposer;
        const proposalId = stringToUuid(`proposal-${proposal.shortId}`);

        const relatedStrategy = strategies.find(mem => {
            if (mem.content.type !== "strategy" || !mem.content.metadata || typeof mem.content.metadata !== 'object') {
                return false;
            }
            
            const metadata = mem.content.metadata;
            if (!('proposalId' in metadata) || !('proposer' in metadata)) {
                return false;
            }

            // Convert stored proposer to UUID if it's a string
            const storedProposer = typeof metadata.proposer === 'string' ? stringToUuid(metadata.proposer) : metadata.proposer;
            
            return metadata.proposalId === proposalId && storedProposer === proposerId;
        });

        if (relatedStrategy) {
            try {
                const strategy = relatedStrategy.content as StrategyContent;
                strategy.status = "pending_execution";
                strategy.updatedAt = Date.now();

                await this.runtime.messageManager.createMemory({
                    id: relatedStrategy.id,
                    content: strategy,
                    roomId: ROOM_IDS.STRATEGY,
                    userId: proposerId,
                    agentId: this.runtime.agentId
                });

                // Start monitoring this strategy
                await this.strategyExecutor.startStrategyMonitoring(strategy.agentId);
                
                elizaLogger.info(`Activated strategy from executed proposal ${proposal.shortId}`);
            } catch (error) {
                elizaLogger.error(`Error handling executed proposal ${proposal.shortId}:`, error);
            }
        }
    }

    // Add missing handler methods
    private async handleStrategyExecution(memory: Memory): Promise<void> {
        const content = memory.content as StrategyExecution;
        elizaLogger.debug("Handling strategy execution:", content);
        // Implement strategy execution logic
    }

    private async handleStrategyCancelled(memory: Memory): Promise<void> {
        const content = memory.content;
        elizaLogger.debug("Handling strategy cancellation:", content);
        // Update any related strategies or positions
        if (content.strategyId) {
            const strategies = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 1000
            });

            const strategy = strategies.find(mem => 
                mem.content.type === "strategy" && 
                mem.content.id === content.strategyId
            );

            if (strategy) {
                const strategyContent = strategy.content as StrategyContent;
                strategyContent.status = "cancelled";
                strategyContent.updatedAt = Date.now();

                await this.runtime.messageManager.createMemory({
                    id: strategy.id,
                    content: strategyContent,
                    roomId: ROOM_IDS.STRATEGY,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });
            }
        }
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

    private isBaseContent(value: unknown): value is BaseContent {
        return typeof value === 'object' && value !== null &&
            'type' in value && typeof value.type === 'string' &&
            'id' in value && typeof value.id === 'string' &&
            'text' in value && typeof value.text === 'string' &&
            'agentId' in value && typeof value.agentId === 'string';
    }

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
                // First verify we still hold the lock with row-level locking
                const currentLock = await this.runtime.messageManager.getMemoryWithLock(
                    stringToUuid(`lock-${lock.key}-${lock.lockId}`)
                );

                if (!currentLock) {
                    elizaLogger.debug(`Lock ${lock.key} already released or expired`);
                    return; // Lock already released or expired
                }

                const content = currentLock.content as any;
                const now = Date.now();

                // Skip if:
                // 1. We don't own the lock
                // 2. Lock is not active
                // 3. Lock has expired
                if (content.holder !== this.runtime.agentId || 
                    content.lockState !== 'active' || 
                    content.expiresAt <= now) {
                    elizaLogger.debug(`Skipping lock release for ${lock.key}: not owner or inactive/expired`);
                    
                    // If expired, remove it
                    if (content.expiresAt <= now) {
                        await this.runtime.messageManager.removeMemory(currentLock.id);
                        elizaLogger.debug(`Removed expired lock ${lock.key}`);
                    }
                    return;
                }

                // Mark as releasing first (this helps prevent race conditions)
                await this.runtime.messageManager.createMemory({
                    id: currentLock.id,
                    content: {
                        ...content,
                        lockState: 'releasing',
                        updatedAt: now
                    },
                    roomId: currentLock.roomId,
                    userId: currentLock.userId,
                    agentId: this.runtime.agentId
                });

                // Then remove the lock
                await this.runtime.messageManager.removeMemory(currentLock.id);
                elizaLogger.debug(`Successfully released lock ${lock.key}`);

            } catch (error) {
                elizaLogger.error(`Error releasing lock for ${lock.key}:`, error);
                throw error;
            }
        });
    }

    private async handleSwapCompleted(memory: Memory): Promise<void> {
        try {
            const content = memory.content as SwapCompletedContent;
            if (!content.success || !content.inputToken || !content.outputToken) return;

            // Format token amounts/symbols for display
            const inputAmount = content.inputAmount;
            const outputAmount = content.outputAmount;
            const inputSymbol = content.metadata?.inputSymbol || content.inputToken;
            const outputSymbol = content.metadata?.outputSymbol || content.outputToken;

            // Create user-friendly message
            const message = `I noticed you just swapped ${inputAmount} ${inputSymbol} for ${outputAmount} ${outputSymbol}. 🔄\n\n` +
                           `Would you like to implement a strategy for this trade? I can help you set up:\n\n` +
                           `• Take Profit levels 📈\n` +
                           `• Stop Loss protection 🛡\n` +
                           `• Trailing Stop Loss 📉\n\n` +
                           `Just let me know if you'd like to explore any of these options!`;

            // Generate a UUID for the suggestion
            const suggestionId: UUID = stringToUuid(`suggestion-${Date.now()}`);

            // Send the message
            await this.sendMessage({
                type: "strategy_suggestion",
                content: {
                    type: "strategy_suggestion" as const,
                    id: suggestionId,
                    text: message,
                    status: "executed" as const,
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        swapId: stringToUuid(content.swapId),
                        inputToken: content.inputToken,
                        outputToken: content.outputToken,
                        inputAmount,
                        outputAmount
                    }
                },
                from: this.runtime.agentType,
                to: "ALL"
            });

        } catch (error) {
            elizaLogger.error("Error handling swap completed event:", error);
        }
    }
} 