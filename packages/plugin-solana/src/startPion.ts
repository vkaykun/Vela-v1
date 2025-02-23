// packages/plugin-solana/src/startPion.ts

import { elizaLogger, AgentRuntime, ModelProviderName, stringToUuid, IMemoryManager } from "@elizaos/core";
import { DiscordClientInterface } from '@elizaos/client-discord';
import { DirectClientInterface } from '@elizaos/client-direct';
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig.ts";
import { getProcessDatabase } from "./shared/database.ts";
import { AGENT_IDS } from './shared/constants.ts';
import { MemorySyncManager } from './shared/memory/MemorySyncManager.ts';
import { MessageBroker } from './shared/MessageBroker.ts';
import { IAgentRuntime } from './shared/types/base.ts';
import { createSolanaRuntime, ExtendedMemoryManager } from './shared/utils/runtime.ts';
import { MemoryManager } from './shared/memory/index.ts';
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PostgresDatabaseAdapter } from '@elizaos/adapter-postgres';
import { IDatabaseAdapter } from '@elizaos/core';
import { UUID } from '@elizaos/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
// First load main .env from repo root
dotenv.config({ path: path.join(__dirname, "../../../.env") });
elizaLogger.info("Loaded main .env file");

// Log state after main .env
elizaLogger.info("Environment after main .env:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

// Then load Pion-specific environment variables
const pionEnvPath = path.join(__dirname, "..", ".env.pion");
elizaLogger.info("Loading .env.pion from:", pionEnvPath);
elizaLogger.info("File exists check:", fs.existsSync(pionEnvPath));
const pionEnvResult = dotenv.config({ path: pionEnvPath, override: true });
elizaLogger.info("Pion env loading result:", {
    error: pionEnvResult.error?.message,
    parsed: pionEnvResult.parsed ? Object.keys(pionEnvResult.parsed) : null
});

// Log final state to verify both sets loaded
elizaLogger.info("Final environment state:", {
    // Discord vars from .env.pion
    DISCORD_TOKEN: process.env.DISCORD_API_TOKEN ? "Present" : "Missing",
    DISCORD_APP_ID: process.env.DISCORD_APPLICATION_ID ? "Present" : "Missing",
    // Solana vars from main .env
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

if (pionEnvResult.error) {
    elizaLogger.error("Error loading .env.pion:", pionEnvResult.error);
} else {
    elizaLogger.info("Successfully loaded .env.pion");
}

// Log all environment variable keys
elizaLogger.info("All available environment variables:", {
    keys: Object.keys(process.env),
    discordRelated: Object.keys(process.env).filter(key => key.toLowerCase().includes('discord'))
});

elizaLogger.info("Environment variables after loading:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    BASE_MINT: process.env.BASE_MINT,
    NODE_ENV: process.env.NODE_ENV
});

// Add global unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
    elizaLogger.error('Unhandled Rejection at:', {
        promise,
        reason: reason instanceof Error ? {
            message: reason.message,
            stack: reason.stack,
            name: reason.name
        } : reason
    });
});

async function startPion() {
    try {
        elizaLogger.info("Starting Pion initialization...");
        
        // 1. Parse and validate database config
        elizaLogger.info("Parsing database config...");
        const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
        elizaLogger.info("Database config parsed successfully");
        
        // Initialize memory sync manager early
        elizaLogger.info("Initializing memory sync manager...");
        const memorySyncManager = MemorySyncManager.getInstance();
        memorySyncManager.onMemorySynced(async (memory) => {
            elizaLogger.debug('Memory synced:', memory.id);
        });
        elizaLogger.info("Memory sync manager initialized");

        let db;
        try {
            // Initialize the database with PostgreSQL configuration
            elizaLogger.info("Initializing PostgreSQL adapter...");
            const postgresAdapter = new PostgresDatabaseAdapter({
                connectionString: dbConfig.url,
                max: 20
            });

            // Add transaction methods
            const adapterWithTransactions = Object.assign(postgresAdapter, {
                beginTransaction: async function() {
                    return this.query('BEGIN');
                },
                commitTransaction: async function() {
                    return this.query('COMMIT');
                },
                rollbackTransaction: async function() {
                    return this.query('ROLLBACK');
                }
            });

            let adapter = adapterWithTransactions as unknown as IDatabaseAdapter;
            elizaLogger.info("PostgreSQL adapter initialized successfully");

            db = await getProcessDatabase({
                messageManager: {
                    // Provide a minimal implementation that will be replaced
                    onMemoryCreated: () => {},
                    onMemoryUpdated: () => {},
                    onMemoryDeleted: () => {},
                },
                adapter: adapter
            } as any, "pion");
            elizaLogger.info("Database initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize database:", {
                error: error instanceof Error ? error.message : error,
                stack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }

        // Create initial runtime for memory manager
        elizaLogger.info("Creating initial runtime...");
        const initRuntime = new AgentRuntime({
            agentId: stringToUuid("pion-temp"),
            token: process.env.OPENAI_API_KEY || "",
            modelProvider: ModelProviderName.OPENAI,
            databaseAdapter: db.adapter,
            cacheManager: db.adapter.getCacheManager ? db.adapter.getCacheManager() : db.adapter
        });
        elizaLogger.info("Initial runtime created");

        // Create memory manager instance
        elizaLogger.info("Creating memory manager...");
        class ExtendedBaseMemoryManager extends MemoryManager {
            private _transactionLevel: number = 0;

            async getMemoriesWithLock(query: any) {
                return this.getMemories(query);
            }

            async getMemoryWithLock(id: UUID) {
                return this.getMemory(id);
            }

            get isInTransaction(): boolean {
                return this._transactionLevel > 0;
            }

            getTransactionLevel(): number {
                return this._transactionLevel;
            }

            async beginTransaction(): Promise<void> {
                this._transactionLevel++;
            }

            async commitTransaction(): Promise<void> {
                this._transactionLevel = Math.max(0, this._transactionLevel - 1);
            }

            async rollbackTransaction(): Promise<void> {
                this._transactionLevel = Math.max(0, this._transactionLevel - 1);
            }

            async removeMemoriesWhere(condition: any) {
                elizaLogger.warn('removeMemoriesWhere not fully implemented in base manager');
                return Promise.resolve();
            }
        }

        const memoryManager = new ExtendedBaseMemoryManager({
            runtime: initRuntime,
            tableName: "messages",
            adapter: db.adapter
        });

        await memoryManager.initialize();
        elizaLogger.info("Memory manager initialized");

        // Create extended memory manager
        elizaLogger.info("Creating extended memory manager...");
        const extendedMemoryManager = new ExtendedMemoryManager(
            memoryManager,
            new Map()
        );
        await extendedMemoryManager.initialize();
        elizaLogger.info("Extended memory manager created");

        // 2. Load the Pion character file
        elizaLogger.info("Loading Pion character file...");
        const pionCharacterPath = path.join(__dirname, "../../../characters/pion.character.json");
        
        // Check if character file exists
        if (!fs.existsSync(pionCharacterPath)) {
            throw new Error(`Character file not found at: ${pionCharacterPath}. Please ensure the file exists.`);
        }

        let pionCharacter;
        try {
            const characterContent = fs.readFileSync(pionCharacterPath, "utf-8");
            pionCharacter = JSON.parse(characterContent);
            elizaLogger.info("Pion character file loaded successfully");
        } catch (error) {
            elizaLogger.error("Failed to load character file:", error);
            throw new Error(`Failed to load character file: ${error.message}`);
        }

        if (!pionCharacter || typeof pionCharacter !== 'object') {
            throw new Error('Invalid character file format. Expected a JSON object.');
        }

        // 3. Create an AgentRuntime (single process mode)
        elizaLogger.info("Creating agent runtime...");
        const isMultiProcess = process.env.MULTI_PROCESS === "true";
        const plugins = pionCharacter.plugins || [];

        const runtimeConfig = {
            agentId: AGENT_IDS.PROPOSAL,
            character: {
                ...pionCharacter,
                agentConfig: {
                    ...pionCharacter.agentConfig,
                    type: "PROPOSAL"
                },
                settings: {
                    ...pionCharacter.settings,
                    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                    proposalQuorum: process.env.PROPOSAL_QUORUM,
                    proposalMinimumYesVotes: process.env.PROPOSAL_MINIMUM_YES_VOTES,
                    proposalMinimumVotePercentage: process.env.PROPOSAL_MINIMUM_VOTE_PERCENTAGE,
                    maxProposalsPerUser: process.env.MAX_PROPOSALS_PER_USER,
                    proposalExpiryDays: process.env.PROPOSAL_EXPIRY_DAYS
                }
            },
            token: process.env.OPENAI_API_KEY || "",
            modelProvider: ModelProviderName.OPENAI,
            databaseAdapter: db.adapter,
            cacheManager: db.adapter.getCacheManager ? db.adapter.getCacheManager() : db.adapter,
            multiProcess: isMultiProcess,
            plugins: plugins,
            messageManager: extendedMemoryManager,
            descriptionManager: extendedMemoryManager,
            documentsManager: extendedMemoryManager,
            knowledgeManager: extendedMemoryManager,
            loreManager: extendedMemoryManager
        };

        // Create and initialize the runtime
        elizaLogger.info("Creating agent runtime...");
        const runtime = new AgentRuntime(runtimeConfig);
        await runtime.initialize();
        elizaLogger.info("Runtime initialized");

        // Create Solana runtime wrapper with explicit agent type
        elizaLogger.info("Creating Solana runtime...");
        const solanaRuntime = await createSolanaRuntime({
            ...runtimeConfig,
            character: {
                ...runtimeConfig.character,
                agentConfig: {
                    ...runtimeConfig.character.agentConfig,
                    type: "PROPOSAL"
                }
            },
            // Ensure all memory managers are ExtendedMemoryManager instances
            messageManager: {
                ...extendedMemoryManager,
                subscribeToMemory: extendedMemoryManager.subscribe.bind(extendedMemoryManager),
                unsubscribeFromMemory: extendedMemoryManager.unsubscribe.bind(extendedMemoryManager),
                updateMemory: extendedMemoryManager.createMemory.bind(extendedMemoryManager)
            },
            descriptionManager: extendedMemoryManager,
            documentsManager: extendedMemoryManager,
            knowledgeManager: extendedMemoryManager,
            loreManager: extendedMemoryManager
        });
        elizaLogger.info("Solana runtime created");

        // Initialize clients object
        solanaRuntime.clients = {};

        // 4. Set up clients
        elizaLogger.info("Setting up clients...");
        elizaLogger.info("Discord token check:", {
            tokenExists: !!process.env.DISCORD_API_TOKEN,
            tokenLength: process.env.DISCORD_API_TOKEN?.length,
            applicationId: process.env.DISCORD_APPLICATION_ID,
            envPionPath: pionEnvPath
        });
        if (process.env.DISCORD_API_TOKEN) {
            try {
                elizaLogger.info("Starting Discord client with token:", process.env.DISCORD_API_TOKEN?.substring(0, 10) + "...");
                elizaLogger.info("Discord Application ID:", process.env.DISCORD_APPLICATION_ID);
                
                // Create a minimal runtime for Discord that doesn't include the OpenAI token
                const discordRuntime: IAgentRuntime = {
                    ...solanaRuntime,
                    // Use OpenAI API key for model operations, Discord token for Discord operations
                    token: process.env.OPENAI_API_KEY || "", // Keep OpenAI token for model operations
                    discordToken: process.env.DISCORD_API_TOKEN, // Add Discord token separately
                    // Keep modelProvider but remove other OpenAI-specific properties
                    imageModelProvider: undefined,
                    imageVisionModelProvider: undefined,
                    // Keep necessary properties
                    agentId: solanaRuntime.agentId,
                    agentType: solanaRuntime.agentType,
                    modelProvider: solanaRuntime.modelProvider, // Keep the model provider
                    databaseAdapter: solanaRuntime.databaseAdapter,
                    messageManager: {
                        ...solanaRuntime.messageManager,
                        subscribeToMemory: solanaRuntime.messageManager.subscribe.bind(solanaRuntime.messageManager),
                        unsubscribeFromMemory: solanaRuntime.messageManager.unsubscribe.bind(solanaRuntime.messageManager),
                        updateMemory: solanaRuntime.messageManager.createMemory.bind(solanaRuntime.messageManager)
                    },
                    character: solanaRuntime.character,
                    getSetting: (key: string) => {
                        if (key === "DISCORD_API_TOKEN") return process.env.DISCORD_API_TOKEN;
                        if (key === "DISCORD_APPLICATION_ID") return process.env.DISCORD_APPLICATION_ID;
                        if (key === "OPENAI_API_KEY") return process.env.OPENAI_API_KEY;
                        return solanaRuntime.getSetting(key);
                    }
                };
                
                const discordClient = await DiscordClientInterface.start(discordRuntime);
                solanaRuntime.clients.discord = discordClient;
                elizaLogger.info("Discord client started successfully");
            } catch (error) {
                elizaLogger.error("Failed to start Discord client:", {
                    error: error instanceof Error ? {
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    } : error,
                    token: process.env.DISCORD_API_TOKEN ? "Present" : "Missing",
                    applicationId: process.env.DISCORD_APPLICATION_ID ? "Present" : "Missing"
                });
                throw error;
            }
        } else {
            elizaLogger.warn("No Discord token provided, skipping Discord client initialization");
        }
        const directClient = await DirectClientInterface.start(solanaRuntime);
        solanaRuntime.clients.direct = directClient;
        elizaLogger.info("Direct client started");

        // 5. Start the Pion agent
        elizaLogger.info("Starting Pion agent...");
        try {
            const { ProposalAgent } = await import("./agents/proposal/ProposalAgent");
            const pionAgent = new ProposalAgent(solanaRuntime);
            await pionAgent.initialize();
            elizaLogger.info("Pion agent initialized");
        } catch (error) {
            elizaLogger.error("Error creating or initializing Pion agent:", {
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
            throw new Error(`Failed to initialize Pion agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        elizaLogger.info(`Pion agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
            databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
            maxConnections: dbConfig.maxConnections || 1,
            clients: process.env.DISCORD_API_TOKEN ? ['Discord', 'Direct'] : ['Direct'],
            memorySync: 'enabled'
        });
    } catch (error) {
        elizaLogger.error("Error in startPion:", {
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
        throw new Error(`Failed to start Pion: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Run
startPion().catch((error) => {
    elizaLogger.error("Failed to start Pion:", {
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
    process.exit(1);
}); 