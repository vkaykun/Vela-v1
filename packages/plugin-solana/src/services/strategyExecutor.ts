// packages/plugin-solana/src/services/strategyExecutor.ts

import { Service, ServiceType, elizaLogger, stringToUuid, UUID } from "@elizaos/core";
import { StrategyContent, StrategyExecution, PositionUpdate, StrategyExecutionRequest, PricePoint, Position, StrategyConfig } from "../shared/types/strategy.ts";
import { SwapRequest } from "../shared/types/treasury.ts";
import { createStrategyMemoryContent } from "../shared/types/memory.ts";
import { SwapService } from "../services/swapService.ts";
import { TreasuryAgent } from "../agents/treasury/TreasuryAgent.ts";
import { IAgentRuntime as BaseAgentRuntime } from "../shared/types/base.ts";
import { ModelProviderName, Character, Provider } from "@elizaos/core";
import { ROOM_IDS } from "../shared/constants.ts";
import { ExtendedAgentRuntime } from "../shared/utils/runtime.ts";

export class StrategyExecutor extends Service {
    static get serviceType(): ServiceType {
        return "STRATEGY_EXECUTOR" as ServiceType;
    }

    private swapService: SwapService;
    private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
    private readonly MONITORING_INTERVAL = 30000; // 30 seconds
    private readonly PRICE_UPDATE_INTERVAL = 10000; // 10 seconds
    private readonly MAX_PRICE_AGE = 60000; // 1 minute
    private lastPriceUpdates: Map<string, { price: number; timestamp: number }> = new Map();
    protected runtime: ExtendedAgentRuntime;
    private activeMonitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
    private treasuryAgent: TreasuryAgent | null = null;
    private positions: Map<string, Position> = new Map();

    constructor(
        runtime: ExtendedAgentRuntime,
        swapService: SwapService
    ) {
        super();
        this.runtime = runtime;
        this.swapService = swapService;
    }

    async initialize(): Promise<void> {
        elizaLogger.info("Strategy executor service initialized");
    }

    async startStrategyMonitoring(strategyId: string): Promise<void> {
        if (this.monitoringIntervals.has(strategyId)) {
            elizaLogger.debug(`Strategy ${strategyId} already being monitored`);
            return;
        }

        const interval = setInterval(async () => {
            await this.monitorStrategy(strategyId);
        }, this.MONITORING_INTERVAL);

        this.monitoringIntervals.set(strategyId, interval);
        elizaLogger.info(`Started monitoring strategy ${strategyId}`);
    }

    async stopStrategyMonitoring(strategyId: string): Promise<void> {
        const interval = this.monitoringIntervals.get(strategyId);
        if (interval) {
            clearInterval(interval);
            this.monitoringIntervals.delete(strategyId);
            elizaLogger.info(`Stopped monitoring strategy ${strategyId}`);
        }
    }

    private async monitorStrategy(strategyId: string): Promise<void> {
        try {
            // Get the position associated with this strategy
            const position = await this.getLatestPosition(strategyId);
            if (!position || position.status !== 'active') {
                await this.stopStrategyMonitoring(strategyId);
                return;
            }

            // Get current price
            const currentPrice = await this.getCurrentPrice(position.token);
            if (!currentPrice) {
                elizaLogger.warn(`Could not get current price for ${position.token}`);
                return;
            }

            // Check and execute strategy conditions
            await this.checkAndExecuteStrategy(position, currentPrice);

        } catch (error) {
            elizaLogger.error(`Error monitoring strategy ${strategyId}:`, error);
        }
    }

    private async getCurrentPrice(token: string): Promise<number | null> {
        try {
            const lastUpdate = this.lastPriceUpdates.get(token);
            const now = Date.now();

            // Return cached price if recent enough
            if (lastUpdate && (now - lastUpdate.timestamp) < this.PRICE_UPDATE_INTERVAL) {
                return lastUpdate.price;
            }

            // Get fresh price
            const priceInfo = await this.swapService.getTokenPrice(token);
            if (!priceInfo || priceInfo.error) {
                return null;
            }

            // Cache the new price
            this.lastPriceUpdates.set(token, {
                price: priceInfo.price,
                timestamp: now
            });

            return priceInfo.price;
        } catch (error) {
            elizaLogger.error(`Error getting price for ${token}:`, error);
            return null;
        }
    }

    private async checkAndExecuteStrategy(position: Position, currentPrice: number): Promise<void> {
        try {
            if (!position.strategy) return;

            // Check take profit levels
            if (position.strategy.takeProfitLevels?.length > 0) {
                for (const tp of position.strategy.takeProfitLevels) {
                    if (tp.price && currentPrice >= tp.price) {
                        await this.executeTakeProfit(position, tp, currentPrice);
                    }
                }
            }

            // Check stop loss
            if (position.strategy.stopLoss) {
                if (position.strategy.stopLoss.isTrailing) {
                    await this.checkTrailingStop(position, currentPrice);
                } else if (position.strategy.stopLoss.price && currentPrice <= position.strategy.stopLoss.price) {
                    await this.executeStopLoss(position, currentPrice);
                }
            }

            // Update position tracking with current price
            if (position.remainingAmount) {
                await this.updatePositionAmount(
                    position.id,
                    0,
                    position.remainingAmount,
                    currentPrice,
                    'take_profit' // Using take_profit type as it's required by the method signature
                );
            }

        } catch (error) {
            elizaLogger.error(`Error checking strategy for position ${position.id}:`, error);
        }
    }

    private async checkTrailingStop(position: Position, currentPrice: number): Promise<void> {
        if (!position.strategy?.stopLoss?.isTrailing || !position.strategy.stopLoss.highestPrice) return;

        // Update highest price if we have a new high
        if (currentPrice > position.strategy.stopLoss.highestPrice) {
            const newStopPrice = currentPrice * (1 - (position.strategy.stopLoss.trailingDistance! / 100));
            
            // Update position with new high price
            if (position.remainingAmount) {
                await this.updatePositionAmount(
                    position.id,
                    0,
                    position.remainingAmount,
                    currentPrice,
                    'stop_loss',
                    stringToUuid(`trailing-${position.id}-${Date.now()}`)
                );
            }
            return;
        }

        // Check if price has fallen below trailing stop
        const stopPrice = position.strategy.stopLoss.highestPrice * (1 - (position.strategy.stopLoss.trailingDistance! / 100));
        if (currentPrice <= stopPrice) {
            await this.executeStopLoss(position, currentPrice);
        }
    }

    private async executeTakeProfit(position: Position, tp: StrategyConfig['takeProfitLevels'][0], currentPrice: number): Promise<void> {
        try {
            if (!position.remainingAmount) return;

            const sellAmount = position.remainingAmount * (tp.sellAmount / 100);
            const remainingAfterSell = position.remainingAmount - sellAmount;
            
            await this.createSwapRequest({
                strategyId: position.id,
                token: position.token,
                baseToken: "USDC", // Default to USDC
                amount: sellAmount.toString(),
                type: 'take_profit',
                targetPrice: tp.price || currentPrice,
                currentPrice
            });

            // Update position tracking
            await this.updatePositionAmount(
                position.id,
                sellAmount,
                remainingAfterSell,
                currentPrice,
                'take_profit'
            );
        } catch (error) {
            elizaLogger.error(`Error executing take profit for position ${position.id}:`, error);
        }
    }

    private async executeStopLoss(position: Position, currentPrice: number): Promise<void> {
        try {
            if (!position.remainingAmount) return;

            await this.createSwapRequest({
                strategyId: position.id,
                token: position.token,
                baseToken: "USDC", // Default to USDC
                amount: position.remainingAmount.toString(),
                type: 'stop_loss',
                targetPrice: position.strategy?.stopLoss?.price || currentPrice,
                currentPrice
            });

            // Update position tracking
            await this.updatePositionAmount(
                position.id,
                position.remainingAmount,
                0,
                currentPrice,
                'stop_loss'
            );
        } catch (error) {
            elizaLogger.error(`Error executing stop loss for position ${position.id}:`, error);
        }
    }

    private async createSwapRequest(params: {
        strategyId: string;
        token: string;
        baseToken: string;
        amount: string;
        type: 'take_profit' | 'stop_loss';
        targetPrice: number;
        currentPrice: number;
    }): Promise<void> {
        const requestId = stringToUuid(`${params.type}-${params.strategyId}-${Date.now()}`);
        
        await this.runtime.messageManager.createMemory({
            id: requestId,
            content: {
                type: "swap_request",
                id: requestId,
                fromToken: params.token,
                toToken: params.baseToken,
                amount: params.amount,
                reason: params.type,
                requestId,
                sourceAgent: "STRATEGY",
                sourceId: params.strategyId,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                text: `${params.type} triggered for ${params.token} at ${params.currentPrice} (target: ${params.targetPrice})`
            },
            roomId: ROOM_IDS.TREASURY,
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId
        });
    }

    async attachStrategy(position: Position, strategy: StrategyConfig): Promise<void> {
        try {
            // Calculate price levels based on entry price
            const strategyWithPrices: StrategyConfig = {
                takeProfitLevels: strategy.takeProfitLevels.map(tp => ({
                    ...tp,
                    price: position.entryPrice * (1 + tp.percentage / 100)
                })),
                stopLoss: strategy.stopLoss ? {
                    ...strategy.stopLoss,
                    price: position.entryPrice * (1 - strategy.stopLoss.percentage / 100)
                } : undefined
            };

            const memoryId = stringToUuid(`strategy-${position.id}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Strategy attached to position ${position.id}`,
                    type: "strategy",
                    positionId: position.id,
                    strategy: strategyWithPrices,
                    status: "active",
                    token: position.token,
                    entryPrice: position.entryPrice,
                    timestamp: Date.now()
                },
                roomId: ROOM_IDS.STRATEGY,
                userId: stringToUuid(position.userId),
                agentId: this.runtime.agentId
            });

            // Update cached position
            position.strategy = strategyWithPrices;
            this.positions.set(position.id, position);

            elizaLogger.info(`Strategy attached to position ${position.id}`, {
                strategy: strategyWithPrices,
                position
            });
        } catch (error) {
            elizaLogger.error(`Error attaching strategy to position ${position.id}:`, error);
            throw error;
        }
    }

    async executeStrategy(strategy: StrategyContent, position: PositionUpdate): Promise<void> {
        try {
            const executionSize = await this.calculateExecutionSize(strategy, position);
            if (!executionSize) {
                throw new Error("Could not determine execution size");
            }

            // Create swap request instead of direct execution
            const requestId = stringToUuid(`exec-${strategy.id}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: requestId,
                content: {
                    type: "swap_request",
                    id: requestId,
                    inputToken: position.token,
                    outputToken: position.baseToken,
                    amount: executionSize,
                    reason: "strategy_execution",
                    requestId,
                    sourceAgent: "STRATEGY",
                    sourceId: strategy.id,
                    status: "pending_execution",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    text: `Strategy execution swap for ${strategy.id}`
                },
                roomId: ROOM_IDS.TREASURY,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            // Create execution tracking memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`exec-${strategy.id}`),
                content: createStrategyMemoryContent(
                    "strategy_execution_request",
                    `Strategy execution requested for ${position.token}`,
                    "pending_execution",
                    strategy.id,
                    {
                        tags: ["execution", position.token],
                        priority: "high",
                        swapRequestId: requestId
                    }
                ),
                roomId: ROOM_IDS.STRATEGY,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId
            });

            elizaLogger.info(`Strategy execution initiated for ${strategy.id}`);
        } catch (error) {
            elizaLogger.error("Error executing strategy:", error);
            throw error;
        }
    }

    private async calculateExecutionSize(strategy: StrategyContent, position: PositionUpdate): Promise<number | null> {
        try {
            const positionSize = parseFloat(position.size);
            const currentPrice = parseFloat(position.price);
            
            // Handle take profit points
            if (strategy.takeProfitPoints) {
                for (const tp of strategy.takeProfitPoints) {
                    if (currentPrice >= parseFloat(tp.price)) {
                        return positionSize * (tp.percentage / 100);
                    }
                }
            }

            // Handle stop loss
            if (strategy.stopLossPoint && currentPrice <= parseFloat(strategy.stopLossPoint.price)) {
                return positionSize;
            }

            // Handle trailing stop
            if (strategy.trailingStopDistance) {
                const trailingStop = currentPrice * (1 - parseFloat(strategy.trailingStopDistance) / 100);
                if (currentPrice <= trailingStop) {
                    return positionSize;
                }
            }

            return null;
        } catch (error) {
            elizaLogger.error("Error calculating execution size:", error);
            return null;
        }
    }

    async validateStrategy(strategy: StrategyContent): Promise<boolean> {
        // Basic validation
        if (!strategy.token || !strategy.baseToken) {
            return false;
        }

        // Validate take profit points
        if (strategy.takeProfitPoints?.some(tp => !tp.price || !tp.percentage)) {
            return false;
        }

        // Validate stop loss
        if (strategy.stopLossPoint && (!strategy.stopLossPoint.price || !strategy.stopLossPoint.percentage)) {
            return false;
        }

        // Validate trailing stop
        if (strategy.trailingStopDistance && parseFloat(strategy.trailingStopDistance) <= 0) {
            return false;
        }

        return true;
    }

    private async ensureTreasuryAgent(): Promise<TreasuryAgent> {
        if (!this.treasuryAgent) {
            this.treasuryAgent = new TreasuryAgent(this.runtime);
            await this.treasuryAgent.initialize();
        }
        return this.treasuryAgent;
    }

    // Position tracking methods
    async getLatestPosition(userId: string): Promise<Position | null> {
        try {
            const swaps = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 100
            });

            // For treasury positions, also include swaps marked as treasury swaps
            const latestSwap = swaps
                .filter(m =>
                    m.userId === userId ||
                    (userId === this.runtime.agentId && m.content.isTreasurySwap === true)
                )
                .find(m => m.content.type === "swap" && m.content.status === "completed");

            if (!latestSwap || !latestSwap.id) {
                elizaLogger.debug(`No recent swap found for user ${userId}`);
                return null;
            }

            // Get position updates to calculate remaining amount
            const updates = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 100
            });

            const positionUpdates = updates
                .filter(m =>
                    m.content.type === "position_update" &&
                    m.content.positionId === latestSwap.id
                )
                .sort((a, b) => (b.content.timestamp as number) - (a.content.timestamp as number));

            const initialAmount = latestSwap.content.outputAmount as number;
            let remainingAmount = initialAmount;
            const partialSells = [];

            // Calculate remaining amount and collect partial sells
            for (const update of positionUpdates) {
                remainingAmount = update.content.remainingAmount as number;
                if (update.content.soldAmount) {
                    partialSells.push({
                        timestamp: update.content.timestamp as number,
                        amount: update.content.soldAmount as number,
                        price: update.content.price as number,
                        type: update.content.sellType as 'take_profit' | 'stop_loss',
                        txSignature: update.content.txSignature as string,
                        profitPercentage: update.content.profitPercentage as number
                    });
                }
            }

            // Get active strategy if exists
            const strategy = await this.getActiveStrategy(latestSwap.id);

            const position: Position = {
                id: latestSwap.id,
                txSignature: latestSwap.content.txSignature as string,
                token: latestSwap.content.outputToken as string,
                amount: initialAmount,
                remainingAmount: remainingAmount,
                entryPrice: latestSwap.content.entryPrice as number || latestSwap.content.price as number || 0,
                timestamp: latestSwap.content.timestamp as number,
                status: remainingAmount > 0 ? 'active' : 'closed',
                userId,
                partialSells: partialSells.length > 0 ? partialSells : undefined,
                strategy: strategy || undefined
            };

            // Cache the position
            this.positions.set(position.id, position);
            return position;

        } catch (error) {
            elizaLogger.error(`Error getting latest position for user ${userId}:`, error);
            return null;
        }
    }

    async updatePositionAmount(
        positionId: string,
        soldAmount: number,
        remainingAmount: number,
        price: number,
        type: 'take_profit' | 'stop_loss',
        txSignature?: string
    ): Promise<void> {
        try {
            const position = await this.getPositionById(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }

            const profitPercentage = ((price - position.entryPrice) / position.entryPrice) * 100;

            const memoryId = stringToUuid(`position-update-${positionId}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Updated position ${positionId} - Sold ${soldAmount} at ${price}`,
                    type: "position_update",
                    positionId,
                    soldAmount,
                    remainingAmount,
                    price,
                    sellType: type,
                    txSignature,
                    profitPercentage,
                    timestamp: Date.now()
                },
                roomId: ROOM_IDS.STRATEGY,
                userId: stringToUuid(this.runtime.agentId),
                agentId: this.runtime.agentId
            });

            // Update cached position
            if (position) {
                position.remainingAmount = remainingAmount;
                if (!position.partialSells) position.partialSells = [];
                position.partialSells.push({
                    timestamp: Date.now(),
                    amount: soldAmount,
                    price,
                    type,
                    txSignature,
                    profitPercentage
                });
                this.positions.set(position.id, position);
            }

            // If position is fully closed, update its status
            if (remainingAmount <= 0) {
                await this.updatePositionStatus(positionId, "closed");
            }
        } catch (error) {
            elizaLogger.error(`Error updating position amount for ${positionId}:`, error);
            throw error;
        }
    }

    private async getPositionById(positionId: string): Promise<Position | null> {
        // Check cache first
        if (this.positions.has(positionId)) {
            return this.positions.get(positionId)!;
        }

        const memories = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.STRATEGY,
            count: 100
        });

        const positionMem = memories.find(m => m.id === positionId);
        if (!positionMem) return null;

        return this.getLatestPosition(positionMem.userId);
    }

    async updatePositionStatus(positionId: string, status: 'active' | 'closed'): Promise<void> {
        try {
            const memoryId = stringToUuid(`position-status-${positionId}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Updated position ${positionId} status to ${status}`,
                    type: "position_status",
                    positionId,
                    status,
                    timestamp: Date.now()
                },
                roomId: ROOM_IDS.STRATEGY,
                userId: stringToUuid(this.runtime.agentId),
                agentId: this.runtime.agentId
            });

            // Update cached position
            const position = await this.getPositionById(positionId);
            if (position) {
                position.status = status;
                this.positions.set(position.id, position);
            }
        } catch (error) {
            elizaLogger.error(`Error updating position ${positionId} status:`, error);
            throw error;
        }
    }

    async getActiveStrategy(positionId: string): Promise<StrategyConfig | null> {
        try {
            const memories = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 100
            });

            const strategyMem = memories
                .filter(m =>
                    m.content.type === "strategy" &&
                    m.content.positionId === positionId &&
                    m.content.status === "active"
                )
                .sort((a, b) => (b.content.timestamp as number) - (a.content.timestamp as number))[0];

            if (!strategyMem) return null;

            return strategyMem.content.strategy as StrategyConfig;
        } catch (error) {
            elizaLogger.error(`Error getting active strategy for position ${positionId}:`, error);
            return null;
        }
    }

    async cancelStrategy(positionId: string): Promise<void> {
        try {
            // Find the original strategy memory
            const memories = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.STRATEGY,
                count: 100
            });

            const strategyMem = memories.find(m =>
                m.content.type === "strategy" &&
                m.content.positionId === positionId &&
                m.content.status === "active"
            );

            if (!strategyMem) {
                elizaLogger.warn(`No active strategy found for position ${positionId}`);
                return;
            }

            // Create a new memory with the same ID but updated status
            await this.runtime.messageManager.createMemory({
                id: strategyMem.id,
                content: {
                    ...strategyMem.content,
                    text: `Strategy cancelled for position ${positionId}`,
                    status: "cancelled",
                    cancelledAt: Date.now()
                },
                roomId: ROOM_IDS.STRATEGY,
                userId: strategyMem.userId,
                agentId: this.runtime.agentId
            });

            // Update cached position
            const position = await this.getPositionById(positionId);
            if (position) {
                position.strategy = undefined;
                this.positions.set(position.id, position);
            }

            elizaLogger.info(`Strategy cancelled for position ${positionId}`);
        } catch (error) {
            elizaLogger.error(`Error cancelling strategy for position ${positionId}:`, error);
            throw error;
        }
    }
}