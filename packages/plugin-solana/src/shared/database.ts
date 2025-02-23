import { elizaLogger, IMemoryManager, IDatabaseAdapter, ICacheManager, IAgentRuntime, UUID, IDatabaseCacheAdapter, Service, ServiceType, CacheOptions } from "@elizaos/core";
import { MemoryManager } from "./memory/index.ts";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { ContentStatus } from "./types/base.ts";
import { TreasuryTransaction } from "./types/treasury.ts";
import { MemoryManagerFactory, MemoryConfig } from "./memory/MemoryManagerFactory.ts";
import path from 'path';
import fs from 'fs';
import pg from 'pg';
import { Database } from 'better-sqlite3';

export interface SharedDatabaseConfig {
    url: string;
    poolSize: number;
    ssl: boolean;
    schema?: string;
    maxConnections?: number;
    idleTimeoutMillis?: number;
    embeddingDimension: number;
}

export interface DatabaseConnection {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    query(sql: string, params?: any[]): Promise<any>;
    isConnected(): boolean;
}

export interface SharedDatabase {
    config: SharedDatabaseConfig;
    connection: DatabaseConnection;
    adapter: IDatabaseAdapter;
    managers: {
        message: IMemoryManager;
        description: IMemoryManager;
        documents: IMemoryManager;
        knowledge: IMemoryManager;
        lore: IMemoryManager;
    };
    cache: ICacheManager;
}

// Ensure single database instance across all agents
let sharedDatabase: SharedDatabase | null = null;

export const getSharedDatabaseConfig = (): SharedDatabaseConfig => {
    // Ensure consistent database URL across all processes
    const dbUrl = process.env.DATABASE_URL || process.env.SHARED_DATABASE_URL;
    if (!dbUrl) {
        throw new Error("DATABASE_URL or SHARED_DATABASE_URL must be set to ensure consistent database access across agents");
    }

    // In production, enforce Postgres
    if (process.env.NODE_ENV === 'production') {
        if (!dbUrl.startsWith('postgres://')) {
            throw new Error('Production environment requires PostgreSQL database. Please set DATABASE_URL to a valid Postgres connection string');
        }
        
        elizaLogger.info("Using production PostgreSQL database");
        return {
            url: dbUrl,
            poolSize: parseInt(process.env.DATABASE_POOL_SIZE || "20"),
            ssl: process.env.DATABASE_SSL === "true",
            schema: process.env.DATABASE_SCHEMA || "public",
            maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || "50"),
            idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || "30000"),
            embeddingDimension: 1536
        };
    }

    // Development mode - allow SQLite but warn about multi-process usage
    if (dbUrl.startsWith('sqlite://')) {
        const baseDir = path.join(process.cwd(), 'data');
        const sharedDbPath = path.join(baseDir, 'shared.db');
        
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        // Warn about multi-process SQLite usage
        if (process.env.MULTI_PROCESS === 'true') {
            elizaLogger.warn(`
                WARNING: Using SQLite in multi-process mode is not recommended for production.
                Consider switching to PostgreSQL by setting DATABASE_URL to a postgres:// connection string.
                Current configuration may lead to database locks and concurrency issues.
            `);
        }

        elizaLogger.info(`Using development SQLite database at: ${sharedDbPath}`);
        return {
            url: `sqlite://${sharedDbPath}`,
            poolSize: 1, // Limit pool size for SQLite
            ssl: false,
            schema: "public",
            maxConnections: 1, // Limit connections for SQLite
            idleTimeoutMillis: 30000,
            embeddingDimension: 1536
        };
    }

    // For Postgres in development
    if (dbUrl.startsWith('postgres://')) {
        elizaLogger.info("Using development PostgreSQL database");
        return {
            url: dbUrl,
            poolSize: parseInt(process.env.DATABASE_POOL_SIZE || "5"),
            ssl: process.env.DATABASE_SSL === "true",
            schema: process.env.DATABASE_SCHEMA || "public",
            maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || "10"),
            idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || "30000"),
            embeddingDimension: 1536
        };
    }

    throw new Error(`Unsupported database type in URL: ${dbUrl}`);
};

async function createDatabaseConnection(config: SharedDatabaseConfig): Promise<DatabaseConnection> {
    if (config.url.startsWith("sqlite://")) {
        const connection = new SQLiteConnection(config);
        // Enable WAL mode for better concurrency
        await connection.query('PRAGMA journal_mode = WAL');
        await connection.query('PRAGMA busy_timeout = 5000');
        return connection;
    } else if (config.url.startsWith("postgres://")) {
        const connection = new PostgresConnection(config);
        // Set isolation level for better concurrency handling
        await connection.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        return connection;
    }
    throw new Error(`Unsupported database type in URL: ${config.url}`);
}

export const getSharedDatabase = async (runtime: IAgentRuntime): Promise<SharedDatabase> => {
    if (!sharedDatabase) {
        try {
            const config = getSharedDatabaseConfig();
            const connection = await createDatabaseConnection(config);
            await connection.connect();

            // Validate connection
            const testQuery = 'SELECT 1';
            try {
                await connection.query(testQuery);
                elizaLogger.info(`Database connection validated for agent: ${runtime.agentId}`);
            } catch (error) {
                throw new Error(`Failed to validate database connection: ${error.message}`);
            }

            // Create database adapter based on connection type
            const adapter = (connection instanceof SQLiteConnection 
                ? new SqliteDatabaseAdapter(connection.getDatabase())
                : new PostgresDatabaseAdapter(connection)) as unknown as IDatabaseAdapter;

            // Initialize memory managers with shared adapter
            const managers = {
                message: new MemoryManager({ 
                    runtime,
                    tableName: "messages",
                    adapter
                }),
                description: new MemoryManager({
                    runtime,
                    tableName: "descriptions",
                    adapter
                }),
                documents: new MemoryManager({
                    runtime,
                    tableName: "documents",
                    adapter
                }),
                knowledge: new MemoryManager({
                    runtime,
                    tableName: "knowledge",
                    adapter
                }),
                lore: new MemoryManager({
                    runtime,
                    tableName: "lore",
                    adapter
                })
            };

            // Initialize cache manager
            const cache = {
                get: async <T>(key: string): Promise<T | null> => {
                    const result = await (adapter as any).getCache({ key, agentId: runtime.agentId });
                    return result ? JSON.parse(result) : null;
                },
                set: async <T>(key: string, value: T, options?: CacheOptions): Promise<void> => {
                    await (adapter as any).setCache({
                        key,
                        agentId: runtime.agentId,
                        value: JSON.stringify(value)
                    });
                },
                delete: async (key: string): Promise<void> => {
                    await (adapter as any).deleteCache({ key, agentId: runtime.agentId });
                }
            };

            sharedDatabase = {
                config,
                connection,
                adapter,
                managers: managers as unknown as {
                    message: IMemoryManager;
                    description: IMemoryManager;
                    documents: IMemoryManager;
                    knowledge: IMemoryManager;
                    lore: IMemoryManager;
                },
                cache
            };

            // Initialize database schema if needed
            await initializeDatabaseSchema(connection);

            elizaLogger.info("Shared database initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to initialize shared database:", error);
            throw error;
        }
    }
    return sharedDatabase;
};

async function initializeDatabaseSchema(connection: DatabaseConnection): Promise<void> {
    const config = getSharedDatabaseConfig();
    
    // First check if this is a Postgres connection
    if (connection instanceof PostgresConnection) {
        try {
            // Create required extensions
            await connection.query('CREATE EXTENSION IF NOT EXISTS vector');
            await connection.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch');
            
            // Create vector similarity function if it doesn't exist
            await connection.query(`
                CREATE OR REPLACE FUNCTION cosine_similarity(a vector, b vector) 
                RETURNS float 
                AS $$ 
                    SELECT a <=> b;
                $$ LANGUAGE SQL IMMUTABLE STRICT;
            `);
            
            elizaLogger.info("Required Postgres extensions and functions initialized successfully");
        } catch (error) {
            elizaLogger.error("Failed to create required Postgres extensions:", error);
            throw new Error(
                "Required Postgres extensions are missing. Please:\n" +
                "1. Install postgresql-contrib package\n" +
                "2. Run as superuser:\n" +
                "   CREATE EXTENSION vector;\n" +
                "   CREATE EXTENSION fuzzystrmatch;\n" +
                "Error: " + String(error)
            );
        }
    }

    // Common table schema with database-specific embedding column
    const getEmbeddingColumn = () => {
        if (connection instanceof PostgresConnection) {
            return `embedding vector(${config.embeddingDimension})`;
        }
        return 'embedding BLOB';
    };

    const schemas = [
        // Messages table with conditional vector column
        `CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY,
            content JSONB NOT NULL,
            room_id UUID NOT NULL,
            user_id UUID NOT NULL,
            agent_id UUID NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ${getEmbeddingColumn()}
        )`,
        // User profiles table
        `CREATE TABLE IF NOT EXISTS user_profiles (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL UNIQUE,
            content JSONB NOT NULL,
            wallet_addresses TEXT[] NOT NULL DEFAULT '{}',
            reputation INTEGER NOT NULL DEFAULT 0,
            voting_power INTEGER NOT NULL DEFAULT 1,
            roles TEXT[] NOT NULL DEFAULT '{}',
            total_deposits JSONB NOT NULL DEFAULT '[]',
            last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT valid_voting_power CHECK (voting_power >= 0)
        )`,
        // Vote delegation table
        `CREATE TABLE IF NOT EXISTS vote_delegations (
            id UUID PRIMARY KEY,
            delegator_id UUID NOT NULL,
            delegate_id UUID NOT NULL,
            voting_power INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            revoked_at TIMESTAMP,
            CONSTRAINT unique_active_delegation UNIQUE (delegator_id, delegate_id, revoked_at) 
            WHERE revoked_at IS NULL
        )`,
        // Voting history table
        `CREATE TABLE IF NOT EXISTS voting_history (
            id UUID PRIMARY KEY,
            proposal_id UUID NOT NULL,
            voter_id UUID NOT NULL,
            vote_type TEXT NOT NULL CHECK (vote_type IN ('yes', 'no')),
            voting_power INTEGER NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            metadata JSONB,
            CONSTRAINT unique_proposal_vote UNIQUE (proposal_id, voter_id)
        )`
    ];

    // Create tables
    for (const schema of schemas) {
        try {
            await connection.query(schema);
        } catch (error) {
            elizaLogger.error(`Failed to create schema: ${schema}`, error);
            throw error;
        }
    }

    // Create indexes
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_user_profiles_voting_power ON user_profiles(voting_power)',
        'CREATE INDEX IF NOT EXISTS idx_user_profiles_reputation ON user_profiles(reputation)',
        'CREATE INDEX IF NOT EXISTS idx_vote_delegations_active ON vote_delegations(delegator_id, delegate_id) WHERE revoked_at IS NULL',
        'CREATE INDEX IF NOT EXISTS idx_voting_history_proposal ON voting_history(proposal_id)',
        'CREATE INDEX IF NOT EXISTS idx_voting_history_voter ON voting_history(voter_id)',
        'CREATE INDEX IF NOT EXISTS idx_voting_history_timestamp ON voting_history(timestamp)'
    ];

    for (const index of indexes) {
        try {
            await connection.query(index);
        } catch (error) {
            elizaLogger.error(`Failed to create index: ${index}`, error);
            throw error;
        }
    }

    // Create database-specific embedding indexes
    if (connection instanceof PostgresConnection) {
        const embeddingIndexes = [
            'CREATE INDEX IF NOT EXISTS idx_messages_embedding ON messages USING ivfflat (embedding vector_cosine_ops)',
            'CREATE INDEX IF NOT EXISTS idx_descriptions_embedding ON descriptions USING ivfflat (embedding vector_cosine_ops)',
            'CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops)',
            'CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge USING ivfflat (embedding vector_cosine_ops)',
            'CREATE INDEX IF NOT EXISTS idx_lore_embedding ON lore USING ivfflat (embedding vector_cosine_ops)'
        ];

        for (const index of embeddingIndexes) {
            try {
                await connection.query(index);
            } catch (error) {
                elizaLogger.error(`Failed to create embedding index: ${index}`, error);
                throw error;
            }
        }
    } else {
        // For SQLite, register the cosine similarity function
        const db = (connection as SQLiteConnection).getDatabase();
        db.function('cosine_similarity', (a: Buffer, b: Buffer) => {
            const vecA = new Float64Array(a.buffer);
            const vecB = new Float64Array(b.buffer);
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            for (let i = 0; i < vecA.length; i++) {
                dotProduct += vecA[i] * vecB[i];
                normA += vecA[i] * vecA[i];
                normB += vecB[i] * vecB[i];
            }
            return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        });
    }

    elizaLogger.info("Database schema and constraints initialized successfully");
}

export const closeSharedDatabase = async (): Promise<void> => {
    if (sharedDatabase) {
        try {
            await sharedDatabase.connection.disconnect();
            sharedDatabase = null;
            elizaLogger.info("Shared database connection closed");
        } catch (error) {
            elizaLogger.error("Error closing shared database connection:", error);
            throw error;
        }
    }
};

// Add database-specific connection implementations
class SQLiteConnection implements DatabaseConnection {
    private db: any; // SQLite connection instance

    constructor(private config: SharedDatabaseConfig) {}

    async connect(): Promise<void> {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = this.config.url.replace('sqlite://', '');
        
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(dbPath, (err: Error) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    getDatabase(): any {
        return this.db;
    }

    async disconnect(): Promise<void> {
        if (this.db) {
            return new Promise((resolve, reject) => {
                this.db.close((err: Error) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    }

    async query(sql: string, params: any[] = []): Promise<any> {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err: Error, rows: any[]) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    isConnected(): boolean {
        return !!this.db;
    }
}

class PostgresConnection implements DatabaseConnection {
    private pool: any; // pg pool instance

    constructor(private config: SharedDatabaseConfig) {}

    async connect(): Promise<void> {
        const { Pool } = require('pg');
        this.pool = new Pool({
            connectionString: this.config.url,
            ssl: this.config.ssl,
            max: this.config.maxConnections,
            idleTimeoutMillis: this.config.idleTimeoutMillis
        });
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
        }
    }

    async query(sql: string, params: any[] = []): Promise<any> {
        const client = await this.pool.connect();
        try {
            const result = await client.query(sql, params);
            return result.rows;
        } finally {
            client.release();
        }
    }

    isConnected(): boolean {
        return !!this.pool;
    }
}

// Export database-specific adapter implementations
export { SqliteDatabaseAdapter } from '@elizaos/adapter-sqlite';
export { PostgresDatabaseAdapter } from '@elizaos/adapter-postgres';

// Map transaction status to content status
const statusMap: Record<string, ContentStatus> = {
    'pending': 'pending_execution',
    'processing': 'executing',
    'completed': 'executed',
    'failed': 'failed'
} as const;

export interface DatabaseConfig {
    adapter: IDatabaseAdapter;
    cache: ICacheManager;
}

/**
 * Get the process-specific database path
 */
function getProcessSpecificDbPath(processName: string): string {
    const baseDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }
    return path.join(baseDir, `${processName.toLowerCase()}.db`);
}

/**
 * Get the shared database path
 */
function getSharedDbPath(): string {
    const baseDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }
    return path.join(baseDir, 'shared.db');
}

/**
 * Initialize database connections for a specific process
 */
export async function getProcessDatabase(
    runtime: IAgentRuntime,
    processId: string
): Promise<DatabaseConfig> {
    const databaseType = process.env.DATABASE_TYPE || "sqlite";
    const databaseUrl = process.env.DATABASE_URL;

    elizaLogger.info(`Initializing database with type: ${databaseType}`);

    let adapter: IDatabaseAdapter;
    let cache: ICacheManager;

    try {
        if (databaseType === "postgres") {
            if (!databaseUrl) {
                throw new Error("DATABASE_URL environment variable is required for PostgreSQL");
            }

            elizaLogger.info("Initializing PostgreSQL adapter...");
            const postgresAdapter = new PostgresDatabaseAdapter({
                connectionString: databaseUrl,
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

            adapter = adapterWithTransactions as unknown as IDatabaseAdapter;
            await adapter.init();
            elizaLogger.info("PostgreSQL adapter initialized successfully");

            // Create a cache manager that implements ICacheManager
            cache = {
                get: async <T>(key: string): Promise<T | null> => {
                    const result = await (adapter as any).getCache({ key, agentId: runtime.agentId });
                    return result ? JSON.parse(result) : null;
                },
                set: async <T>(key: string, value: T, options?: CacheOptions): Promise<void> => {
                    await (adapter as any).setCache({
                        key,
                        agentId: runtime.agentId,
                        value: JSON.stringify(value)
                    });
                },
                delete: async (key: string): Promise<void> => {
                    await (adapter as any).deleteCache({ key, agentId: runtime.agentId });
                }
            };

        } else {
            elizaLogger.info("Initializing SQLite adapter...");
            const sqlite3 = require('better-sqlite3');
            const sqliteDb = new sqlite3(":memory:", {
                verbose: process.env.NODE_ENV === 'development' ? console.log : undefined
            });
            
            const sqliteAdapter = new SqliteDatabaseAdapter(sqliteDb);
            adapter = sqliteAdapter as unknown as IDatabaseAdapter;
            await adapter.init();
            elizaLogger.info("SQLite adapter initialized successfully");

            // Create in-memory cache for SQLite
            const memoryCache = new Map<string, any>();
            cache = {
                get: async <T>(key: string): Promise<T | null> => memoryCache.get(key) || null,
                set: async <T>(key: string, value: T, options?: CacheOptions): Promise<void> => {
                    memoryCache.set(key, value);
                },
                delete: async (key: string): Promise<void> => {
                    memoryCache.delete(key);
                }
            };
        }

        elizaLogger.info("Cache manager initialized successfully");

        return {
            adapter,
            cache,
        };
    } catch (error) {
        elizaLogger.error("Failed to initialize database:", {
            type: databaseType,
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
    }
}

/**
 * @deprecated Use getProcessDatabase instead
 */
export async function getLegacySharedDatabase(runtime: IAgentRuntime): Promise<DatabaseConfig> {
    elizaLogger.warn('getLegacySharedDatabase is deprecated - use getProcessDatabase instead');
    return getProcessDatabase(runtime, 'shared');
} 