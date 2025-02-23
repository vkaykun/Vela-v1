// UserProfileAgent.ts

import { 
    Memory, 
    State, 
    elizaLogger,
    stringToUuid,
    UUID,
    Runtime
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent.ts";
import { IAgentRuntime } from "../../shared/types/base.ts";
import { 
    UserProfile, 
    UserProfileUpdate, 
    UserActivityLog,
    UserReputationUpdate,
    REPUTATION_SCORES 
} from "../../shared/types/user.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { TokenBalance } from "../../shared/types/treasury.ts";
import { BaseContent, ContentStatus } from "../../shared/types/base.ts";
import { StrategyExecutionResult } from "../../shared/types/strategy.ts";
import { MemoryMetadata } from "../../shared/types/memory.ts";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import { tokeninfo } from "../../actions/tokeninfo.js";
import { AgentMessage, AgentCapability } from "../../shared/types/base.ts";

interface UserActivityMetadata extends MemoryMetadata {
    proposalId?: string;
    strategyId?: string;
    executedAmount?: number;
    executionPrice?: number;
    success?: boolean;
    userStats: {
        proposalsCreated: number;
        votesCount: number;
    };
}

interface UserStats {
    proposalsCreated: number;
    votesCount: number;
    depositsVerified: number;
    strategiesCreated: number;
}

interface UserProfileMetadata extends MemoryMetadata {
    stats: UserStats;
    walletAddresses: string[];
    discordId?: string;
    reputation: number;
    totalDeposits: Array<{
        token: string;
        amount: string;
        usdValue?: string;
    }>;
}

interface UserProfileContent extends BaseContent {
    type: "user_profile";
    metadata: UserProfileMetadata;
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
    status: ContentStatus;
}

interface CommandResponse {
    text: string;
    action: string;
}

interface WeeklyStats {
    topProposer: string;
    topVoter: string;
    topStrategist: string;
}

export class UserProfileAgent extends BaseAgent {
    private userProfiles: Map<UUID, UserProfileContent> = new Map();
    private lastSyncTimestamp: number = 0;
    private syncInterval: NodeJS.Timeout | null = null;
    private agentSettings: {
        syncInterval: number;
        batchSize: number;
        minReputation: number;
        defaultVotingPower: number;
    };

    constructor(runtime: ExtendedAgentRuntime) {
        super(runtime);
        
        // Initialize with environment-based defaults
        this.agentSettings = {
            syncInterval: parseInt(this.runtime.getSetting("profileSyncInterval") || "30000", 10),
            batchSize: parseInt(this.runtime.getSetting("profileBatchSize") || "100", 10),
            minReputation: parseInt(this.runtime.getSetting("minReputation") || "0", 10),
            defaultVotingPower: parseInt(this.runtime.getSetting("defaultVotingPower") || "1", 10)
        };

        // Override with agent config if present
        if (this.runtime.character?.agentConfig?.settings) {
            const configSettings = this.runtime.character.agentConfig.settings;
            if (typeof configSettings === 'object' && configSettings !== null) {
                this.agentSettings = {
                    ...this.agentSettings,
                    ...configSettings
                };
            }
        }

        this.setupSubscriptions();
    }

    public override async initialize(): Promise<void> {
        await super.initialize();

        // Initial load of user profiles
        await this.loadUserProfiles();

        // Set up memory subscriptions for user-related events
        this.setupSubscriptions();

        // Start profile synchronization
        this.startProfileSync();

        // Subscribe to proposal creation events
        this.subscribeToMemory("proposal_created", async (memory: Memory) => {
            const content = memory.content as BaseContent;
            if (content.metadata?.proposer) {
                await this.handleNewProposal(
                    content.metadata.proposer as UUID,
                    content.metadata.proposalId as string
                );
            }
        });

        elizaLogger.info("User Profile Agent initialized");
    }

    private async loadUserProfiles(): Promise<void> {
        try {
            let lastId: UUID | undefined;
            let hasMore = true;
            const loadedProfiles = new Map<UUID, UserProfileContent>();

            while (hasMore) {
                const profiles = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: this.agentSettings.batchSize,
                    ...(lastId ? { lastId } : {})
                });

                if (profiles.length === 0) {
                    hasMore = false;
                    continue;
                }

                profiles.forEach(memory => {
                    if (memory.content.type === "user_profile") {
                        const profile = memory.content as UserProfileContent;
                        loadedProfiles.set(profile.id, profile);
                        lastId = memory.id;
                    }
                });

                hasMore = profiles.length === this.agentSettings.batchSize;
            }

            // Update the profiles map atomically
            this.userProfiles = loadedProfiles;
            this.lastSyncTimestamp = Date.now();

            elizaLogger.info(`Loaded ${loadedProfiles.size} user profiles`);
        } catch (error) {
            elizaLogger.error("Error loading user profiles:", error);
        }
    }

    private startProfileSync(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }

        this.syncInterval = setInterval(async () => {
            await this.syncProfiles();
        }, this.agentSettings.syncInterval);

        // Also subscribe to real-time profile updates
        this.subscribeToMemory("user_profile", async (memory) => {
            await this.handleProfileUpdate(memory);
        });
    }

    private async syncProfiles(): Promise<void> {
        try {
            // Fetch profiles updated since last sync
            const updatedProfiles = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: this.agentSettings.batchSize,
                start: this.lastSyncTimestamp
            });

            let updatedCount = 0;
            for (const memory of updatedProfiles) {
                if (memory.content.type === "user_profile") {
                    const profile = memory.content as UserProfileContent;
                    await this.mergeProfile(profile);
                    updatedCount++;
                }
            }

            if (updatedCount > 0) {
                elizaLogger.info(`Synced ${updatedCount} updated user profiles`);
            }

            this.lastSyncTimestamp = Date.now();
        } catch (error) {
            elizaLogger.error("Error syncing profiles:", error);
        }
    }

    private async handleProfileUpdate(memory: Memory): Promise<void> {
        try {
            if (memory.content.type === "user_profile") {
                const profile = memory.content as UserProfileContent;
                await this.mergeProfile(profile);
            } else if (memory.content.type === "user_profile_update") {
                await this.createMemory({
                    type: "user_profile_update",
                    id: stringToUuid(`profile-${Date.now()}`),
                    text: `Updated user profile`,
                    status: "executed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        updates: memory.content.updates,
                        updatedFields: memory.content.updatedFields,
                        timestamp: Date.now()
                    }
                });
            }
        } catch (error) {
            elizaLogger.error("Error handling profile update:", error);
        }
    }

    private async mergeProfile(newProfile: UserProfileContent): Promise<void> {
        const existingProfile = this.userProfiles.get(newProfile.id);
        
        // Only update if the new profile is more recent
        if (!existingProfile || newProfile.updatedAt > existingProfile.updatedAt) {
            this.userProfiles.set(newProfile.id, newProfile);
            
            // Broadcast update to other processes
            await this.broadcastProfileUpdate(newProfile);
        }
    }

    private async broadcastProfileUpdate(profile: UserProfileContent): Promise<void> {
        try {
            const updateEvent = {
                type: "user_profile_updated",
                id: stringToUuid(`profile-update-${Date.now()}`),
                content: profile,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                text: `User profile updated for ${profile.id}`
            };

            await this.runtime.messageManager.createMemory({
                id: updateEvent.id,
                content: updateEvent,
                roomId: ROOM_IDS.DAO,
                userId: profile.id,
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error("Error broadcasting profile update:", error);
        }
    }

    public override async shutdown(): Promise<void> {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        await super.shutdown();
    }

    private setupSubscriptions(): void {
        // Subscribe to wallet registration events
        this.subscribeToMemory("wallet_registration", async (memory) => {
            const { walletAddress, discordId } = memory.content;
            await this.handleWalletRegistration(memory.id, walletAddress as string, discordId as string | undefined);
        });

        // Subscribe to deposit events - using standardized deposit_received type
        this.subscribeToMemory("deposit_received", async (memory) => {
            const deposit = memory.content;
            await this.handleDeposit(memory.id, {
                token: (deposit as any).token as string,
                amount: (deposit as any).amount as string,
                uiAmount: (deposit as any).amount as string,
                decimals: 9, // Default for SOL, should be dynamic
                usdValue: (deposit as any).usdValue as string
            });
        });

        // Subscribe to vote events
        this.subscribeToMemory("vote_cast", async (memory) => {
            await this.updateUserActivity(memory.id, "vote", memory.content);
        });

        // Subscribe to strategy execution results
        this.subscribeToMemory("strategy_execution_result", async (memory) => {
            const content = memory.content as StrategyExecutionResult;
            if (content.success) {
                await this.updateUserActivity(memory.id, "strategy", {
                    type: "strategy_execution",
                    strategyId: content.strategyId,
                    executedAmount: content.executedAmount,
                    executionPrice: content.executionPrice,
                    success: true,
                    userStats: {
                        proposalsCreated: 0,
                        votesCount: 0
                    }
                });
            }
        });

        // Also subscribe to strategy execution records for backwards compatibility
        this.subscribeToMemory("strategy_execution", async (memory) => {
            const content = memory.content;
            if (content.status === "executed") {
                await this.updateUserActivity(memory.id, "strategy", {
                    type: "strategy_execution",
                    strategyId: content.strategyId,
                    executedAmount: content.amountExecuted,
                    executionPrice: content.priceAtExecution,
                    success: true,
                    userStats: {
                        proposalsCreated: 0,
                        votesCount: 0
                    }
                });
            }
        });

        // Nova-specific memory subscriptions
        this.subscribeToMemory("user_interaction", async (memory) => {
            await this.handleUserInteraction(memory);
        });

        this.subscribeToMemory("user_preference_update", async (memory) => {
            await this.handlePreferenceUpdate(memory);
        });

        this.subscribeToMemory("user_feedback", async (memory) => {
            await this.handleUserFeedback(memory);
        });

        this.subscribeToMemory("learning_update", async (memory) => {
            await this.handleLearningUpdate(memory);
        });

        this.subscribeToMemory("conversation_context", async (memory) => {
            await this.handleConversationContext(memory);
        });

        this.subscribeToMemory("task_tracking", async (memory) => {
            await this.handleTaskTracking(memory);
        });

        this.subscribeToMemory("user_profile_update", async (memory) => {
            await this.handleProfileUpdate(memory);
        });
    }

    private async handleWalletRegistration(
        userId: UUID,
        walletAddress: string,
        discordId?: string
    ): Promise<void> {
        try {
            let profile = this.userProfiles.get(userId);

            if (!profile) {
                // Create new profile
                profile = {
                    type: "user_profile",
                    id: userId,
                    text: `User profile for ${userId}`,
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "executed",
                    metadata: {
                        stats: {
                            proposalsCreated: 0,
                            votesCount: 0,
                            depositsVerified: 0,
                            strategiesCreated: 0
                        },
                        walletAddresses: [walletAddress],
                        discordId,
                        reputation: 0,
                        totalDeposits: []
                    }
                };
            } else {
                // Update existing profile
                if (!profile.metadata.walletAddresses.includes(walletAddress)) {
                    profile.metadata.walletAddresses.push(walletAddress);
                }
                if (discordId && !profile.metadata.discordId) {
                    profile.metadata.discordId = discordId;
                }
                profile.updatedAt = Date.now();
            }

            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error handling wallet registration:", error);
        }
    }

    private async handleDeposit(userId: UUID, deposit: TokenBalance): Promise<void> {
        try {
            const profile = this.userProfiles.get(userId);
            if (!profile) {
                elizaLogger.warn(`No profile found for user ${userId} during deposit`);
                return;
            }

            // Update total deposits
            const existingTokenIndex = profile.metadata.totalDeposits.findIndex(
                t => t.token === deposit.token
            );

            if (existingTokenIndex >= 0) {
                const existing = profile.metadata.totalDeposits[existingTokenIndex];
                profile.metadata.totalDeposits[existingTokenIndex] = {
                    ...existing,
                    amount: (BigInt(existing.amount) + BigInt(deposit.amount)).toString(),
                    usdValue: deposit.usdValue 
                        ? (Number(existing.usdValue || 0) + Number(deposit.usdValue)).toString()
                        : undefined
                };
            } else {
                profile.metadata.totalDeposits.push(deposit);
            }

            // Update reputation
            await this.updateReputation(userId, REPUTATION_SCORES.DEPOSIT, "Deposit made");

            // Update profile
            profile.updatedAt = Date.now();
            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error handling deposit:", error);
        }
    }

    private async updateUserActivity(
        userId: UUID,
        activityType: UserActivityLog["activityType"],
        details: Record<string, any>
    ): Promise<void> {
        try {
            // Log activity
            const activityLog: UserActivityLog = {
                type: "user_activity",
                id: stringToUuid(`activity-${Date.now()}`),
                userId,
                activityType,
                details,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                status: "executed",
                text: `User activity: ${activityType}`,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await this.runtime.messageManager.createMemory({
                id: activityLog.id,
                content: activityLog,
                roomId: ROOM_IDS.DAO,
                userId,
                agentId: this.runtime.agentId
            });

            // Update reputation based on activity
            const reputationScore = this.getReputationScoreForActivity(activityType);
            if (reputationScore > 0) {
                await this.updateReputation(userId, reputationScore, `${activityType} completed`);
            }

            // Update last active timestamp
            const profile = this.userProfiles.get(userId);
            if (profile) {
                profile.updatedAt = Date.now();
                await this.updateProfile(profile);
            }
        } catch (error) {
            elizaLogger.error("Error updating user activity:", error);
        }
    }

    private getReputationScoreForActivity(activityType: string): number {
        switch (activityType) {
            case "deposit":
                return REPUTATION_SCORES.DEPOSIT;
            case "proposal":
                return REPUTATION_SCORES.PROPOSAL_CREATED;
            case "vote_cast":
                return REPUTATION_SCORES.VOTE_CAST;
            case "strategy":
                return REPUTATION_SCORES.STRATEGY_SUCCESS;
            default:
                return 0;
        }
    }

    private async updateReputation(
        userId: UUID,
        points: number,
        reason: string
    ): Promise<void> {
        try {
            const profile = this.userProfiles.get(userId);
            if (!profile) return;

            const previousReputation = profile.metadata.reputation;
            profile.metadata.reputation += points;

            // Create reputation update record
            const reputationUpdate: UserReputationUpdate = {
                type: "reputation_update",
                id: stringToUuid(`rep-${Date.now()}`),
                userId,
                previousReputation,
                newReputation: profile.metadata.reputation,
                reason,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                status: "executed",
                text: `Reputation updated: ${reason}`,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await this.runtime.messageManager.createMemory({
                id: reputationUpdate.id,
                content: reputationUpdate,
                roomId: ROOM_IDS.DAO,
                userId,
                agentId: this.runtime.agentId
            });

            // Update voting power based on new reputation
            profile.metadata.votingPower = this.calculateVotingPower(profile);
            
            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error updating reputation:", error);
        }
    }

    private calculateVotingPower(profile: UserProfileContent): number {
        // Base voting power from reputation
        let power = Math.sqrt(profile.metadata.reputation);

        // Additional power from deposits (simplified)
        const totalUsdValue = profile.metadata.totalDeposits.reduce((sum, deposit) => {
            return sum + (deposit.usdValue ? Number(deposit.usdValue) : 0);
        }, 0);

        // Add deposit-based power (1 power per $100 deposited)
        power += totalUsdValue / 100;

        return Math.floor(power);
    }

    private async updateProfile(profile: UserProfileContent): Promise<void> {
        this.userProfiles.set(profile.id, {
            ...profile,
            updatedAt: Date.now()
        });
        await this.broadcastProfileUpdate(profile);
    }

    protected async getUserProfile(userId: UUID): Promise<{ reputation?: number; role?: string }> {
        const profile = this.userProfiles.get(userId);
        if (!profile) {
            return {};
        }
        return {
            reputation: profile.metadata.reputation,
            role: this.calculateRank(profile.metadata.reputation)
        };
    }

    public async getFullUserProfile(userId: UUID): Promise<UserProfileContent | null> {
        return this.userProfiles.get(userId) || null;
    }

    private async createNewProfile(userId: UUID, walletAddress: string, discordId?: string): Promise<UserProfileContent> {
        return {
            type: "user_profile",
            id: userId,
            text: `User profile for ${userId}`,
            agentId: this.runtime.agentId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "executed",
            metadata: {
                stats: {
                    proposalsCreated: 0,
                    votesCount: 0,
                    depositsVerified: 0,
                    strategiesCreated: 0
                },
                walletAddresses: [walletAddress],
                discordId,
                reputation: 0,
                totalDeposits: []
            }
        };
    }

    public async getUserByWallet(walletAddress: string): Promise<UserProfileContent | undefined> {
        for (const profile of this.userProfiles.values()) {
            if (profile.metadata.walletAddresses.includes(walletAddress)) {
                return profile;
            }
        }
        return undefined;
    }

    public async getUserByDiscordId(discordId: string): Promise<UserProfileContent | undefined> {
        return Array.from(this.userProfiles.values()).find(
            profile => profile.metadata.discordId === discordId
        );
    }

    public async validateAction(content: BaseContent): Promise<boolean> {
        return true; // Add specific validation if needed
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        return true; // Add specific action execution if needed
    }

    private async processUserMemory(memory: Memory): Promise<void> {
        // Add memory processing logic if needed
    }

    public async isActive(): Promise<boolean> {
        try {
            // Check if agent state is active in the database
            const state = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1
            });

            const agentState = state.find(memory => 
                memory.content.type === "agent_state" &&
                memory.content.agentId === this.id
            );

            return agentState?.content.status === "active";
        } catch (error) {
            elizaLogger.error("Error checking UserProfileAgent state:", error);
            return false;
        }
    }

    private async handleNewProposal(proposerId: UUID, proposalId: string): Promise<void> {
        try {
            // Get user profile
            const userProfile = await this.getUserProfile(proposerId) as UserProfileContent | null;
            if (!userProfile) {
                elizaLogger.warn(`No user profile found for proposer ${proposerId}`);
                return;
            }

            // Update user's proposal count
            const updatedProfile: UserProfileContent = {
                ...userProfile,
                metadata: {
                    ...userProfile.metadata,
                    proposalId: proposalId,
                    userStats: {
                        proposalsCreated: userProfile.metadata.stats.proposalsCreated + 1,
                        votesCount: userProfile.metadata.stats.votesCount
                    }
                },
                updatedAt: Date.now()
            };

            // Store updated profile
            await this.createMemory(updatedProfile);

            elizaLogger.info(`Updated user profile for new proposal`, {
                userId: proposerId,
                proposalId,
                newProposalCount: updatedProfile.metadata.stats.proposalsCreated
            });
        } catch (error) {
            elizaLogger.error(`Error handling new proposal for user ${proposerId}:`, error);
        }
    }

    protected subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        super.subscribeToMemory(type, callback);
    }

    protected async handleMemory(memory: Memory): Promise<void> {
        if (memory.content.type === "user_profile") {
            await this.handleProfileUpdate(memory);
        }
    }

    protected loadActions(): void {
        // Register capabilities for user profile management
        this.registerCapability({
            name: "profile_management",
            description: "Manage user profiles and reputation",
            requiredPermissions: ["manage_profiles"],
            actions: ["profile", "reputation", "leaderboard"]
        });

        // Register shared actions
        this.runtime.registerAction(tokeninfo);
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // Subscribe to profile updates from other processes
        this.messageBroker.subscribe("user_profile_updated", async (event) => {
            if (event.memory) {
                await this.handleProfileUpdate(event.memory);
            }
        });
    }

    protected async executeWithValidation<T extends Record<string, unknown>, R>(
        operation: string,
        params: T,
        executor: (params: T) => Promise<R>
    ): Promise<R> {
        try {
            // Validate operation if params is a BaseContent
            if (this.isBaseContent(params)) {
                const validationResult = await this.validateAction(params);
                if (!validationResult) {
                    throw new Error(`Validation failed for operation: ${operation}`);
                }
            }

            // Execute with transaction
            return await this.withTransaction(operation, async () => {
                return await executor(params);
            });
        } catch (error) {
            elizaLogger.error(`Error in ${operation}:`, error);
            throw error;
        }
    }

    private isBaseContent(params: Record<string, unknown>): params is BaseContent {
        return (
            typeof params === 'object' &&
            params !== null &&
            'id' in params &&
            'type' in params &&
            'text' in params &&
            'agentId' in params
        );
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        // Validate if we should handle this message
        if (!await this.validateMessage(message)) {
            return;
        }

        const command = message.content.text.toLowerCase().trim();
        let response: CommandResponse | null = null;

        if (command.startsWith('!profile')) {
            response = await this.handleProfileCommand(message);
        } else if (command.startsWith('!reputation')) {
            response = await this.handleReputationCommand(message);
        } else if (command.startsWith('!leaderboard')) {
            response = await this.handleLeaderboardCommand(message);
        }

        if (response) {
            const messageId = message.content.id as UUID;
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`${messageId}-response`),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: response.text,
                    action: response.action,
                    source: "discord"
                },
                roomId: message.content.roomId as UUID,
                createdAt: Date.now()
            });
        }
    }

    private async validateMessage(message: AgentMessage): Promise<boolean> {
        const text = message.content.text.toLowerCase().trim();
        return text.startsWith('!profile') ||
               text.startsWith('!reputation') ||
               text.startsWith('!leaderboard');
    }

    private async handleProfileCommand(message: AgentMessage): Promise<CommandResponse> {
        const userId = message.content.userId as UUID;
        const profile = await this.getFullUserProfile(userId);

        if (!profile) {
            return {
                text: "❌ Profile not found. Please register first using the wallet registration command.",
                action: "profile"
            };
        }

        const votingPower = this.calculateVotingPower(profile);
        const recentActivity = await this.getRecentActivity(userId);

        return {
            text: `📊 **Your Profile Overview**
Reputation: ${profile.metadata.reputation}
Voting Power: ${votingPower}
Contributions:
• Proposals Created: ${profile.metadata.stats.proposalsCreated}
• Votes Cast: ${profile.metadata.stats.votesCount}
• Verified Deposits: ${profile.metadata.stats.depositsVerified}

Recent Activity:
${recentActivity.map(activity => `• ${activity}`).join('\n')}`,
            action: "profile"
        };
    }

    private async handleReputationCommand(message: AgentMessage): Promise<CommandResponse> {
        const text = message.content.text;
        const mentionMatch = text.match(/@(\w+)/);
        
        if (!mentionMatch) {
            return {
                text: "❌ Please mention a user to check their reputation (e.g., !reputation @username)",
                action: "reputation"
            };
        }

        const targetDiscordId = mentionMatch[1];
        const targetProfile = await this.getUserByDiscordId(targetDiscordId);

        if (!targetProfile) {
            return {
                text: "❌ User profile not found.",
                action: "reputation"
            };
        }

        const rank = this.calculateRank(targetProfile.metadata.reputation);
        const achievements = await this.getAchievements(targetProfile.id);

        return {
            text: `⭐ **Reputation Check**
@${targetDiscordId}'s current reputation: ${targetProfile.metadata.reputation}
Rank: ${rank}
Notable Achievements:
${achievements.map(achievement => `• ${achievement}`).join('\n')}`,
            action: "reputation"
        };
    }

    private async handleLeaderboardCommand(message: AgentMessage): Promise<CommandResponse> {
        const topUsers = await this.getTopUsers();
        const weeklyStats = await this.getWeeklyStats();

        return {
            text: `🏆 **Community Leaderboard**

${topUsers.map((user, index) => `${index + 1}. @${user.metadata.discordId} - ${user.metadata.reputation} rep ${user.change}`).join('\n')}

Most Active This Week:
• Proposals: @${weeklyStats.topProposer}
• Voting: @${weeklyStats.topVoter}
• Strategies: @${weeklyStats.topStrategist}`,
            action: "leaderboard"
        };
    }

    private async getRecentActivity(userId: UUID): Promise<string[]> {
        const activities = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.DAO,
            count: 5
        });

        return activities.map(activity => {
            const metadata = activity.content.metadata as Record<string, unknown> | undefined;
            const type = activity.content.type;

            if (metadata && typeof type === 'string') {
                if (metadata.proposalId && typeof metadata.proposalId === 'string') {
                    switch (type) {
                        case 'proposal_created':
                            return `Created proposal #${metadata.proposalId}`;
                        case 'vote_cast':
                            return `Voted on proposal #${metadata.proposalId}`;
                    }
                }
                if (metadata.token && typeof metadata.token === 'string' && type === 'strategy_created') {
                    return `Created strategy for ${metadata.token}`;
                }
            }
            return activity.content.text;
        });
    }

    private calculateRank(reputation: number): string {
        if (reputation >= 1000) return "DAO Legend";
        if (reputation >= 750) return "Master Contributor";
        if (reputation >= 500) return "Senior Member";
        if (reputation >= 250) return "Active Contributor";
        if (reputation >= 100) return "Regular Member";
        return "New Member";
    }

    private async getAchievements(userId: UUID): Promise<string[]> {
        const profile = await this.getFullUserProfile(userId);
        const achievements: string[] = [];

        if (!profile) return achievements;

        if (profile.metadata.stats.proposalsCreated >= 10) {
            achievements.push("Proposal Master");
        }
        if (profile.metadata.stats.votesCount >= 50) {
            achievements.push("Top Voter");
        }
        if (profile.metadata.stats.strategiesCreated >= 5) {
            achievements.push("Strategy Expert");
        }

        return achievements;
    }

    private async getTopUsers(): Promise<Array<{id: UUID; metadata: UserProfileMetadata; change: string}>> {
        const profiles = Array.from(this.userProfiles.values())
            .sort((a, b) => b.metadata.reputation - a.metadata.reputation)
            .slice(0, 3);

        return profiles.map(profile => ({
            id: profile.id,
            metadata: profile.metadata,
            change: this.getReputationChange(profile) // You would implement this based on historical data
        }));
    }

    private async getWeeklyStats(): Promise<{topProposer: string; topVoter: string; topStrategist: string}> {
        // This would be implemented to track weekly statistics
        // For now returning placeholder data
        return {
            topProposer: "user1",
            topVoter: "user2",
            topStrategist: "user3"
        };
    }

    private getReputationChange(profile: UserProfileContent): string {
        // Implement reputation change tracking
        // For now returning placeholder
        return "↔️";
    }

    // Nova-specific memory handlers
    private async handleUserInteraction(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "user_interaction",
                id: stringToUuid(`interaction-${Date.now()}`),
                text: `Processed user interaction: ${content.text}`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    interactionType: content.interactionType,
                    context: content.context,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling user interaction:", error);
        }
    }

    private async handlePreferenceUpdate(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "user_preference_update",
                id: stringToUuid(`pref-${Date.now()}`),
                text: `Updated user preferences`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    preferences: content.preferences,
                    updatedBy: content.updatedBy,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling preference update:", error);
        }
    }

    private async handleUserFeedback(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "user_feedback",
                id: stringToUuid(`feedback-${Date.now()}`),
                text: `Received user feedback: ${content.text}`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    rating: content.rating,
                    category: content.category,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling user feedback:", error);
        }
    }

    private async handleLearningUpdate(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "learning_update",
                id: stringToUuid(`learn-${Date.now()}`),
                text: `Updated learning model: ${content.text}`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    learningType: content.learningType,
                    modelUpdates: content.modelUpdates,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling learning update:", error);
        }
    }

    private async handleConversationContext(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "conversation_context",
                id: stringToUuid(`context-${Date.now()}`),
                text: `Updated conversation context`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    context: content.context,
                    relevantTopics: content.relevantTopics,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling conversation context:", error);
        }
    }

    private async handleTaskTracking(memory: Memory): Promise<void> {
        try {
            const content = memory.content;
            await this.createMemory({
                type: "task_tracking",
                id: stringToUuid(`task-${Date.now()}`),
                text: `Updated task status: ${content.text}`,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    taskId: content.taskId,
                    status: content.status,
                    progress: content.progress,
                    timestamp: Date.now()
                }
            });
        } catch (error) {
            elizaLogger.error("Error handling task tracking:", error);
        }
    }
} 