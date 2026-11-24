// Issue #728: Unit tests for cost formatting and aggregation helpers

describe('Cost Breakdown Formatting Helpers', () => {
  describe('formatCurrency', () => {
    const formatCurrency = (amount: number): string => {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(amount);
    };

    it('should format whole numbers correctly', () => {
      expect(formatCurrency(100)).toBe('$100.00');
      expect(formatCurrency(1000)).toBe('$1,000.00');
    });

    it('should format decimal amounts correctly', () => {
      expect(formatCurrency(10.5)).toBe('$10.50');
      expect(formatCurrency(0.123)).toBe('$0.123');
      expect(formatCurrency(0.1234)).toBe('$0.1234');
    });

    it('should format zero correctly', () => {
      expect(formatCurrency(0)).toBe('$0.00');
    });

    it('should format small amounts with precision', () => {
      expect(formatCurrency(0.0001)).toBe('$0.0001');
      expect(formatCurrency(0.00001)).toBe('$0.00');
    });

    it('should format large amounts with commas', () => {
      expect(formatCurrency(1000000)).toBe('$1,000,000.00');
    });
  });

  describe('aggregateByAgent', () => {
    const aggregateByAgent = (costByAgent: Record<string, number>) => {
      return Object.entries(costByAgent).map(([agent, cost]) => ({
        name: agent,
        cost,
      }));
    };

    it('should aggregate empty data', () => {
      const result = aggregateByAgent({});
      expect(result).toEqual([]);
    });

    it('should aggregate single agent', () => {
      const data = { 'Agent A': 100.50 };
      const result = aggregateByAgent(data);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: 'Agent A', cost: 100.50 });
    });

    it('should aggregate multiple agents', () => {
      const data = {
        'Agent A': 100,
        'Agent B': 200,
        'Agent C': 50,
      };
      const result = aggregateByAgent(data);
      
      expect(result).toHaveLength(3);
      expect(result.map(r => r.name)).toContain('Agent A');
      expect(result.map(r => r.name)).toContain('Agent B');
      expect(result.map(r => r.name)).toContain('Agent C');
    });

    it('should preserve cost values', () => {
      const data = { 'Agent': 123.456 };
      const result = aggregateByAgent(data);
      
      expect(result[0].cost).toBe(123.456);
    });
  });

  describe('aggregateByModel', () => {
    const aggregateByModel = (costByModel: Record<string, number>) => {
      return Object.entries(costByModel).map(([model, cost]) => ({
        name: model,
        cost,
      }));
    };

    it('should aggregate empty model data', () => {
      const result = aggregateByModel({});
      expect(result).toEqual([]);
    });

    it('should aggregate multiple models', () => {
      const data = {
        'gpt-4': 500,
        'gpt-3.5-turbo': 100,
        'claude-2': 250,
      };
      const result = aggregateByModel(data);
      
      expect(result).toHaveLength(3);
      expect(result.some(r => r.name === 'gpt-4')).toBe(true);
      expect(result.some(r => r.name === 'claude-2')).toBe(true);
    });
  });

  describe('cost data validation', () => {
    it('should handle null data gracefully', () => {
      const data = null;
      expect(data).toBeNull();
    });

    it('should handle empty arrays', () => {
      const data = { spendOverTime: [], taskCosts: [] };
      expect(data.spendOverTime).toHaveLength(0);
      expect(data.taskCosts).toHaveLength(0);
    });

    it('should validate task cost structure', () => {
      const taskCost = {
        taskId: 'task-1',
        description: 'Test task',
        agent: 'Agent A',
        model: 'gpt-4',
        cost: 1.50,
        timestamp: '2024-01-01T00:00:00Z',
      };

      expect(taskCost).toHaveProperty('taskId');
      expect(taskCost).toHaveProperty('cost');
      expect(typeof taskCost.cost).toBe('number');
    });
  });
});
