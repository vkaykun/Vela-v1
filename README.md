# Vela-v1

A distributed multi-agent system for autonomous DAO operations on Solana, featuring specialized agents for treasury management, autonomous trading, strategy execution, coupled with a reputation-based governance framework for proposal creation, voting, and automated agentic execution of passed proposals.

## Memory Architecture

* Universal memory space with typed content and room-based partitioning
* "Global DAO Rooms" for shared state between agents
* Cross-process memory convergence via MemorySyncManager
* Transaction-based state transitions with ACID guarantees
* Multi-agent system with room-based memory isolation (global DAO vs domain-specific, e.g. treasury, strategy, proposal)

## Synchronization Layer and Inter-Agent Communication

* Event-driven memory propagation across distributed processes (MessageBroker.on("memory_created"))
* Atomic operations (MemoryManager.addEmbeddingToMemory)
* Process-level memory TTL
* Message broker implementing pub/sub memory events
* Extended runtime interfaces with event binding (IAgentRuntime extends CoreAgentRuntime)

## State Machines

### Memory
```bash
EPHEMERAL → PERSISTENT → ARCHIVED
```

### Content
```bash
DRAFT → PENDING → EXECUTED | FAILED
```

### Process
```bash
INIT → ACTIVE → MONITORING → TERMINATED
```

## Implementation

### Core Dependencies

* Node.js 23.3.0
* PostgreSQL
* Solana CLI
* pnpm 9.15.0

### Runtime Configuration

```bash
# Agent-specific environment initialization for specialized agents
cp packages/plugin-solana/.env.example packages/plugin-solana/.env.[agent]

# DB initialization
createdb dao_dev
pnpm run migrate
```

### Process Initialization

```bash
# Distributed process startup across multiple agents
pnpm run start:vela
pnpm run start:kron
pnpm run start:pion
```

### Development Operations

```bash
pnpm build         
pnpm test            
pnpm run migrate:up    
```

## License

MIT 