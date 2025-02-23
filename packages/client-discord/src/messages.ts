// packages/client-discord/src/messages.ts 

import { composeContext, composeRandomUser } from "@elizaos/core";
import { generateMessageResponse, generateShouldRespond } from "@elizaos/core";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    IBrowserService,
    ISpeechService,
    IVideoService,
    Media,
    Memory,
    ModelClass,
    ServiceType,
    State,
    UUID,
    elizaLogger,
    stringToUuid,
    getEmbeddingZeroVector
} from "@elizaos/core";
import {
    ChannelType,
    Client,
    Message as DiscordMessage,
    TextChannel,
    MessageReaction,
    User,
} from "discord.js";
import { AttachmentManager } from "./attachments";
import { VoiceManager } from "./voice";
import {
    discordShouldRespondTemplate,
    discordMessageHandlerTemplate,
} from "./templates";
import {
    IGNORE_RESPONSE_WORDS,
    LOSE_INTEREST_WORDS,
    MESSAGE_CONSTANTS,
    MESSAGE_LENGTH_THRESHOLDS,
    RESPONSE_CHANCES,
    TEAM_COORDINATION,
    TIMING_CONSTANTS,
} from "./constants";
import {
    sendMessageInChunks,
    canSendMessage,
    cosineSimilarity,
} from "./utils";
import { AgentType, BaseAgent, ProposalAgent, IAgentRuntime as SolanaAgentRuntime, createSolanaRuntime } from "@elizaos/plugin-solana";

// Use the same UUID format as in constants.ts
const DAO_ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

interface MessageContext {
    content: string;
    timestamp: number;
}

export type InterestChannels = {
    [key: string]: {
        currentHandler: string | undefined;
        lastMessageSent: number;
        messages: { userId: UUID; userName: string; content: Content }[];
        previousContext?: MessageContext;
        contextSimilarityThreshold?: number;
    };
};

export class MessageManager {
    private client: Client;
    private runtime: SolanaAgentRuntime;
    private attachmentManager: AttachmentManager;
    private interestChannels: InterestChannels = {};
    private discordClient: any;
    private voiceManager: VoiceManager;
    private proposalAgent: ProposalAgent;

    constructor(discordClient: any, voiceManager: VoiceManager) {
        this.client = discordClient.client;
        this.voiceManager = voiceManager;
        this.discordClient = discordClient;
        this.runtime = discordClient.runtime as SolanaAgentRuntime;
        this.attachmentManager = new AttachmentManager(this.runtime);
        
        // Initialize ProposalAgent with Solana runtime
        createSolanaRuntime(this.runtime).then(solanaRuntime => {
            this.proposalAgent = new ProposalAgent(solanaRuntime);
            this.proposalAgent.initialize();
        });
    }

    async handleMessage(message: DiscordMessage) {
        if (message.interaction || message.author.id === this.client.user?.id) {
            return;
        }

        // Early return for bot messages if configured to ignore them
        if (this.runtime.character.clientConfig?.discord?.shouldIgnoreBotMessages && message.author?.bot) {
            return;
        }

        let wasHandledByAction = false;
        let shouldRespond = false;

        // Get basic message info first
        const userId = message.author.id as UUID;
        const userName = message.author.username;
        const channelId = message.channel.id;
        // Always use global DAO room for Discord messages to ensure all agents can see them
        const roomId = DAO_ROOM_ID;
        const userIdUUID = stringToUuid(userId);

        // Ensure connection exists
        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            userName,
            message.author.displayName,
            "discord"
        );

        const contentTrimmed = message.content.trim();
        const mentionRegex = new RegExp(`^<@${this.client.user?.id}>\\s*`);
        const contentWithoutMention = contentTrimmed.replace(mentionRegex, "").trim();

        // Create base memory content
        const content: Content = {
            text: contentTrimmed,
            source: "discord",
            url: message.url,
            username: message.author.username,
            displayName: message.author.displayName,
            channelId: channelId, // Store original channel ID for reference
            inReplyTo: message.reference?.messageId
                ? stringToUuid(message.reference.messageId + "-" + this.runtime.agentId)
                : undefined,
        };

        // Create base memory
        const messageId = stringToUuid(message.id + "-" + this.runtime.agentId);
        const memory: Memory = {
            id: messageId,
            userId: userIdUUID,
            agentId: this.runtime.agentId,
            roomId,  // Using global room
            content,
            createdAt: message.createdTimestamp,
        };

        // Ensure we track messages in this channel
        if (!this.interestChannels[channelId]) {
            this.interestChannels[channelId] = {
                currentHandler: undefined,
                lastMessageSent: Date.now(),
                messages: []
            };
        }
        this.interestChannels[channelId].messages.push({
            userId: userIdUUID,
            userName,
            content
        });
        this.interestChannels[channelId].lastMessageSent = Date.now();

        // Handle commands first - with early return
        if (contentWithoutMention.startsWith('!')) {
            const commandName = contentWithoutMention.slice(1).split(/\s+/)[0].toLowerCase();
            
            // Create command-specific memory without triggering full state composition
            const commandMemory: Memory = {
                id: stringToUuid(`${message.id}-command`),
                userId: userIdUUID,
                agentId: this.runtime.agentId,
                roomId,
                content: {
                    ...content,
                    action: commandName,
                    from: message.author.id
                }
            };

            // Create minimal state for command processing
            const commandState: State = {
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                roomId: roomId,
                actors: "",
                recentMessages: "",
                recentMessagesData: [],
                discordMessage: message
            };

            // Process command directly
            await this.runtime.processActions(
                memory,
                [commandMemory],
                commandState,
                async (response: Content): Promise<Memory[]> => {
                    try {
                        const discordMessages = await sendMessageInChunks(
                            message.channel as TextChannel,
                            response.text,
                            message.id,
                            []
                        );
                        
                        const responseMemories: Memory[] = [];
                        
                        // Store response memories
                        for (const m of discordMessages) {
                            const responseMemory: Memory = {
                                id: stringToUuid(m.id + "-" + this.runtime.agentId),
                                userId: this.runtime.agentId,
                                agentId: this.runtime.agentId,
                                roomId: roomId,
                                content: {
                                    text: m.content,
                                    source: "discord",
                                    action: commandName
                                },
                                createdAt: m.createdTimestamp
                            };
                            await this.runtime.messageManager.createMemory(responseMemory);
                            responseMemories.push(responseMemory);
                        }
                        return responseMemories;
                    } catch (error) {
                        elizaLogger.error("Error processing command:", error);
                        return [];
                    }
                }
            );
            
            return; // Early return after command processing
        }

        // Only process non-command messages through full state composition
        await this.runtime.messageManager.addEmbeddingToMemory(memory);
        await this.runtime.messageManager.createMemory(memory);

        // Process message content and create memory
        const { processedContent, attachments } = await this.processMessageMedia(message);
        memory.content.text = processedContent;
        memory.content.attachments = attachments;

        // Compose state for normal message processing
        const state = await this.runtime.composeState(
            { content, userId: userIdUUID, agentId: this.runtime.agentId, roomId },
            {
                discordClient: this.client,
                discordMessage: message,
                agentName: this.runtime.character.name || this.client.user?.displayName,
            }
        );

        if (processedContent && !processedContent.startsWith('!')) {
            // Try natural language actions first
            const actionMemory: Memory = {
                id: stringToUuid(`${message.id}-action`),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId,
                content: {
                    text: processedContent,
                    source: "discord"
                }
            };

            // Process through actions to catch natural language handlers like tokeninfo
            try {
                const actionResult = await this.runtime.processActions(
                    memory,
                    [actionMemory],
                    state,
                    async (response: Content) => {
                        try {
                            const discordMessages = await sendMessageInChunks(
                                message.channel as TextChannel,
                                response.text,
                                message.id,
                                []
                            );
                            const memories: Memory[] = [];
                            for (const m of discordMessages) {
                                const memory: Memory = {
                                    id: stringToUuid(m.id + "-" + this.runtime.agentId),
                                    userId: this.runtime.agentId,
                                    agentId: this.runtime.agentId,
                                    roomId: roomId,
                                    content: {
                                        text: m.content,
                                        source: "discord",
                                        action: response.action
                                    },
                                    createdAt: m.createdTimestamp
                                };
                                memories.push(memory);
                                await this.runtime.messageManager.createMemory(memory);
                            }
                            wasHandledByAction = true;
                            return memories;
                        } catch (error) {
                            elizaLogger.error("Error sending natural language action response:", error);
                            return [];
                        }
                    }
                );
            } catch (error) {
                elizaLogger.error("Error processing natural language action:", error);
            }

            // If no natural language action handled it, proceed with normal LLM flow
            if (!wasHandledByAction) {
                // Check mentions-only mode
                if (this.runtime.character.clientConfig?.discord?.shouldRespondOnlyToMentions) {
                    shouldRespond = this._isMessageForMe(message);
                } else {
                    // Check interest and other response criteria
                    const hasInterest = this._checkInterest(message.channelId);
                    const isDirectlyMentioned = this._isMessageForMe(message);

                    if (isDirectlyMentioned || hasInterest) {
                        shouldRespond = await this._shouldRespond(message, state);
                    }
                }

                // If we should respond, generate LLM response
                if (shouldRespond) {
                    const context = composeContext({
                        state,
                        template: this.runtime.character.templates?.discordMessageHandlerTemplate ||
                                 discordMessageHandlerTemplate,
                    });

                    // Simulate typing while generating response
                    const stopTyping = this.simulateTyping(message);

                    try {
                        const responseContent = await this._generateResponse(memory, state, context);
                        stopTyping();

                        if (responseContent?.text) {
                            responseContent.text = responseContent.text.trim();
                            responseContent.inReplyTo = messageId;

                            // Always send through processActions for complete Eliza flow
                            const responseMemories = await this._sendResponse(message, responseContent, roomId, messageId);
                            
                            // Call processActions even if no action, to ensure proper framework flow
                            await this.runtime.processActions(
                                memory,
                                responseMemories,
                                state,
                                async (content: Content) => {
                                    return this._sendResponse(message, content, roomId, messageId);
                                }
                            );
                        }
                    } catch (error) {
                        stopTyping();
                        elizaLogger.error("Error generating/sending response:", error);
                    }
                }
            }
        }

        // Finally, run evaluations with the correct values
        await this.runtime.evaluate(memory, state, wasHandledByAction || shouldRespond);
    }

    private async _sendResponse(
        message: DiscordMessage,
        content: Content,
        roomId: UUID,
        messageId: UUID
    ): Promise<Memory[]> {
        try {
            const messages = await sendMessageInChunks(
                message.channel as TextChannel,
                content.text,
                message.id,
                []
            );

            const memories: Memory[] = [];
            for (const m of messages) {
                let action = content.action;
                if (messages.length > 1 && m !== messages[messages.length - 1]) {
                    action = "CONTINUE";
                }

                const memory: Memory = {
                    id: stringToUuid(m.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        ...content,
                        action,
                        inReplyTo: messageId,
                        url: m.url,
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: m.createdTimestamp,
                };
                memories.push(memory);
            }

            for (const m of memories) {
                await this.runtime.messageManager.createMemory(m);
            }
            return memories;
        } catch (error) {
            elizaLogger.error("Error sending response:", error);
            return [];
        }
    }

    async cacheMessages(channel: TextChannel, count: number = 20) {
        const messages = await channel.messages.fetch({ limit: count });

        // TODO: This is throwing an error but seems to work?
        for (const [_, message] of messages) {
            await this.handleMessage(message);
        }
    }

    private _isMessageForMe(message: DiscordMessage): boolean {
        const isMentioned = message.mentions.users?.has(
            this.client.user?.id as string
        );
        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        // Don't consider role mentions as direct mentions
        const hasRoleMentionOnly =
            message.mentions.roles.size > 0 && !isMentioned;

        // If it's only a role mention and we're in team mode, let team logic handle it
        if (
            hasRoleMentionOnly &&
            this.runtime.character.clientConfig?.discord?.isPartOfTeam
        ) {
            return false;
        }

        return (
            isMentioned ||
            (!this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions &&
                (message.content
                    .toLowerCase()
                    .includes(
                        this.client.user?.username.toLowerCase() as string
                    ) ||
                    message.content
                        .toLowerCase()
                        .includes(
                            this.client.user?.tag.toLowerCase() as string
                        ) ||
                    (nickname &&
                        message.content
                            .toLowerCase()
                            .includes(nickname.toLowerCase()))))
        );
    }

    async processMessageMedia(
        message: DiscordMessage
    ): Promise<{ processedContent: string; attachments: Media[] }> {
        let processedContent = message.content;

        let attachments: Media[] = [];

        // Process code blocks in the message content
        const codeBlockRegex = /```([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockRegex.exec(processedContent))) {
            const codeBlock = match[1];
            const lines = codeBlock.split("\n");
            const title = lines[0];
            const description = lines.slice(0, 3).join("\n");
            const attachmentId =
                `code-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(
                    -5
                );
            attachments.push({
                id: attachmentId,
                url: "",
                title: title || "Code Block",
                source: "Code",
                description: description,
                text: codeBlock,
            });
            processedContent = processedContent.replace(
                match[0],
                `Code Block (${attachmentId})`
            );
        }

        // Process message attachments
        if (message.attachments.size > 0) {
            attachments = await this.attachmentManager.processAttachments(
                message.attachments
            );
        }

        // TODO: Move to attachments manager
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = processedContent.match(urlRegex) || [];

        for (const url of urls) {
            if (
                this.runtime
                    .getService<IVideoService>(ServiceType.VIDEO)
                    ?.isVideoUrl(url)
            ) {
                const videoService = this.runtime.getService<IVideoService>(
                    ServiceType.VIDEO
                );
                if (!videoService) {
                    throw new Error("Video service not found");
                }
                const videoInfo = await videoService.processVideo(
                    url,
                    this.runtime
                );

                attachments.push({
                    id: `youtube-${Date.now()}`,
                    url: url,
                    title: videoInfo.title,
                    source: "YouTube",
                    description: videoInfo.description,
                    text: videoInfo.text,
                });
            } else {
                const browserService = this.runtime.getService<IBrowserService>(
                    ServiceType.BROWSER
                );
                if (!browserService) {
                    throw new Error("Browser service not found");
                }

                const { title, description: summary } =
                    await browserService.getPageContent(url, this.runtime);

                attachments.push({
                    id: `webpage-${Date.now()}`,
                    url: url,
                    title: title || "Web Page",
                    source: "Web",
                    description: summary,
                    text: summary,
                });
            }
        }

        return { processedContent, attachments };
    }

    private _getNormalizedUserId(id: string): string {
        return id.toString().replace(/[^0-9]/g, "");
    }

    private _isTeamMember(userId: string): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;
        if (!teamConfig?.isPartOfTeam || !teamConfig.teamAgentIds) return false;

        const normalizedUserId = this._getNormalizedUserId(userId);

        const isTeamMember = teamConfig.teamAgentIds.some(
            (teamId) => this._getNormalizedUserId(teamId) === normalizedUserId
        );

        return isTeamMember;
    }

    private _isTeamLeader(): boolean {
        return (
            this.client.user?.id ===
            this.runtime.character.clientConfig?.discord?.teamLeaderId
        );
    }

    private _isTeamCoordinationRequest(content: string): boolean {
        const contentLower = content.toLowerCase();
        return TEAM_COORDINATION.KEYWORDS?.some((keyword) =>
            contentLower.includes(keyword.toLowerCase())
        );
    }

    private _isRelevantToTeamMember(
        content: string,
        channelId: string,
        lastAgentMemory: Memory | null = null
    ): boolean {
        const teamConfig = this.runtime.character.clientConfig?.discord;

        if (this._isTeamLeader() && lastAgentMemory?.content.text) {
            const timeSinceLastMessage = Date.now() - lastAgentMemory.createdAt;
            if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
                return false; // Memory too old, not relevant
            }

            const similarity = cosineSimilarity(
                content.toLowerCase(),
                lastAgentMemory.content.text.toLowerCase()
            );

            return (
                similarity >=
                MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD_FOLLOW_UPS
            );
        }

        // If no keywords defined, only leader maintains conversation
        if (!teamConfig?.teamMemberInterestKeywords) {
            return false;
        }

        return teamConfig.teamMemberInterestKeywords.some((keyword) =>
            content.toLowerCase().includes(keyword.toLowerCase())
        );
    }

    private async _analyzeContextSimilarity(
        currentMessage: string,
        previousContext?: MessageContext,
        agentLastMessage?: string
    ): Promise<number> {
        if (!previousContext) return 1; // No previous context to compare against

        // If more than 5 minutes have passed, reduce similarity weight
        const timeDiff = Date.now() - previousContext.timestamp;
        const timeWeight = Math.max(0, 1 - timeDiff / (5 * 60 * 1000)); // 5 minutes threshold

        // Calculate content similarity
        const similarity = cosineSimilarity(
            currentMessage.toLowerCase(),
            previousContext.content.toLowerCase(),
            agentLastMessage?.toLowerCase()
        );

        // Weight the similarity by time factor
        const weightedSimilarity = similarity * timeWeight;

        return weightedSimilarity;
    }

    private async _shouldRespondBasedOnContext(
        message: DiscordMessage,
        channelState: InterestChannels[string]
    ): Promise<boolean> {
        // Always respond if directly mentioned
        if (this._isMessageForMe(message)) return true;

        // If we're not the current handler, don't respond
        if (channelState?.currentHandler !== this.client.user?.id) return false;

        // Check if we have messages to compare
        if (!channelState.messages?.length) return false;

        // Get last user message (not from the bot)
        const lastUserMessage = [...channelState.messages].reverse().find(
            (m, index) =>
                index > 0 && // Skip first message (current)
                m.userId !== this.runtime.agentId
        );

        if (!lastUserMessage) return false;

        const lastSelfMemories = await this.runtime.messageManager.getMemories({
            roomId: stringToUuid(
                message.channel.id + "-" + this.runtime.agentId
            ),
            unique: false,
            count: 5,
        });

        const lastSelfSortedMemories = lastSelfMemories
            ?.filter((m) => m.userId === this.runtime.agentId)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        // Calculate context similarity
        const contextSimilarity = await this._analyzeContextSimilarity(
            message.content,
            {
                content: lastUserMessage.content.text || "",
                timestamp: Date.now(),
            },
            lastSelfSortedMemories?.[0]?.content?.text
        );

        const similarityThreshold =
            this.runtime.character.clientConfig?.discord
                ?.messageSimilarityThreshold ||
            channelState.contextSimilarityThreshold ||
            MESSAGE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD;

        return contextSimilarity >= similarityThreshold;
    }

    private _checkInterest(channelId: string): boolean {
        const channelState = this.interestChannels[channelId];
        if (!channelState) return false;

        const lastMessage =
            channelState.messages[channelState.messages.length - 1];
        // If it's been more than 5 minutes since last message, reduce interest
        const timeSinceLastMessage = Date.now() - channelState.lastMessageSent;

        if (timeSinceLastMessage > MESSAGE_CONSTANTS.INTEREST_DECAY_TIME) {
            delete this.interestChannels[channelId];
            return false;
        } else if (
            timeSinceLastMessage > MESSAGE_CONSTANTS.PARTIAL_INTEREST_DECAY
        ) {
            // Require stronger relevance for continued interest
            return this._isRelevantToTeamMember(
                lastMessage.content.text || "",
                channelId
            );
        }

        // If team leader and messages exist, check for topic changes and team member responses
        if (this._isTeamLeader() && channelState.messages.length > 0) {
            // If leader's keywords don't match and another team member has responded, drop interest
            if (
                !this._isRelevantToTeamMember(
                    lastMessage.content.text || "",
                    channelId
                )
            ) {
                const recentTeamResponses = channelState.messages
                    .slice(-3)
                    .some(
                        (m) =>
                            m.userId !== this.client.user?.id &&
                            this._isTeamMember(m.userId)
                    );

                if (recentTeamResponses) {
                    delete this.interestChannels[channelId];
                    return false;
                }
            }
        }

        // Check if conversation has shifted to a new topic
        if (channelState.messages.length > 0) {
            const recentMessages = channelState.messages.slice(
                -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
            );
            const differentUsers = new Set(recentMessages.map((m) => m.userId))
                .size;

            // If multiple users are talking and we're not involved, reduce interest
            if (
                differentUsers > 1 &&
                !recentMessages.some((m) => m.userId === this.client.user?.id)
            ) {
                delete this.interestChannels[channelId];
                return false;
            }
        }

        return true;
    }

    private async _shouldIgnore(message: DiscordMessage): Promise<boolean> {
        // if the message is from us, ignore
        if (message.author.id === this.client.user?.id) return true;

        // Honor mentions-only mode
        if (
            this.runtime.character.clientConfig?.discord
                ?.shouldRespondOnlyToMentions
        ) {
            return !this._isMessageForMe(message);
        }

        // Team-based ignore logic
        if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
            const authorId = this._getNormalizedUserId(message.author.id);

            if (this._isTeamLeader()) {
                if (this._isTeamCoordinationRequest(message.content)) {
                    return false;
                }
                // Ignore if message is only about team member interests and not directed to leader
                if (!this._isMessageForMe(message)) {
                    const otherMemberInterests =
                        this.runtime.character.clientConfig?.discord
                            ?.teamMemberInterestKeywords || [];
                    const hasOtherInterests = otherMemberInterests.some(
                        (keyword) =>
                            message.content
                                .toLowerCase()
                                .includes(keyword.toLowerCase())
                    );
                    if (hasOtherInterests) {
                        return true;
                    }
                }
            } else if (this._isTeamCoordinationRequest(message.content)) {
                const randomDelay =
                    Math.floor(
                        Math.random() *
                            (TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MAX -
                                TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN)
                    ) + TIMING_CONSTANTS.TEAM_MEMBER_DELAY_MIN; // 1-3 second random delay
                await new Promise((resolve) =>
                    setTimeout(resolve, randomDelay)
                );
                return false;
            }

            if (this._isTeamMember(authorId)) {
                if (!this._isMessageForMe(message)) {
                    // If message contains our interests, don't ignore
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }
                    return true;
                }
            }

            // Check if we're in an active conversation based on context
            const channelState = this.interestChannels[message.channelId];

            if (channelState?.currentHandler) {
                // If we're the current handler, check context
                if (channelState.currentHandler === this.client.user?.id) {
                    //If it's our keywords, bypass context check
                    if (
                        this._isRelevantToTeamMember(
                            message.content,
                            message.channelId
                        )
                    ) {
                        return false;
                    }

                    const shouldRespondContext =
                        await this._shouldRespondBasedOnContext(
                            message,
                            channelState
                        );

                    // If context is different, ignore. If similar, don't ignore
                    return !shouldRespondContext;
                }

                // If another team member is handling and we're not mentioned or coordinating
                else if (
                    !this._isMessageForMe(message) &&
                    !this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }
            }
        }

        let messageContent = message.content.toLowerCase();

        // Replace the bot's @ping with the character name
        const botMention = `<@${this.client.user?.id}>`;
        messageContent = messageContent.replace(
            new RegExp(botMention, "gi"),
            this.runtime.character.name.toLowerCase()
        );

        // Replace the bot's username with the character name
        const botUsername = this.client.user?.username.toLowerCase();
        messageContent = messageContent.replace(
            new RegExp(`\\b${botUsername}\\b`, "g"),
            this.runtime.character.name.toLowerCase()
        );

        // strip all special characters
        messageContent = messageContent.replace(/[^a-zA-Z0-9\s]/g, "");

        // short responses where eliza should stop talking and disengage unless mentioned again
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.LOSE_INTEREST &&
            LOSE_INTEREST_WORDS.some((word) => messageContent.includes(word))
        ) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // If we're not interested in the channel and it's a short message, ignore it
        if (
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.SHORT_MESSAGE &&
            !this.interestChannels[message.channelId]
        ) {
            return true;
        }

        const targetedPhrases = [
            this.runtime.character.name + " stop responding",
            this.runtime.character.name + " stop talking",
            this.runtime.character.name + " shut up",
            this.runtime.character.name + " stfu",
            "stop talking" + this.runtime.character.name,
            this.runtime.character.name + " stop talking",
            "shut up " + this.runtime.character.name,
            this.runtime.character.name + " shut up",
            "stfu " + this.runtime.character.name,
            this.runtime.character.name + " stfu",
            "chill" + this.runtime.character.name,
            this.runtime.character.name + " chill",
        ];

        // lose interest if pinged and told to stop responding
        if (targetedPhrases.some((phrase) => messageContent.includes(phrase))) {
            delete this.interestChannels[message.channelId];
            return true;
        }

        // if the message is short, ignore but maintain interest
        if (
            !this.interestChannels[message.channelId] &&
            messageContent.length < MESSAGE_LENGTH_THRESHOLDS.VERY_SHORT_MESSAGE
        ) {
            return true;
        }

        if (
            message.content.length <
                MESSAGE_LENGTH_THRESHOLDS.IGNORE_RESPONSE &&
            IGNORE_RESPONSE_WORDS.some((word) =>
                message.content.toLowerCase().includes(word)
            )
        ) {
            return true;
        }
        return false;
    }

    private async _shouldRespond(message: DiscordMessage, state: State): Promise<boolean> {
        if (message.author.id === this.client.user?.id) return false;

        // Honor mentions-only mode
        if (this.runtime.character.clientConfig?.discord?.shouldRespondOnlyToMentions) {
            return this._isMessageForMe(message);
        }

        const channelState = this.interestChannels[message.channelId];

        // Check if team member has direct interest first
        if (
            this.runtime.character.clientConfig?.discord?.isPartOfTeam &&
            !this._isTeamLeader() &&
            this._isRelevantToTeamMember(message.content, message.channelId)
        ) {
            return true;
        }

        try {
            // Team-based response logic
            if (this.runtime.character.clientConfig?.discord?.isPartOfTeam) {
                // Team leader coordination
                if (
                    this._isTeamLeader() &&
                    this._isTeamCoordinationRequest(message.content)
                ) {
                    return true;
                }

                if (
                    !this._isTeamLeader() &&
                    this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    // Add small delay for non-leader responses
                    await new Promise((resolve) =>
                        setTimeout(resolve, TIMING_CONSTANTS.TEAM_MEMBER_DELAY)
                    ); //1.5 second delay

                    // If leader has responded in last few seconds, reduce chance of responding

                    if (channelState?.messages?.length) {
                        const recentMessages = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const leaderResponded = recentMessages.some(
                            (m) =>
                                m.userId ===
                                    this.runtime.character.clientConfig?.discord
                                        ?.teamLeaderId &&
                                Date.now() - channelState.lastMessageSent < 3000
                        );

                        if (leaderResponded) {
                            // 50% chance to respond if leader just did
                            return (
                                Math.random() > RESPONSE_CHANCES.AFTER_LEADER
                            );
                        }
                    }

                    return true;
                }

                // If I'm the leader but message doesn't match my keywords, add delay and check for team responses
                if (
                    this._isTeamLeader() &&
                    !this._isRelevantToTeamMember(
                        message.content,
                        message.channelId
                    )
                ) {
                    const randomDelay =
                        Math.floor(
                            Math.random() *
                                (TIMING_CONSTANTS.LEADER_DELAY_MAX -
                                    TIMING_CONSTANTS.LEADER_DELAY_MIN)
                        ) + TIMING_CONSTANTS.LEADER_DELAY_MIN; // 2-4 second random delay
                    await new Promise((resolve) =>
                        setTimeout(resolve, randomDelay)
                    );

                    // After delay, check if another team member has already responded
                    if (channelState?.messages?.length) {
                        const recentResponses = channelState.messages.slice(
                            -MESSAGE_CONSTANTS.RECENT_MESSAGE_COUNT
                        );
                        const otherTeamMemberResponded = recentResponses.some(
                            (m) =>
                                m.userId !== this.client.user?.id &&
                                this._isTeamMember(m.userId)
                        );

                        if (otherTeamMemberResponded) {
                            return false;
                        }
                    }
                }

                // Update current handler if we're mentioned
                if (this._isMessageForMe(message)) {
                    const channelState =
                        this.interestChannels[message.channelId];
                    if (channelState) {
                        channelState.currentHandler = this.client.user?.id;
                        channelState.lastMessageSent = Date.now();
                    }
                    return true;
                }

                // Don't respond if another teammate is handling the conversation
                if (channelState?.currentHandler) {
                    if (
                        channelState.currentHandler !== this.client.user?.id &&
                        this._isTeamMember(channelState.currentHandler)
                    ) {
                        return false;
                    }
                }

                // Natural conversation cadence
                if (!this._isMessageForMe(message) && channelState) {
                    // Count our recent messages
                    const recentMessages = channelState.messages.slice(
                        -MESSAGE_CONSTANTS.CHAT_HISTORY_COUNT
                    );
                    const ourMessageCount = recentMessages.filter(
                        (m) => m.userId === this.client.user?.id
                    ).length;

                    // Reduce responses if we've been talking a lot
                    if (ourMessageCount > 2) {
                        // Exponentially decrease chance to respond
                        const responseChance = Math.pow(
                            0.5,
                            ourMessageCount - 2
                        );
                        if (Math.random() > responseChance) {
                            return false;
                        }
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error in _shouldRespond team processing:", {
                error,
                agentId: this.runtime.agentId,
                channelId: message.channelId,
            });
        }

        // Context and conversation flow checks
        if (channelState?.previousContext) {
            const shouldRespondContext =
                await this._shouldRespondBasedOnContext(message, channelState);
            if (!shouldRespondContext) {
                delete this.interestChannels[message.channelId];
                return false;
            }
        }

        // Direct mentions or name references
        if (message.mentions.has(this.client.user?.id as string)) return true;

        const guild = message.guild;
        const member = guild?.members.cache.get(this.client.user?.id as string);
        const nickname = member?.nickname;

        if (
            message.content
                .toLowerCase()
                .includes(this.client.user?.username.toLowerCase() as string) ||
            message.content
                .toLowerCase()
                .includes(this.client.user?.tag.toLowerCase() as string) ||
            (nickname &&
                message.content.toLowerCase().includes(nickname.toLowerCase()))
        ) {
            return true;
        }

        if (!message.guild) {
            return true;
        }

        // If none of the above conditions are met, use the LLM to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.discordShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                composeRandomUser(discordShouldRespondTemplate, 2),
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (response === "RESPOND") {
            if (channelState) {
                channelState.previousContext = {
                    content: message.content,
                    timestamp: Date.now(),
                };
            }
            return true;
        } else if (response === "IGNORE") {
            return false;
        } else if (response === "STOP") {
            delete this.interestChannels[message.channelId];
            return false;
        } else {
            elizaLogger.error("Invalid response from generateShouldRespond:", response);
            return false;
        }
    }

    private async _generateResponse(
        memory: Memory,
        state: State,
        context: string
    ): Promise<Content> {
        try {
            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            if (!response) {
                elizaLogger.error("No response from generateMessageResponse");
                return {
                    text: "I apologize, but I'm having trouble generating a response right now.",
                    source: "discord"
                };
            }

            // Just pass through the response with source
            const responseContent: Content = {
                ...response,
                source: "discord"
            };

            await this.runtime.databaseAdapter.log({
                body: { message: memory, context, response: responseContent },
                userId: memory.userId,
                roomId: memory.roomId,
                type: "response",
            });

            return responseContent;
        } catch (error) {
            elizaLogger.error("Error in _generateResponse:", error);
            return {
                text: "I apologize, but I encountered an error while trying to respond.",
                source: "discord"
            };
        }
    }

    async fetchBotName(botToken: string) {
        const url = "https://discord.com/api/v10/users/@me";

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bot ${botToken}`,
            },
        });

        if (!response.ok) {
            throw new Error(
                `Error fetching bot details: ${response.statusText}`
            );
        }

        const data = await response.json();
        return data.username;
    }

    /**
     * Simulate discord typing while generating a response;
     * returns a function to interrupt the typing loop
     *
     * @param message
     */
    private simulateTyping(message: DiscordMessage) {
        let typing = true;

        const typingLoop = async () => {
            while (typing) {
                if ('sendTyping' in message.channel) {
                    await message.channel.sendTyping();
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        };

        typingLoop();

        return function stopTyping() {
            typing = false;
        };
    }

    async handleReaction(reaction: MessageReaction, user: User, added: boolean) {
        try {
            // Skip if the user is a bot
            if (user.bot) return;

            // Only handle thumbs up/down reactions
            const emoji = reaction.emoji.name;
            if (!emoji || (emoji !== '👍' && emoji !== '👎')) return;

            // Get the proposal shortId from the message
            const message = reaction.message;
            const shortIdMatch = message.content?.match(/#([a-zA-Z0-9]{6})/);
            if (!shortIdMatch) return;

            const shortId = shortIdMatch[1];
            const isYesVote = emoji === '👍';

            // Create vote content
            const voteContent = {
                type: "vote_cast",
                id: stringToUuid(`vote-${shortId}-${user.id}-${Date.now()}`),
                text: `Vote cast: ${isYesVote ? "yes" : "no"} for proposal ${shortId}`,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "pending_execution",
                proposalId: shortId,
                vote: isYesVote ? "yes" : "no",
                metadata: {
                    proposalId: shortId,
                    vote: isYesVote ? "yes" : "no",
                    votingPower: 1,
                    timestamp: Date.now()
                }
            };

            // Create a simplified MessageReaction object for the ProposalAgent
            const simplifiedReaction = {
                message: {
                    id: message.id,
                    reactions: {
                        cache: {
                            find: (predicate: (r: any) => boolean) => reaction
                        }
                    }
                },
                emoji: reaction.emoji
            };

            // Send vote event to the agent
            await this.proposalAgent.handleReaction(
                simplifiedReaction as any,
                user,
                added
            );

        } catch (error) {
            elizaLogger.error("Error in MessageManager.handleReaction:", error);
        }
    }
}
