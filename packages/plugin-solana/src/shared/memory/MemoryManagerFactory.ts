import { IMemoryManager, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { PostgresMemoryManager } from "./PostgresMemoryManager.ts";
import { SQLiteMemoryManager } from "./SQLiteMemoryManager.ts";

export interface MemoryConfig {
    // Database-specific settings
    database: {
        type: "postgres" | "sqlite";
        connectionString: string;
        maxConnections?: number;
        idleTimeoutMillis?: number;
        ssl?: boolean;
    };
    tableName?: string;
    useEmbeddings?: boolean;
}

/**
 * Factory for creating unified memory managers
 */
export class MemoryManagerFactory {
    private static instance: IMemoryManager;

    /**
     * Get or create the singleton memory manager instance
     */
    public static async getInstance(runtime: IAgentRuntime, config: MemoryConfig): Promise<IMemoryManager> {
        if (!this.instance) {
            this.instance = await this.createManager(runtime, config);
        }
        return this.instance;
    }

    private static async createManager(runtime: IAgentRuntime, config: MemoryConfig): Promise<IMemoryManager> {
        const { database, tableName = "memories", useEmbeddings = false } = config;

        // Create the appropriate database-specific manager
        const dbManager = database.type === "postgres" 
            ? new PostgresMemoryManager(runtime, {
                connectionString: database.connectionString,
                maxConnections: database.maxConnections,
                idleTimeoutMillis: database.idleTimeoutMillis,
                ssl: database.ssl
            })
            : new SQLiteMemoryManager(database.connectionString, runtime, tableName);

        // Initialize the database manager
        await dbManager.initialize();

        // Return the specialized manager directly
        return dbManager;
    }
}

/**
 * Helper to get the appropriate memory manager for an agent
 */
export async function getMemoryManager(runtime: IAgentRuntime, config?: Partial<MemoryConfig>): Promise<IMemoryManager> {
    const dbType = process.env.DATABASE_TYPE || "sqlite";
    const defaultConfig: MemoryConfig = {
        database: {
            type: dbType as "postgres" | "sqlite",
            connectionString: process.env.DATABASE_URL || 
                (dbType === "postgres" 
                    ? "postgresql://localhost:5432/dao"
                    : "sqlite://data/dao.db"),
            maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || "50"),
            idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || "30000"),
            ssl: process.env.DATABASE_SSL === "true"
        },
        useEmbeddings: process.env.USE_EMBEDDINGS === "true"
    };

    const mergedConfig = { ...defaultConfig, ...config };
    return MemoryManagerFactory.getInstance(runtime, mergedConfig);
} 