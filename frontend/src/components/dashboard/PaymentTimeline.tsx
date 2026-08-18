import React from 'react';
import { Coins, Lock, Unlock, ExternalLink } from 'lucide-react';
import type { PaymentEvent } from '../../types/api';

interface PaymentTimelineProps {
  payments: PaymentEvent[];
}

export const PaymentTimeline: React.FC<PaymentTimelineProps> = ({ payments }) => {
  // Sort payments by timestamp, latest first or oldest first? Generally oldest first (chronological order)
  // is nicer for timelines, but we can do chronological order:
  const sortedPayments = [...payments].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return (
    <div className="glass-panel h-full flex flex-col">
      <div className="flex items-center gap-2 pb-4 border-b border-[var(--panel-border)] mb-4">
        <Coins className="text-amber-400" size={18} />
        <h3 className="text-md font-semibold text-[var(--text-primary)]">Stellar Escrow Payment Timeline</h3>
      </div>

      {sortedPayments.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 py-8 text-slate-500">
          <Coins size={36} className="opacity-20 mb-2" />
          <p className="text-sm">No payment events recorded yet.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto pr-1">
          <div className="relative border-l border-slate-700/60 ml-3 pl-6 space-y-6 py-2">
            {sortedPayments.map((payment, index) => {
              const isReleased = !!payment.txHash && payment.txHash !== '';
              const statusLabel = isReleased ? 'Released' : 'Locked';
              const dateStr = new Date(payment.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <div key={index} className="relative group">
                  {/* Timeline bullet */}
                  <span className={`absolute -left-[31px] top-1 flex items-center justify-center w-5 h-5 rounded-full ring-4 ring-slate-900 ${
                    isReleased 
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50' 
                      : 'bg-amber-500/20 text-amber-400 border border-amber-500/50'
                  }`}>
                    {isReleased ? <Unlock size={10} /> : <Lock size={10} />}
                  </span>

                  {/* Payment Card */}
                  <div className="p-3 bg-slate-800/40 rounded-xl border border-slate-700/40 hover:border-slate-600/60 transition duration-200">
                    <div className="flex justify-between items-start gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-200 capitalize">
                            {payment.counterparty} Agent
                          </span>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                            isReleased 
                              ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40' 
                              : 'bg-amber-950/60 text-amber-400 border border-amber-800/40'
                          }`}>
                            {statusLabel}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">{payment.memo}</p>
                      </div>
                      
                      <div className="text-right">
                        <div className="text-sm font-bold text-amber-300">
                          {payment.amount} XLM
                        </div>
                        <span className="text-[10px] text-slate-500">{dateStr}</span>
                      </div>
                    </div>

                    {isReleased && payment.txHash && (
                      <div className="mt-2.5 pt-2 border-t border-slate-700/30 flex items-center justify-between">
                        <div className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]" title={payment.txHash}>
                          Tx: {payment.txHash}
                        </div>
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${payment.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 hover:underline font-semibold"
                        >
                          <span>Stellar Expert</span>
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
