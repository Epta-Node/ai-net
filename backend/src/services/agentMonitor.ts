import { eventBus } from '../coordinator/eventBus';
import type { AgentRegistration, AgentRegistry } from '../types/agent';
import { createLogger } from '../utils/logger';
import type pino from 'pino';

export interface AgentMonitorOptions {
  agentRegistry: AgentRegistry;
  intervalMs?: number;
  failureThreshold?: number;
  eventBus?: typeof eventBus;
  logger?: pino.Logger;
  fetchImpl?: typeof fetch;
}

export class AgentMonitorService {
  private readonly registry: AgentRegistry;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly bus: typeof eventBus;
  private readonly log: pino.Logger;
  private readonly fetchImpl: typeof fetch;

  private timer: NodeJS.Timeout | null = null;
  private readonly failureCounts: Map<string, number> = new Map();
  private stopped = true;

  constructor(options: AgentMonitorOptions) {
    this.registry = options.agentRegistry;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.bus = options.eventBus ?? eventBus;
    this.log = options.logger ?? createLogger({ component: 'agent-monitor' });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.checkAllAgents().catch((err) => {
        this.log.error({ err }, 'Error checking agent health');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopped = true;
  }

  async checkAllAgents(): Promise<void> {
    let agents: AgentRegistration[] = [];
    try {
      const res = await this.registry.getAgents();
      agents = Array.isArray(res) ? res : [];
    } catch (err) {
      this.log.error({ err }, 'Failed to fetch registered agents from registry');
      return;
    }

    for (const agent of agents) {
      await this.checkAgentHealth(agent);
    }
  }

  async checkAgentHealth(agent: AgentRegistration): Promise<boolean> {
    const isHealthy = await this.pingAgent(agent);
    const agentId = agent.id;
    const currentFailures = this.failureCounts.get(agentId) ?? 0;

    if (isHealthy) {
      this.failureCounts.set(agentId, 0);
      if (agent.status === 'offline') {
        agent.status = 'online';
        if (typeof this.registry.markOnline === 'function') {
          await this.registry.markOnline(agentId);
        } else if (typeof this.registry.registerAgent === 'function') {
          await this.registry.registerAgent(agent);
        }
        const timestamp = new Date().toISOString();
        this.bus.emit('system', {
          type: 'AgentRecovered',
          taskId: 'system',
          timestamp,
          payload: { agentId, status: 'online' },
        });
        this.log.info({ agentId }, 'Agent recovered and marked online');
      }
      return true;
    } else {
      const newFailures = currentFailures + 1;
      this.failureCounts.set(agentId, newFailures);

      this.log.warn({ agentId, consecutiveFailures: newFailures }, 'Agent failed health check');

      if (newFailures >= this.failureThreshold && agent.status !== 'offline') {
        agent.status = 'offline';
        if (typeof this.registry.markOffline === 'function') {
          await this.registry.markOffline(agentId);
        } else if (typeof this.registry.registerAgent === 'function') {
          await this.registry.registerAgent(agent);
        }
        const timestamp = new Date().toISOString();
        const correlationId = `failover-${agentId}-${Date.now()}`;
        this.bus.emit('system', {
          type: 'AgentMarkedOffline',
          taskId: 'system',
          timestamp,
          payload: { agentId, consecutiveFailures: newFailures, status: 'offline', correlationId },
        });
        this.log.warn({ agentId, correlationId, consecutiveFailures: newFailures }, 'Agent marked offline after 3 consecutive failed health checks');
      }
      return false;
    }
  }

  private async pingAgent(agent: AgentRegistration): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const url = `${agent.endpoint.replace(/\/$/, '')}/health`;
      const response = await this.fetchImpl(url, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  getFailureCount(agentId: string): number {
    return this.failureCounts.get(agentId) ?? 0;
  }
}
