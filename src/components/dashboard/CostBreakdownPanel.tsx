// Issue #728: Cost and payment breakdown panel for dashboard
// Displays spend over time, cost by agent/model, and per-task costs

import React, { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useTranslation } from 'react-i18next';

interface CostData {
  timestamp: string;
  amount: number;
  agent?: string;
  model?: string;
}

interface TaskCost {
  taskId: string;
  description: string;
  agent: string;
  model: string;
  cost: number;
  timestamp: string;
}

interface ApiCostResponse {
  spendOverTime: CostData[];
  costByAgent: Record<string, number>;
  costByModel: Record<string, number>;
  taskCosts: TaskCost[];
}

export const CostBreakdownPanel: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<ApiCostResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCostData();
  }, []);

  const fetchCostData = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/costs');
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch cost data');
      console.error('Cost data fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Format currency helper
  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount);
  };

  // Aggregate data for charts
  const aggregateByAgent = () => {
    if (!data?.costByAgent) return [];
    
    return Object.entries(data.costByAgent).map(([agent, cost]) => ({
      name: agent,
      cost,
    }));
  };

  const aggregateByModel = () => {
    if (!data?.costByModel) return [];
    
    return Object.entries(data.costByModel).map(([model, cost]) => ({
      name: model,
      cost,
    }));
  };

  // Empty state component (reusing F2 pattern)
  const EmptyState = () => (
    <div className="flex flex-col items-center justify-center h-64 text-gray-500">
      <svg
        className="w-16 h-16 mb-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
      <p className="text-lg font-medium">{t('dashboard.costs.empty.title')}</p>
      <p className="text-sm mt-2">{t('dashboard.costs.empty.description')}</p>
    </div>
  );

  // Error state
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h3 className="text-red-800 font-semibold mb-2">
          {t('dashboard.costs.error.title')}
        </h3>
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchCostData}
          className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-64 bg-gray-200 rounded"></div>
        <div className="grid grid-cols-2 gap-4">
          <div className="h-48 bg-gray-200 rounded"></div>
          <div className="h-48 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  // Empty data state
  if (!data || (data.spendOverTime?.length === 0 && data.taskCosts?.length === 0)) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-6">
      {/* Spend Over Time */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">
          {t('dashboard.costs.spendOverTime')}
        </h3>
        {data.spendOverTime && data.spendOverTime.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data.spendOverTime}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="timestamp" />
              <YAxis tickFormatter={formatCurrency} />
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Legend />
              <Area
                type="monotone"
                dataKey="amount"
                stroke="#3b82f6"
                fill="#93c5fd"
                name={t('dashboard.costs.amount')}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-gray-500 text-sm">{t('dashboard.costs.noData')}</p>
        )}
      </div>

      {/* Cost by Agent/Model */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Cost by Agent */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">
            {t('dashboard.costs.byAgent')}
          </h3>
          {aggregateByAgent().length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={aggregateByAgent()}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis tickFormatter={formatCurrency} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Bar dataKey="cost" fill="#8b5cf6" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-500 text-sm">{t('dashboard.costs.noData')}</p>
          )}
        </div>

        {/* Cost by Model */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">
            {t('dashboard.costs.byModel')}
          </h3>
          {aggregateByModel().length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={aggregateByModel()}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis tickFormatter={formatCurrency} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Bar dataKey="cost" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-500 text-sm">{t('dashboard.costs.noData')}</p>
          )}
        </div>
      </div>

      {/* Per-Task Cost Table */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">
          {t('dashboard.costs.perTask')}
        </h3>
        {data.taskCosts && data.taskCosts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('dashboard.costs.table.task')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('dashboard.costs.table.agent')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('dashboard.costs.table.model')}
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('dashboard.costs.table.cost')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t('dashboard.costs.table.timestamp')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.taskCosts.map((task) => (
                  <tr key={task.taskId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {task.description || task.taskId}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {task.agent}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {task.model}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right font-mono">
                      {formatCurrency(task.cost)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(task.timestamp).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">{t('dashboard.costs.noTasks')}</p>
        )}
      </div>
    </div>
  );
};
